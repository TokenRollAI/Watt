/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { SecretStore, type StoredSecretV1 } from '../src/secrets/secret-store.ts';

/**
 * SecretStore 单测（Proto §6.6）——真实 workerd WebCrypto + miniflare KV。
 * 覆盖：加解密 roundtrip / AAD 名字错配拒解 / 名字约束 / list·getMeta 元数据 / 主密钥非法长度抛错。
 */

// 固定测试主密钥（32 字节 base64url，与 vitest.config.ts 注入值同一把——但本单测直接构造 store）。
const KEY = 'XOL8MO7eCWDeaTn27cjz6KkV2u3o0d1KnpKzVQxUebQ';

async function clearSecrets(): Promise<void> {
  let cursor: string | undefined;
  do {
    const res = await env.KV_TENANTS.list({ prefix: 'secret:', cursor });
    for (const k of res.keys) await env.KV_TENANTS.delete(k.name);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor !== undefined);
}

beforeEach(clearSecrets);

describe('SecretStore — 加解密 roundtrip', () => {
  it('write → getValue 还原明文', async () => {
    const store = new SecretStore(env.KV_TENANTS, KEY);
    const meta = await store.write('MY_KEY', 'super-secret-value-🔑');
    expect('code' in meta).toBe(false);
    const value = await store.getValue('MY_KEY');
    expect(value).toBe('super-secret-value-🔑');
  });

  it('覆写更新值 + updatedAt', async () => {
    const store = new SecretStore(env.KV_TENANTS, KEY);
    await store.write('MY_KEY', 'v1');
    await store.write('MY_KEY', 'v2');
    expect(await store.getValue('MY_KEY')).toBe('v2');
  });

  it('KV 存储不含明文（密文形状 v1/iv/ct）', async () => {
    const store = new SecretStore(env.KV_TENANTS, KEY);
    await store.write('MY_KEY', 'plaintext-must-not-appear');
    const raw = await env.KV_TENANTS.get('secret:MY_KEY');
    expect(raw).not.toBeNull();
    expect(raw).not.toContain('plaintext-must-not-appear');
    const stored = JSON.parse(raw as string) as StoredSecretV1;
    expect(stored.v).toBe(1);
    expect(typeof stored.iv).toBe('string');
    expect(typeof stored.ct).toBe('string');
    expect(typeof stored.updatedAt).toBe('string');
  });

  it('每次写用不同随机 IV', async () => {
    const store = new SecretStore(env.KV_TENANTS, KEY);
    await store.write('MY_KEY', 'same-value');
    const iv1 = (
      JSON.parse((await env.KV_TENANTS.get('secret:MY_KEY')) as string) as StoredSecretV1
    ).iv;
    await store.write('MY_KEY', 'same-value');
    const iv2 = (
      JSON.parse((await env.KV_TENANTS.get('secret:MY_KEY')) as string) as StoredSecretV1
    ).iv;
    expect(iv1).not.toBe(iv2);
  });
});

describe('SecretStore — AAD=名 防内容对调', () => {
  it('把 A 的密文搬到 B 键位下 → getValue(B) 解密失败返回 null', async () => {
    const store = new SecretStore(env.KV_TENANTS, KEY);
    await store.write('ALPHA', 'alpha-value');
    const alphaRaw = (await env.KV_TENANTS.get('secret:ALPHA')) as string;
    // 手动把 ALPHA 的密文原样放到 BETA 键位（AAD 仍是加密时的 'ALPHA'，解密时用 'BETA' → tag 校验失败）。
    await env.KV_TENANTS.put('secret:BETA', alphaRaw);
    expect(await store.getValue('BETA')).toBeNull();
    // A 自身仍可正常解密。
    expect(await store.getValue('ALPHA')).toBe('alpha-value');
  });

  it('主密钥变更（另一把 key）→ 旧密文解不开返回 null', async () => {
    const store = new SecretStore(env.KV_TENANTS, KEY);
    await store.write('ROTATE_ME', 'v1');
    const otherKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // 32B base64url，另一把
    const store2 = new SecretStore(env.KV_TENANTS, otherKey);
    expect(await store2.getValue('ROTATE_ME')).toBeNull();
  });
});

describe('SecretStore — 名字约束', () => {
  it.each([
    ['lowercase', false],
    ['1LEADING_DIGIT', false],
    ['HAS-DASH', false],
    ['HAS SPACE', false],
    ['A'.repeat(65), false],
    ['A', true],
    ['MY_KEY_1', true],
    ['A'.repeat(64), true],
  ])('write(%s) 合法=%s', async (name, ok) => {
    const store = new SecretStore(env.KV_TENANTS, KEY);
    const res = await store.write(name, 'v');
    if (ok) expect('code' in res).toBe(false);
    else {
      expect('code' in res).toBe(true);
      expect((res as { code: string }).code).toBe('invalid_argument');
    }
  });
});

describe('SecretStore — 元数据面（永不回显明文）', () => {
  it('getMeta 只出 name/updatedAt，不解密', async () => {
    const store = new SecretStore(env.KV_TENANTS, KEY);
    const written = await store.write('META_KEY', 'v');
    const meta = await store.getMeta('META_KEY');
    expect(meta).not.toBeNull();
    expect(meta?.name).toBe('META_KEY');
    expect(meta?.updatedAt).toBe((written as { updatedAt: string }).updatedAt);
    expect(await store.getMeta('MISSING')).toBeNull();
  });

  it('list 返回全部元数据', async () => {
    const store = new SecretStore(env.KV_TENANTS, KEY);
    await store.write('K1', 'a');
    await store.write('K2', 'b');
    const items = await store.list();
    const names = items.map((i) => i.name).sort();
    expect(names).toEqual(['K1', 'K2']);
    for (const i of items) expect(typeof i.updatedAt).toBe('string');
  });

  it('delete 幂等', async () => {
    const store = new SecretStore(env.KV_TENANTS, KEY);
    await store.write('DEL_ME', 'v');
    expect(await store.delete('DEL_ME')).toEqual({ deleted: true });
    expect(await store.getValue('DEL_ME')).toBeNull();
    // 不存在也返回 deleted（幂等）。
    expect(await store.delete('DEL_ME')).toEqual({ deleted: true });
  });
});

describe('SecretStore — 主密钥降级', () => {
  it('非法长度主密钥（16B base64url）→ write 抛 32 bytes 错', async () => {
    // 'AAAAAAAAAAAAAAAAAAAAAA' = 22 base64url 字符 → 16 字节（非 32）。
    const store = new SecretStore(env.KV_TENANTS, 'AAAAAAAAAAAAAAAAAAAAAA');
    await expect(store.write('K', 'v')).rejects.toThrow(/32 bytes/);
  });

  it('畸形 base64（无法 atob）→ write 抛错', async () => {
    const store = new SecretStore(env.KV_TENANTS, 'short');
    await expect(store.write('K', 'v')).rejects.toThrow();
  });
});
