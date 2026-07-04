/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import type { Event } from '@watt/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../src/event/event-store.ts';

/**
 * EventStore 单测（真实 DB_EVENTS binding，vitest-pool-workers）。
 * oracle 硬编码自 Proto §2.4（List filter=type/channel/session/时间范围 + Get）
 * / §0.2（ListOptions/Page、limit 默认 50 钳 200、非法 filter 键 invalid_argument）
 * / §2.3（dedupeKey 窗内幂等）。
 */

async function clearDb() {
  await env.DB_EVENTS.prepare('DELETE FROM events').run();
}

beforeEach(async () => {
  await clearDb();
});

const E = (over: Partial<Event> & { channel?: string } = {}): Event => {
  const { channel, ...rest } = over;
  return {
    id: 'e1',
    source: { kind: 'webhook', channel: channel ?? 'feishu' },
    type: 'webhook.received',
    session: 's1',
    dedupeKey: undefined,
    payload: { hello: 'world' },
    occurredAt: '2026-07-03T00:00:00.000Z',
    traceId: 't1',
    ...rest,
  };
};

describe('EventStore.put / get (§2.4)', () => {
  it('put stores the full envelope and get returns it', async () => {
    const store = new EventStore(env.DB_EVENTS);
    const ev = E({ principal: 'user:alice', raw: { bytes: 'x' } });
    await store.put(ev);
    const got = await store.get('e1');
    expect(got).toEqual(ev);
  });

  it('get returns not_found for missing eventId', async () => {
    const store = new EventStore(env.DB_EVENTS);
    const res = await store.get('nope');
    expect(res).toMatchObject({ code: 'not_found', retryable: false });
  });

  it('put is idempotent upsert on same id', async () => {
    const store = new EventStore(env.DB_EVENTS);
    await store.put(E({ type: 'a.x' }));
    await store.put(E({ type: 'b.y' })); // 同 id 覆盖
    const page = await store.list();
    if ('code' in page) throw new Error('expected Page');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.type).toBe('b.y');
  });

  it('delete removes a stored event; get then returns not_found', async () => {
    const store = new EventStore(env.DB_EVENTS);
    await store.put(E({ id: 'e1' }));
    await store.delete('e1');
    const got = await store.get('e1');
    expect(got).toMatchObject({ code: 'not_found' });
  });

  it('delete is a no-op for a missing id (idempotent)', async () => {
    const store = new EventStore(env.DB_EVENTS);
    await expect(store.delete('nope')).resolves.toBeUndefined();
  });
});

