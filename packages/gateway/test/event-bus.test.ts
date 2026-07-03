/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import type { AccessDecision, Event, EventInput, TokenClaims } from '@watt/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Authorizer } from '../src/authz/authorizer.ts';
import { type EventQueueSender, publish } from '../src/event/event-bus.ts';
import { EventStore } from '../src/event/event-store.ts';

/**
 * EventBus.publish 单测（真实 DB_EVENTS + 注入 Authorizer/queue）。
 * oracle 硬编码自 Proto §2.3（出站鉴权 event://<channel>/<target> write、dedupeKey 窗内幂等
 * 返回原 eventId 且不再投递）/ §1（128KB 尺寸上限）。
 */

async function clearDb() {
  await env.DB_EVENTS.prepare('DELETE FROM events').run();
}

beforeEach(async () => {
  await clearDb();
});

/** queue 计数器：记录 send 次数与最后一次 payload。 */
function countingQueue(): EventQueueSender & { count: number; last?: Event } {
  return {
    count: 0,
    async send(event: Event) {
      this.count += 1;
      this.last = event;
    },
  };
}

/** 恒抛错的 queue：模拟 queue.send 失败（触发 publish 的补偿删除路径）。 */
function throwingQueue(): EventQueueSender {
  return {
    async send() {
      throw new Error('queue unavailable');
    },
  };
}

/** 恒 allow / 恒 deny 的 Authorizer 桩（只实现 publish 用到的 check）。 */
const allowAuthorizer = {
  async check(): Promise<AccessDecision> {
    return { allow: true };
  },
} as unknown as Authorizer;
const denyAuthorizer = {
  async check(): Promise<AccessDecision> {
    return { allow: false, reason: 'no grant' };
  },
} as unknown as Authorizer;

const claims: TokenClaims = { sub: 'user:alice', roles: ['admin'] };

function deps(over: Partial<Parameters<typeof publish>[1]> = {}) {
  return {
    store: new EventStore(env.DB_EVENTS),
    authorizer: allowAuthorizer,
    queue: countingQueue(),
    claims,
    genId: () => 'evt-generated',
    now: () => '2026-07-03T00:00:00.000Z',
    genTraceId: () => 'trace-generated',
    ...over,
  } as Parameters<typeof publish>[1];
}

const inboundInput = (over: Partial<EventInput> = {}): EventInput => ({
  source: { kind: 'webhook', channel: 'feishu' },
  type: 'webhook.received',
  session: 's1',
  payload: { hello: 'world' },
  ...over,
});

describe('EventBus.publish core flow (§2.3)', () => {
  it('normalizes, stores, enqueues and returns the generated eventId', async () => {
    const d = deps();
    const res = await publish(inboundInput(), d);
    expect(res).toEqual({ eventId: 'evt-generated' });
    // 留痕：EventStore 可查到规约后的完整信封。
    const got = await d.store.get('evt-generated');
    if ('code' in got) throw new Error('expected stored event');
    expect(got.id).toBe('evt-generated');
    expect(got.traceId).toBe('trace-generated');
    expect(got.occurredAt).toBe('2026-07-03T00:00:00.000Z');
    // 投递：Queue 收到一次。
    expect((d.queue as ReturnType<typeof countingQueue>).count).toBe(1);
  });

  it('rejects an oversized event with invalid_argument (§1 128KB)', async () => {
    const big = 'x'.repeat(129 * 1024);
    const res = await publish(inboundInput({ payload: { big } }), deps());
    expect(res).toMatchObject({ code: 'invalid_argument', retryable: false });
  });
});

describe('EventBus.publish dedupe idempotency (§2.3)', () => {
  it('second publish with the same dedupeKey returns the original eventId and enqueues only once', async () => {
    const queue = countingQueue();
    const store = new EventStore(env.DB_EVENTS);
    let idSeq = 0;
    const nowMs = () => Date.parse('2026-07-03T00:00:00.000Z');
    const first = await publish(
      inboundInput({ dedupeKey: 'k1' }),
      deps({ store, queue, genId: () => `evt-${idSeq++}`, nowMs }),
    );
    const second = await publish(
      inboundInput({ dedupeKey: 'k1' }),
      deps({ store, queue, genId: () => `evt-${idSeq++}`, nowMs }),
    );
    expect(first).toEqual({ eventId: 'evt-0' });
    // 幂等：返回原 eventId（不是第二次生成的 evt-1）。
    expect(second).toEqual({ eventId: 'evt-0' });
    // 只投递一次（第二次命中窗内幂等，短路不投）。
    expect(queue.count).toBe(1);
  });
});

