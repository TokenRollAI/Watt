/// <reference types="@cloudflare/vitest-pool-workers/types" />
import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
  SELF,
} from 'cloudflare:test';
import { computeSignature, type Event, WATT_HMAC } from '@watt/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetSeedGuardForTests } from '../src/authz/seed.ts';
import { ChannelStore } from '../src/event/channel-store.ts';
import {
  type ConsumerDeps,
  handleQueue,
  noopAgentDeliverer,
  noopSignaler,
  type WebhookDeliverer,
} from '../src/event/consumer.ts';
import type { EventRouter } from '../src/event/event-router.ts';
import { EventStore } from '../src/event/event-store.ts';

/**
 * Phase 2 事件流全链集成测试（DoD 项 2）——vitest-pool-workers 真实 workerd。
 *
 * 链路（DOD.md §2 项 2 原文）：
 *  ① Subscribe 一个 webhook sink（单例 EVENT_ROUTER DO，与生产 consumer 同源）。
 *  ② POST /channels/<id>/inbound（先写 channel 配置 + 注入验签 secret，携带正确 HMAC 签名）
 *     → 断言 200 + eventIds。
 *  ③ EventStore.List 可见规约后 Event（type webhook.received、source.kind webhook）。
 *  ④ createMessageBatch + handleQueue 驱动 consumer → 断言 webhook sink 收到该 Event。
 *  ⑤ 同 dedupeKey 重发 inbound → 返回原 eventId，且 EventStore 只留一条（只投递一次）。
 *
 * 断言协议事实（事件序列、落点、幂等），不断言 LLM 文本（DOD §10）。
 * 同文件共享 isolate（toolchain-pitfalls §23）：beforeEach 清 D1 表 + reset 种子单例；
 * 用固定 channelId，DO 单例订阅在每例内 subscribe 后于用例末 unsubscribe 保持隔离。
 */

const BASE = 'https://gateway.test';
const CHANNEL_ID = 'inbound-hook';
// 验签 secret 经 miniflare bindings 注入（vitest.config.ts），channel 配置以引用名指向它。
const SECRET_REF = 'WEBHOOK_SECRET_TEST';
const SECRET = 'integration-webhook-secret';

/** 单例 router stub（与生产 consumer defaultConsumerDeps 的 idFromName('router') 同源）。 */
function routerStub(): DurableObjectStub<EventRouter> {
  return env.EVENT_ROUTER.get(env.EVENT_ROUTER.idFromName('router'));
}

/** 内存 webhook deliverer：记录投递，供断言 sink 收到规约后的 Event。 */
function memDeliverer(): WebhookDeliverer & { delivered: Array<{ url: string; event: Event }> } {
  return {
    delivered: [],
    async deliver(url: string, event: Event) {
      this.delivered.push({ url, event });
    },
  };
}

/** 组装生产同构的 ConsumerDeps（单例 router + 真实 EventStore/ChannelStore + no-op signaler）。 */
function makeConsumerDeps(deliverer: WebhookDeliverer): ConsumerDeps {
  return {
    deliverer,
    router: () => routerStub(),
    store: new EventStore(env.DB_EVENTS),
    queue: {
      async send() {
        /* 集成链路不驱动内置规则的二次 Publish；no-op。 */
      },
    },
    channels: new ChannelStore(env.DB_EVENTS),
    signaler: noopSignaler,
    agent: noopAgentDeliverer,
    genId: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
    genTraceId: () => crypto.randomUUID(),
  };
}

async function clearDb() {
  await env.DB_EVENTS.prepare('DELETE FROM events').run();
  await env.DB_EVENTS.prepare('DELETE FROM channels').run();
  await env.DB_POLICIES.prepare('DELETE FROM policies').run();
  await env.DB_POLICIES.prepare('DELETE FROM identity_mappings').run();
}

/** 清空单例 router 的订阅（跨用例隔离；DO 单例存活整个 isolate）。 */
async function clearSubscriptions() {
  const stub = routerStub();
  const page = await stub.listSubscriptions();
  for (const sub of page.items) {
    if (sub.id !== undefined) await stub.unsubscribe(sub.id);
  }
}

