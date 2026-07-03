/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import type { ToolMount } from '@watt/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools/tool-registry.ts';

/**
 * ToolRegistry（Proto §5.2）单测（真实 DB_PROVIDERS binding，tool_mounts 表）。
 * oracle 硬编码自 Proto §5.2（四动词 List/Get/Write/Update、ToolMount 字段）
 * / §0.2（ListOptions/Page、limit 钳制、非法 filter 键 invalid_argument）
 * / §0.4（Write 幂等 upsert、Update patch not_found）。
 */

async function clearDb() {
  await env.DB_PROVIDERS.prepare('DELETE FROM tool_mounts').run();
}

beforeEach(async () => {
  await clearDb();
});

const M = (over: Partial<ToolMount> = {}): ToolMount => ({
  path: 'observability/logs',
  provider: 'http',
  enabled: true,
  ...over,
});

describe('ToolRegistry.write / get (§5.2 / §0.4)', () => {
  it('write stores mount and get returns it (providerConfig/virtualize JSON roundtrip)', async () => {
    const registry = new ToolRegistry(env.DB_PROVIDERS);
    const mount = M({
      provider: 'mcp',
      providerConfig: { endpoint: 'https://mcp.example.com', secretRef: 'MCP_TOKEN' },
      virtualize: { prefix: 'obs', hide: ['danger'] },
      enabled: false,
    });
    await registry.write(mount);
    expect(await registry.get('observability/logs')).toEqual(mount);
  });

  it('write is idempotent upsert on same path', async () => {
    const registry = new ToolRegistry(env.DB_PROVIDERS);
    await registry.write(M({ provider: 'http' }));
    await registry.write(M({ provider: 'mcp' })); // 同 path 覆盖
    const page = await registry.list();
    if ('code' in page) throw new Error('expected Page');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.provider).toBe('mcp');
  });

  it('get returns not_found for a missing mountPath', async () => {
    const registry = new ToolRegistry(env.DB_PROVIDERS);
    expect(await registry.get('nope')).toMatchObject({ code: 'not_found', retryable: false });
  });

  it('omits providerConfig/virtualize when absent (not stored as null objects)', async () => {
    const registry = new ToolRegistry(env.DB_PROVIDERS);
    await registry.write(M());
    const got = await registry.get('observability/logs');
    if ('code' in got) throw new Error('expected ToolMount');
    expect(got).not.toHaveProperty('providerConfig');
    expect(got).not.toHaveProperty('virtualize');
  });
});

describe('ToolRegistry.list (§5.2 / §0.2)', () => {
  it('returns Page<ToolMount> and clamps a negative limit up to 1 (no full-table LIMIT -1)', async () => {
    const registry = new ToolRegistry(env.DB_PROVIDERS);
    await registry.write(M({ path: 'a' }));
    await registry.write(M({ path: 'b' }));
    const page = await registry.list({ limit: -5 });
    if ('code' in page) throw new Error('expected Page');
    expect(page.items).toHaveLength(1);
  });

  it('clamps an over-large limit down to the 200 max', async () => {
    const registry = new ToolRegistry(env.DB_PROVIDERS);
    await registry.write(M({ path: 'a' }));
    await registry.write(M({ path: 'b' }));
    const page = await registry.list({ limit: 9999 });
    if ('code' in page) throw new Error('expected Page');
    expect(page.items).toHaveLength(2);
  });

  it('rejects an unknown filter key with invalid_argument (§0.2)', async () => {
    const registry = new ToolRegistry(env.DB_PROVIDERS);
    const res = await registry.list({ filter: { bogus: 'x' } });
    expect(res).toMatchObject({ code: 'invalid_argument', retryable: false });
  });
});

describe('ToolRegistry.update (§5.2 / §0.4)', () => {
  it('patches existing and returns the merged mount', async () => {
    const registry = new ToolRegistry(env.DB_PROVIDERS);
    await registry.write(M());
    const updated = await registry.update('observability/logs', {
      enabled: false,
      provider: 'builtin',
    });
    expect(updated).toMatchObject({
      path: 'observability/logs',
      enabled: false,
      provider: 'builtin',
    });
  });

  it('returns not_found for a missing mountPath', async () => {
    const registry = new ToolRegistry(env.DB_PROVIDERS);
    const res = await registry.update('nope', { enabled: false });
    expect(res).toMatchObject({ code: 'not_found', retryable: false });
  });

  it('rejects an unknown patch key with invalid_argument (strict)', async () => {
    const registry = new ToolRegistry(env.DB_PROVIDERS);
    await registry.write(M());
    const res = await registry.update('observability/logs', { bogus: 'x' } as never);
    expect(res).toMatchObject({ code: 'invalid_argument', retryable: false });
  });

  it('rejects patching the immutable path (strict, path omitted from patch schema)', async () => {
    const registry = new ToolRegistry(env.DB_PROVIDERS);
    await registry.write(M());
    const res = await registry.update('observability/logs', { path: 'other' } as never);
    expect(res).toMatchObject({ code: 'invalid_argument', retryable: false });
  });

  it('update can set providerConfig/virtualize and roundtrips through the DB', async () => {
    const registry = new ToolRegistry(env.DB_PROVIDERS);
    await registry.write(M());
    const updated = await registry.update('observability/logs', {
      providerConfig: { endpoint: 'https://x' },
      virtualize: { prefix: 'p' },
    });
    if ('code' in updated) throw new Error('expected ToolMount');
    const reread = await registry.get('observability/logs');
    if ('code' in reread) throw new Error('expected ToolMount');
    expect(reread.providerConfig).toEqual({ endpoint: 'https://x' });
    expect(reread.virtualize).toEqual({ prefix: 'p' });
  });
});
