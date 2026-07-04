/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Bindings } from '../src/env.ts';
import { resetSecretCacheForTests, resolveSecret } from '../src/secrets/resolve.ts';
import { SecretStore } from '../src/secrets/secret-store.ts';

/**
 * resolveSecret 回退链单测（Proto §6.6）——env 优先 → KV 解密 → undefined。
 */

const KEY = 'XOL8MO7eCWDeaTn27cjz6KkV2u3o0d1KnpKzVQxUebQ';

async function clearSecrets(): Promise<void> {
  let cursor: string | undefined;
  do {
    const res = await env.KV_TENANTS.list({ prefix: 'secret:', cursor });
    for (const k of res.keys) await env.KV_TENANTS.delete(k.name);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor !== undefined);
}

/** 构造最小 Bindings（KV 真源 + 可选主密钥 + 任意 env 直读字段）。 */
function makeEnv(over: Record<string, unknown>): Bindings {
  return { KV_TENANTS: env.KV_TENANTS, ...over } as unknown as Bindings;
}

beforeEach(async () => {
  await clearSecrets();
  resetSecretCacheForTests();
});

describe('resolveSecret — 优先级三例', () => {
  it('env 覆盖 KV：env 命中优先返回', async () => {
    const store = new SecretStore(env.KV_TENANTS, KEY);
    await store.write('OVERLAP', 'kv-value');
    const e = makeEnv({ WATT_SECRET_ENCRYPTION_KEY: KEY, OVERLAP: 'env-value' });
    expect(await resolveSecret(e, 'OVERLAP')).toBe('env-value');
  });

  it('KV 命中：env 未命中 → 查 KV 解密', async () => {
    const store = new SecretStore(env.KV_TENANTS, KEY);
    await store.write('KV_ONLY', 'kv-value');
    const e = makeEnv({ WATT_SECRET_ENCRYPTION_KEY: KEY });
    expect(await resolveSecret(e, 'KV_ONLY')).toBe('kv-value');
  });

  it('双缺失 → undefined', async () => {
    const e = makeEnv({ WATT_SECRET_ENCRYPTION_KEY: KEY });
    expect(await resolveSecret(e, 'NOWHERE')).toBeUndefined();
  });
});

describe('resolveSecret — 主密钥缺失降级', () => {
  it('主密钥缺失 → 静默跳过 KV 分支（即使 KV 有值）', async () => {
    const store = new SecretStore(env.KV_TENANTS, KEY);
    await store.write('KV_ONLY', 'kv-value');
    const e = makeEnv({}); // 无 WATT_SECRET_ENCRYPTION_KEY
    expect(await resolveSecret(e, 'KV_ONLY')).toBeUndefined();
  });

  it('主密钥缺失但 env 命中 → 仍返回 env 值（env 优先在跳过之前）', async () => {
    const e = makeEnv({ ENVVAR: 'v' });
    expect(await resolveSecret(e, 'ENVVAR')).toBe('v');
  });

  it('空字符串 env 值不算命中（走 KV 分支）', async () => {
    const store = new SecretStore(env.KV_TENANTS, KEY);
    await store.write('EMPTY_ENV', 'kv-value');
    const e = makeEnv({ WATT_SECRET_ENCRYPTION_KEY: KEY, EMPTY_ENV: '' });
    expect(await resolveSecret(e, 'EMPTY_ENV')).toBe('kv-value');
  });
});

describe('resolveSecret — isolate TTL 缓存', () => {
  it('TTL 内命中缓存（KV 删除后仍返回旧值）', async () => {
    const store = new SecretStore(env.KV_TENANTS, KEY);
    await store.write('CACHED', 'v1');
    const e = makeEnv({ WATT_SECRET_ENCRYPTION_KEY: KEY });
    const t0 = 1_000_000;
    expect(await resolveSecret(e, 'CACHED', t0)).toBe('v1');
    await store.delete('CACHED');
    // TTL 内（+30s）：仍返回缓存值。
    expect(await resolveSecret(e, 'CACHED', t0 + 30_000)).toBe('v1');
    // 超 TTL（+61s）：缓存过期，重查 KV → 已删 → undefined。
    expect(await resolveSecret(e, 'CACHED', t0 + 61_000)).toBeUndefined();
  });

  it('resetSecretCacheForTests 清缓存', async () => {
    const store = new SecretStore(env.KV_TENANTS, KEY);
    await store.write('C2', 'v1');
    const e = makeEnv({ WATT_SECRET_ENCRYPTION_KEY: KEY });
    const t0 = 2_000_000;
    expect(await resolveSecret(e, 'C2', t0)).toBe('v1');
    await store.delete('C2');
    resetSecretCacheForTests();
    // 清缓存后立即重查（同一时刻）→ KV 已删 → undefined。
    expect(await resolveSecret(e, 'C2', t0)).toBeUndefined();
  });
});