describe('EventBus.publish queue.send failure compensation (§2.3)', () => {
  it('returns unavailable(retryable), removes the trace, and lets a same-key retry re-enqueue', async () => {
    const store = new EventStore(env.DB_EVENTS);
    // 第一次：queue.send 抛错 → 返回 unavailable + retryable、补偿删留痕。
    const res = await publish(
      inboundInput({ dedupeKey: 'k-retry' }),
      deps({ store, queue: throwingQueue(), genId: () => 'evt-lost' }),
    );
    expect(res).toMatchObject({ code: 'unavailable', retryable: true });
    // 补偿删除生效：store 不再有该事件（重投不会命中 dedupe）。
    const got = await store.get('evt-lost');
    expect(got).toMatchObject({ code: 'not_found' });

    // 第二次：同 dedupeKey 重发，queue 正常 → 成功入队（未被残留 dedupe 短路）。
    const okQueue = countingQueue();
    const retry = await publish(
      inboundInput({ dedupeKey: 'k-retry' }),
      deps({ store, queue: okQueue, genId: () => 'evt-ok' }),
    );
    expect(retry).toEqual({ eventId: 'evt-ok' });
    expect(okQueue.count).toBe(1);
  });
});

describe('EventBus.publish identity resolution wiring (§1 L115-116)', () => {
  it('resolves principal from channelUser before publish when principal is absent', async () => {
    const d = deps({
      resolvePrincipal: async (channel, userId) => {
        expect(channel).toBe('feishu');
        expect(userId).toBe('ou_x');
        return 'user:alice';
      },
    });
    const res = await publish(
      inboundInput({ channelUser: { channel: 'feishu', userId: 'ou_x' } }),
      d,
    );
    if ('code' in res) throw new Error('expected success');
    const got = await d.store.get(res.eventId);
    if ('code' in got) throw new Error('expected stored event');
    expect(got.principal).toBe('user:alice');
  });

  it('falls back to user:anonymous when the resolver reports no mapping', async () => {
    const d = deps({ resolvePrincipal: async () => 'user:anonymous' });
    const res = await publish(
      inboundInput({ channelUser: { channel: 'feishu', userId: 'unmapped' } }),
      d,
    );
    if ('code' in res) throw new Error('expected success');
    const got = await d.store.get(res.eventId);
    if ('code' in got) throw new Error('expected stored event');
    expect(got.principal).toBe('user:anonymous');
  });

  it('does not call the resolver when principal is already provided', async () => {
    let called = false;
    const d = deps({
      resolvePrincipal: async () => {
        called = true;
        return 'user:should-not-be-used';
      },
    });
    const res = await publish(
      inboundInput({
        principal: 'user:preset',
        channelUser: { channel: 'feishu', userId: 'ou_x' },
      }),
      d,
    );
    if ('code' in res) throw new Error('expected success');
    const got = await d.store.get(res.eventId);
    if ('code' in got) throw new Error('expected stored event');
    expect(got.principal).toBe('user:preset');
    expect(called).toBe(false);
  });
});

describe('EventBus.publish outbound authorization (§2.3)', () => {
  it('denies outbound.message when the authorizer denies event:// write', async () => {
    const res = await publish(
      {
        source: { kind: 'agent' },
        type: 'outbound.message',
        payload: { channel: 'feishu', target: 'u123', content: { text: 'hi' } },
      },
      deps({ authorizer: denyAuthorizer }),
    );
    expect(res).toMatchObject({ code: 'permission_denied', retryable: false });
  });

  it('allows outbound.message when the authorizer allows and enqueues it', async () => {
    const d = deps({ authorizer: allowAuthorizer });
    const res = await publish(
      {
        source: { kind: 'agent' },
        type: 'outbound.message',
        payload: { channel: 'feishu', target: 'u123', content: { text: 'hi' } },
      },
      d,
    );
    expect(res).toEqual({ eventId: 'evt-generated' });
    expect((d.queue as ReturnType<typeof countingQueue>).count).toBe(1);
  });

  it('rejects a malformed outbound.message payload with invalid_argument', async () => {
    const res = await publish(
      { source: { kind: 'agent' }, type: 'outbound.message', payload: { channel: 'feishu' } },
      deps(),
    );
    expect(res).toMatchObject({ code: 'invalid_argument', retryable: false });
  });
});