describe('EventStore.list (§2.4 / §0.2)', () => {
  it('filters by type / channel / session and returns Page<Event>', async () => {
    const store = new EventStore(env.DB_EVENTS);
    await store.put(E({ id: 'a', type: 'im.message', channel: 'feishu', session: 's1' }));
    await store.put(E({ id: 'b', type: 'webhook.received', channel: 'gh', session: 's2' }));

    const byType = await store.list({ filter: { type: 'im.message' } });
    if ('code' in byType) throw new Error('expected Page');
    expect(byType.items.map((e) => e.id)).toEqual(['a']);

    const byChannel = await store.list({ filter: { channel: 'gh' } });
    if ('code' in byChannel) throw new Error('expected Page');
    expect(byChannel.items.map((e) => e.id)).toEqual(['b']);

    const bySession = await store.list({ filter: { session: 's1' } });
    if ('code' in bySession) throw new Error('expected Page');
    expect(bySession.items.map((e) => e.id)).toEqual(['a']);
  });

  it('filters by since / until time range (inclusive since, exclusive until)', async () => {
    const store = new EventStore(env.DB_EVENTS);
    await store.put(E({ id: 'a', occurredAt: '2026-07-01T00:00:00.000Z' }));
    await store.put(E({ id: 'b', occurredAt: '2026-07-02T00:00:00.000Z' }));
    await store.put(E({ id: 'c', occurredAt: '2026-07-03T00:00:00.000Z' }));

    const ranged = await store.list({
      filter: { since: '2026-07-02T00:00:00.000Z', until: '2026-07-03T00:00:00.000Z' },
    });
    if ('code' in ranged) throw new Error('expected Page');
    expect(ranged.items.map((e) => e.id)).toEqual(['b']);
  });

  it('returns items ordered by occurred_at descending', async () => {
    const store = new EventStore(env.DB_EVENTS);
    await store.put(E({ id: 'a', occurredAt: '2026-07-01T00:00:00.000Z' }));
    await store.put(E({ id: 'c', occurredAt: '2026-07-03T00:00:00.000Z' }));
    await store.put(E({ id: 'b', occurredAt: '2026-07-02T00:00:00.000Z' }));
    const page = await store.list();
    if ('code' in page) throw new Error('expected Page');
    expect(page.items.map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });

  it('clamps a non-positive limit up to 1 (guards against SQLite LIMIT -1 full scan) (§0.2)', async () => {
    const store = new EventStore(env.DB_EVENTS);
    await store.put(E({ id: 'a', occurredAt: '2026-07-01T00:00:00.000Z' }));
    await store.put(E({ id: 'b', occurredAt: '2026-07-02T00:00:00.000Z' }));
    await store.put(E({ id: 'c', occurredAt: '2026-07-03T00:00:00.000Z' }));
    // limit:-5 若直通 SQLite（-1 语义 = 无限）会拉全表 3 条；钳到下界 1 → 只回最新 1 条。
    const page = await store.list({ limit: -5 });
    if ('code' in page) throw new Error('expected Page');
    expect(page.items.map((e) => e.id)).toEqual(['c']);
  });

  it('clamps an over-large limit down to the 200 max (§0.2)', async () => {
    const store = new EventStore(env.DB_EVENTS);
    // 插 201 条 → limit 9999 请求，钳到 200 → 恰回 200 条（有判别力）。
    for (let i = 0; i < 201; i++) {
      const n = String(i).padStart(3, '0');
      await store.put(E({ id: `e${n}`, occurredAt: `2026-07-03T00:00:00.${n}Z` }));
    }
    const page = await store.list({ limit: 9999 });
    if ('code' in page) throw new Error('expected Page');
    expect(page.items).toHaveLength(200);
  });

  it('filters by correlationId via payload.correlationId (§2.4 增补)', async () => {
    const store = new EventStore(env.DB_EVENTS);
    await store.put(
      E({
        id: 'r1',
        type: 'agent.result',
        session: undefined,
        payload: { correlationId: 'corr-1', instanceId: 'i1', output: { text: 'hi' } },
      }),
    );
    await store.put(
      E({
        id: 'r2',
        type: 'agent.failed',
        session: undefined,
        payload: { correlationId: 'corr-2', instanceId: 'i1', reason: 'timeout' },
      }),
    );
    await store.put(E({ id: 'x', type: 'im.message' }));

    const byCorr = await store.list({ filter: { correlationId: 'corr-1' } });
    if ('code' in byCorr) throw new Error('expected Page');
    expect(byCorr.items.map((e) => e.id)).toEqual(['r1']);

    // 与 type 组合收窄（推荐用法：轮询一次对话的 result/failed）。
    const corrAndType = await store.list({
      filter: { correlationId: 'corr-2', type: 'agent.failed' },
    });
    if ('code' in corrAndType) throw new Error('expected Page');
    expect(corrAndType.items.map((e) => e.id)).toEqual(['r2']);
  });

  it('rejects an unknown filter key with invalid_argument (§0.2)', async () => {
    const store = new EventStore(env.DB_EVENTS);
    const res = await store.list({ filter: { bogus: 'x' } });
    expect(res).toMatchObject({ code: 'invalid_argument', retryable: false });
  });
});

describe('EventStore.findByDedupeKey (§2.3 幂等)', () => {
  it('returns the stored eventId when a prior event is within the window', async () => {
    const store = new EventStore(env.DB_EVENTS);
    const now = Date.parse('2026-07-03T00:00:00.000Z');
    await store.put(E({ id: 'orig', dedupeKey: 'k1', occurredAt: '2026-07-03T00:00:00.000Z' }));
    // 1 小时后重发 → 24h 窗内命中
    const hit = await store.findByDedupeKey('k1', now + 60 * 60 * 1000);
    expect(hit).toBe('orig');
  });

  it('returns null when the prior event is outside the window', async () => {
    const store = new EventStore(env.DB_EVENTS);
    const stored = Date.parse('2026-07-01T00:00:00.000Z');
    await store.put(E({ id: 'orig', dedupeKey: 'k1', occurredAt: '2026-07-01T00:00:00.000Z' }));
    // 48 小时后 → 超 24h 默认窗
    const miss = await store.findByDedupeKey('k1', stored + 48 * 60 * 60 * 1000);
    expect(miss).toBeNull();
  });

  it('returns null when no event carries the dedupe key', async () => {
    const store = new EventStore(env.DB_EVENTS);
    await store.put(E({ id: 'orig', dedupeKey: 'other' }));
    expect(await store.findByDedupeKey('k1', Date.now())).toBeNull();
  });

  it('honors a custom window override', async () => {
    const store = new EventStore(env.DB_EVENTS);
    const stored = Date.parse('2026-07-03T00:00:00.000Z');
    await store.put(E({ id: 'orig', dedupeKey: 'k1', occurredAt: '2026-07-03T00:00:00.000Z' }));
    // 自定义 5 分钟窗；10 分钟后 → 超窗返回 null
    const miss = await store.findByDedupeKey('k1', stored + 10 * 60 * 1000, 5 * 60 * 1000);
    expect(miss).toBeNull();
  });
});
