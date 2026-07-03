/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import type { ChannelConfig } from '@watt/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChannelStore } from '../src/event/channel-store.ts';

/**
 * ChannelStore（ChannelRegistry §2.2）单测（真实 DB_EVENTS binding）。
 * oracle 硬编码自 Proto §2.2（四动词 List/Get/Write/Update、ChannelConfig 字段）
 * / §0.2（ListOptions/Page、limit 钳制、非法 filter 键 invalid_argument）
 * / §0.4（Write 幂等 upsert、Update patch not_found）。
 */

async function clearDb() {
  await env.DB_EVENTS.prepare('DELETE FROM channels').run();
}

beforeEach(async () => {
  await clearDb();
});

const C = (over: Partial<ChannelConfig> = {}): ChannelConfig => ({
  id: 'feishu-main',
  adapter: 'feishu',
  enabled: true,
  settings: { appId: 'cli_x' },
  ...over,
});

describe('ChannelStore.write / get (§2.2 / §0.4)', () => {
  it('write stores config and get returns it (settings JSON + boolean roundtrip)', async () => {
    const store = new ChannelStore(env.DB_EVENTS);
    const cfg = C({ defaultAgent: 'triage', enabled: false, settings: { a: 1, b: 'x' } });
    await store.write(cfg);
    expect(await store.get('feishu-main')).toEqual(cfg);
  });

  it('write is idempotent upsert on same id', async () => {
    const store = new ChannelStore(env.DB_EVENTS);
    await store.write(C({ adapter: 'a1' }));
    await store.write(C({ adapter: 'a2' })); // 同 id 覆盖
    const page = await store.list();
    if ('code' in page) throw new Error('expected Page');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.adapter).toBe('a2');
  });

  it('get returns not_found for missing channelId', async () => {
    const store = new ChannelStore(env.DB_EVENTS);
    expect(await store.get('nope')).toMatchObject({ code: 'not_found', retryable: false });
  });

  it('omits defaultAgent when absent (not stored as null)', async () => {
    const store = new ChannelStore(env.DB_EVENTS);
    await store.write(C());
    const got = await store.get('feishu-main');
    if ('code' in got) throw new Error('expected ChannelConfig');
    expect(got).not.toHaveProperty('defaultAgent');
  });
});

describe('ChannelStore.list (§2.2 / §0.2)', () => {
  it('returns Page<ChannelConfig> and clamps a negative limit up to 1 (no full-table LIMIT -1)', async () => {
    const store = new ChannelStore(env.DB_EVENTS);
    await store.write(C({ id: 'a' }));
    await store.write(C({ id: 'b' }));
    // 负 limit 若直通 SQLite → LIMIT -1 拉全表 2 条；下界钳到 1 → 只 1 条（判别力强）。
    const page = await store.list({ limit: -5 });
    if ('code' in page) throw new Error('expected Page');
    expect(page.items).toHaveLength(1);
  });

  it('clamps an over-large limit down to the 200 max', async () => {
    const store = new ChannelStore(env.DB_EVENTS);
    await store.write(C({ id: 'a' }));
    await store.write(C({ id: 'b' }));
    const page = await store.list({ limit: 9999 });
    if ('code' in page) throw new Error('expected Page');
    expect(page.items).toHaveLength(2);
  });

  it('rejects an unknown filter key with invalid_argument (§0.2)', async () => {
    const store = new ChannelStore(env.DB_EVENTS);
    const res = await store.list({ filter: { bogus: 'x' } });
    expect(res).toMatchObject({ code: 'invalid_argument', retryable: false });
  });
});

describe('ChannelStore.update (§2.2 / §0.4)', () => {
  it('patches existing and returns the merged config', async () => {
    const store = new ChannelStore(env.DB_EVENTS);
    await store.write(C());
    const updated = await store.update('feishu-main', { enabled: false, defaultAgent: 'triage' });
    expect(updated).toMatchObject({ id: 'feishu-main', enabled: false, defaultAgent: 'triage' });
  });

  it('returns not_found for a missing channelId', async () => {
    const store = new ChannelStore(env.DB_EVENTS);
    const res = await store.update('nope', { enabled: false });
    expect(res).toMatchObject({ code: 'not_found', retryable: false });
  });

  it('rejects an unknown patch key with invalid_argument (strict)', async () => {
    const store = new ChannelStore(env.DB_EVENTS);
    await store.write(C());
    const res = await store.update('feishu-main', { bogus: 'x' } as never);
    expect(res).toMatchObject({ code: 'invalid_argument', retryable: false });
  });

  it('rejects patching the immutable id (strict, id omitted from patch schema)', async () => {
    const store = new ChannelStore(env.DB_EVENTS);
    await store.write(C());
    const res = await store.update('feishu-main', { id: 'other' } as never);
    expect(res).toMatchObject({ code: 'invalid_argument', retryable: false });
  });
});
