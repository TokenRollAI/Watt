/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import type { Event, Subscription } from '@watt/core';
import { describe, expect, it } from 'vitest';
import { type ConsumerDeps, handleQueue, type WebhookDeliverer } from '../src/event/consumer.ts';
import type { EventRouter } from '../src/event/event-router.ts';

// DurableObjectStub 用 ambient global（与 env.EVENT_ROUTER.get 返回同源）。

/**
 * Queue consumer 单测（真实 EVENT_ROUTER DO stub + 注入 webhook deliverer）。
 * batch 用 createMessageBatch 构造，ack/retry 经 getQueueResult 断言。
 * oracle 硬编码自 Proto §2.3（订阅匹配后分发：webhook 投递、agent/task 占位）。
 */

const QUEUE = 'watt-events';

let counter = 0;
function freshRouterStub(): DurableObjectStub<EventRouter> {
  const id = env.EVENT_ROUTER.idFromName(`consumer-test-${counter++}`);
  return env.EVENT_ROUTER.get(id);
}

/** 内存 webhook deliverer：记录投递；可配置为对某 URL 抛错模拟失败。 */
function memDeliverer(
  failUrls: Set<string> = new Set(),
): WebhookDeliverer & { delivered: Array<{ url: string; event: Event }> } {
  return {
    delivered: [],
    async deliver(url: string, event: Event) {
      if (failUrls.has(url)) throw new Error('sink down');
      this.delivered.push({ url, event });
    },
  };
}

const E = (over: Partial<Event> = {}): Event => ({
  id: 'e1',
  source: { kind: 'webhook', channel: 'feishu' },
  type: 'webhook.received',
  session: 's1',
  payload: { hello: 'world' },
  occurredAt: '2026-07-03T00:00:00.000Z',
  traceId: 't1',
  ...over,
});

async function seedSub(stub: DurableObjectStub<EventRouter>, sub: Subscription): Promise<void> {
  await stub.subscribe(sub);
}

describe('Queue consumer webhook sink (§2.3)', () => {
  it('delivers a matching event to the webhook sink and acks the message', async () => {
    const stub = freshRouterStub();
    await seedSub(stub, {
      match: { type: 'webhook.*' },
      sink: { kind: 'webhook', url: 'https://sink.test/a' },
    });
    const deliverer = memDeliverer();
    const deps: ConsumerDeps = { deliverer, router: () => stub };

    const batch = createMessageBatch(QUEUE, [
      { id: 'm1', timestamp: new Date(), body: E(), attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);

    expect(deliverer.delivered).toHaveLength(1);
    expect(deliverer.delivered[0]?.url).toBe('https://sink.test/a');
    expect(result.explicitAcks).toContain('m1');
  });

  it('retries the message when the webhook sink delivery fails', async () => {
    const stub = freshRouterStub();
    await seedSub(stub, { match: {}, sink: { kind: 'webhook', url: 'https://sink.test/down' } });
    const deliverer = memDeliverer(new Set(['https://sink.test/down']));
    const deps: ConsumerDeps = { deliverer, router: () => stub };

    const batch = createMessageBatch(QUEUE, [
      { id: 'm2', timestamp: new Date(), body: E(), attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);

    expect(result.retryMessages.map((r: { msgId: string }) => r.msgId)).toContain('m2');
    expect(result.explicitAcks).not.toContain('m2');
  });

  it('acks when no subscription matches (nothing to deliver)', async () => {
    const stub = freshRouterStub();
    await seedSub(stub, {
      match: { type: 'im.*' },
      sink: { kind: 'webhook', url: 'https://sink.test/a' },
    });
    const deliverer = memDeliverer();
    const deps: ConsumerDeps = { deliverer, router: () => stub };

    const batch = createMessageBatch(QUEUE, [
      { id: 'm3', timestamp: new Date(), body: E({ type: 'webhook.received' }), attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);

    expect(deliverer.delivered).toHaveLength(0);
    expect(result.explicitAcks).toContain('m3');
  });
});

describe('Queue consumer agent / task sink placeholders (§2.3, delivery deferred)', () => {
  it('acks an agent sink event (Session Mapper recorded, delivery deferred to Phase 4)', async () => {
    const stub = freshRouterStub();
    await seedSub(stub, {
      match: { type: 'webhook.*' },
      sink: { kind: 'agent', definition: 'triage', instanceBy: 'session' },
    });
    const deliverer = memDeliverer();
    const deps: ConsumerDeps = { deliverer, router: () => stub };

    const batch = createMessageBatch(QUEUE, [
      { id: 'm4', timestamp: new Date(), body: E({ session: 'chat-1' }), attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);

    // agent sink 占位不抛错、不阻塞 → 消息 ack；webhook deliverer 未被触碰。
    expect(deliverer.delivered).toHaveLength(0);
    expect(result.explicitAcks).toContain('m4');
  });

  it('acks a task sink event (delivery deferred to Phase 5)', async () => {
    const stub = freshRouterStub();
    await seedSub(stub, { match: {}, sink: { kind: 'task', workflow: 'wf-1' } });
    const deliverer = memDeliverer();
    const deps: ConsumerDeps = { deliverer, router: () => stub };

    const batch = createMessageBatch(QUEUE, [
      { id: 'm5', timestamp: new Date(), body: E(), attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toContain('m5');
  });
});

describe('Queue consumer malformed message (defensive)', () => {
  it('drops (acks) a message whose body is not a valid Event', async () => {
    const stub = freshRouterStub();
    const deliverer = memDeliverer();
    const deps: ConsumerDeps = { deliverer, router: () => stub };

    const batch = createMessageBatch(QUEUE, [
      { id: 'm6', timestamp: new Date(), body: { not: 'an-event' }, attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toContain('m6');
  });
});
