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

  it('clamps limit to the 200 max (§0.2)', async () => {
    const store = new EventStore(env.DB_EVENTS);
    await store.put(E({ id: 'a' }));
    await store.put(E({ id: 'b' }));
    const page = await store.list({ limit: 9999 });
    if ('code' in page) throw new Error('expected Page');
    expect(page.items).toHaveLength(2);
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