beforeEach(async () => {
  await clearDb();
  await clearSubscriptions();
  resetSeedGuardForTests();
  // 每例写入待测 channel 配置：webhook adapter、启用、settings 引用注入的 secret。
  const channels = new ChannelStore(env.DB_EVENTS);
  await channels.write({
    id: CHANNEL_ID,
    adapter: 'webhook',
    enabled: true,
    settings: { verifySecretRef: SECRET_REF },
  });
});

/** 构造带正确 HMAC 签名的 inbound POST（可带 delivery id → dedupeKey）。 */
async function postInbound(body: string, deliveryId?: string): Promise<Response> {
  const sig = await computeSignature(SECRET, body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [WATT_HMAC.signatureHeader]: sig,
  };
  if (deliveryId !== undefined) headers[WATT_HMAC.deliveryHeader] = deliveryId;
  return SELF.fetch(`${BASE}/channels/${CHANNEL_ID}/inbound`, { method: 'POST', headers, body });
}

describe('Phase 2 event flow integration (DOD §2 项 2)', () => {
  it('runs the full chain: subscribe → inbound → store → deliver → dedupe idempotency', async () => {
    // ① Subscribe 一个 webhook sink（匹配 webhook.* 类事件）。
    const stub = routerStub();
    const { subscriptionId } = await stub.subscribe({
      match: { type: 'webhook.*' },
      sink: { kind: 'webhook', url: 'https://sink.test/hook' },
    });
    expect(subscriptionId).toBeTruthy();

    // ② POST inbound（正确签名 + delivery id → dedupeKey）→ 200 + eventIds。
    const body = JSON.stringify({ msg: 'hello', n: 1 });
    const res = await postInbound(body, 'delivery-1');
    expect(res.status).toBe(200);
    const out = (await res.json()) as { eventIds: string[] };
    expect(Array.isArray(out.eventIds)).toBe(true);
    expect(out.eventIds).toHaveLength(1);
    const eventId = out.eventIds[0]!;

    // ③ EventStore.List 可见规约后 Event（type webhook.received、source.kind webhook）。
    const store = new EventStore(env.DB_EVENTS);
    const page = await store.list({ filter: { channel: CHANNEL_ID } });
    if ('code' in page) throw new Error(`unexpected WattError: ${page.message}`);
    expect(page.items).toHaveLength(1);
    const stored = page.items[0]!;
    expect(stored.id).toBe(eventId);
    expect(stored.type).toBe('webhook.received');
    expect(stored.source.kind).toBe('webhook');
    expect(stored.source.channel).toBe(CHANNEL_ID);

    // ④ createMessageBatch + handleQueue 驱动 consumer → webhook sink 收到该 Event。
    const deliverer = memDeliverer();
    const deps: ConsumerDeps = makeConsumerDeps(deliverer);
    const batch = createMessageBatch('watt-events', [
      { id: 'm1', timestamp: new Date(), body: stored, attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toContain('m1');
    expect(deliverer.delivered).toHaveLength(1);
    expect(deliverer.delivered[0]?.url).toBe('https://sink.test/hook');
    expect(deliverer.delivered[0]?.event.id).toBe(eventId);

    // ⑤ 同 dedupeKey 重发 → 返回原 eventId，EventStore 仍只留一条（只投递一次）。
    const res2 = await postInbound(body, 'delivery-1');
    expect(res2.status).toBe(200);
    const out2 = (await res2.json()) as { eventIds: string[] };
    expect(out2.eventIds).toEqual([eventId]);

    const page2 = await store.list({ filter: { channel: CHANNEL_ID } });
    if ('code' in page2) throw new Error(`unexpected WattError: ${page2.message}`);
    expect(page2.items).toHaveLength(1);
  });

  it('stops delivering to a sink after unsubscribe (subscribe → deliver → unsubscribe → no delivery)', async () => {
    const stub = routerStub();
    const { subscriptionId } = await stub.subscribe({
      match: { type: 'webhook.*' },
      sink: { kind: 'webhook', url: 'https://sink.test/hook' },
    });

    // 第一次入站 + 驱动 consumer → sink 收到。
    const res = await postInbound(JSON.stringify({ n: 1 }), 'unsub-d1');
    const firstId = ((await res.json()) as { eventIds: string[] }).eventIds[0]!;
    const store = new EventStore(env.DB_EVENTS);
    const firstEvent = await store.list({ filter: { channel: CHANNEL_ID } });
    if ('code' in firstEvent) throw new Error(firstEvent.message);
    const stored1 = firstEvent.items.find((e) => e.id === firstId)!;

    const deliverer = memDeliverer();
    const deps: ConsumerDeps = makeConsumerDeps(deliverer);
    const batch1 = createMessageBatch('watt-events', [
      { id: 'u1', timestamp: new Date(), body: stored1, attempts: 1 },
    ]);
    const ctx1 = createExecutionContext();
    await handleQueue(batch1, deps);
    await getQueueResult(batch1, ctx1);
    expect(deliverer.delivered).toHaveLength(1);

    // unsubscribe 后：新事件驱动 consumer → 无订阅命中 → sink 不再收到。
    await stub.unsubscribe(subscriptionId);
    const res2 = await postInbound(JSON.stringify({ n: 2 }), 'unsub-d2');
    const secondId = ((await res2.json()) as { eventIds: string[] }).eventIds[0]!;
    const secondEvent = await store.list({ filter: { channel: CHANNEL_ID } });
    if ('code' in secondEvent) throw new Error(secondEvent.message);
    const stored2 = secondEvent.items.find((e) => e.id === secondId)!;

    const batch2 = createMessageBatch('watt-events', [
      { id: 'u2', timestamp: new Date(), body: stored2, attempts: 1 },
    ]);
    const ctx2 = createExecutionContext();
    await handleQueue(batch2, deps);
    const result2 = await getQueueResult(batch2, ctx2);
    expect(result2.explicitAcks).toContain('u2'); // 无订阅 → 无投递 → ack
    expect(deliverer.delivered).toHaveLength(1); // 仍是 unsubscribe 前那 1 条，未新增
  });

  it('verifies a non-UTF-8 byte body by exact bytes and passes signature (§2.1 bodyRaw)', async () => {
    // 含非法 UTF-8 序列的字节 body（0xFF/0xFE 无法 UTF-8 解码）；HMAC 按原字节算。
    // inbound 侧读 arrayBuffer → 严格 UTF-8 解码失败 → base64 分支；验签仍基于原字节 → 通过 → 200。
    const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x00, 0x80, 0x7d]);
    const sig = await computeSignature(SECRET, bytes);
    const res = await SELF.fetch(`${BASE}/channels/${CHANNEL_ID}/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        [WATT_HMAC.signatureHeader]: sig,
      },
      body: bytes,
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { eventIds: string[] };
    expect(out.eventIds).toHaveLength(1);
  });

  it('rejects an inbound request with an invalid signature (403 permission_denied)', async () => {
    const res = await SELF.fetch(`${BASE}/channels/${CHANNEL_ID}/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [WATT_HMAC.signatureHeader]: 'sha256=deadbeef',
      },
      body: JSON.stringify({ msg: 'tampered' }),
    });
    expect(res.status).toBe(403);
    const err = (await res.json()) as { code: string; retryable: boolean };
    expect(err.code).toBe('permission_denied');
    expect(err.retryable).toBe(false);
  });

  it('returns 501 unavailable for a channel whose adapter is not implemented (§0.2)', async () => {
    const channels = new ChannelStore(env.DB_EVENTS);
    await channels.write({
      id: 'feishu-hook',
      adapter: 'feishu', // Phase 2 未落地 → 501（在验签之前短路，无需签名）。
      enabled: true,
      settings: { verifySecretRef: SECRET_REF },
    });
    const res = await SELF.fetch(`${BASE}/channels/feishu-hook/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(501);
    const err = (await res.json()) as { code: string; retryable: boolean };
    expect(err.code).toBe('unavailable');
    expect(err.retryable).toBe(false);
  });

  it('returns 404 for an unknown channel', async () => {
    const res = await SELF.fetch(`${BASE}/channels/no-such-channel/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
    const err = (await res.json()) as { code: string };
    expect(err.code).toBe('not_found');
  });

  it('returns 403 for a disabled channel', async () => {
    const channels = new ChannelStore(env.DB_EVENTS);
    await channels.write({
      id: 'disabled-hook',
      adapter: 'webhook',
      enabled: false,
      settings: { verifySecretRef: SECRET_REF },
    });
    const res = await SELF.fetch(`${BASE}/channels/disabled-hook/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    const err = (await res.json()) as { code: string };
    expect(err.code).toBe('permission_denied');
  });
});
