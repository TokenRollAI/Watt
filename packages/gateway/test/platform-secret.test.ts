/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, SELF } from 'cloudflare:test';
import { importPrivateJwk, signUserToken, type TokenMeta } from '@watt/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetManageSeedGuardForTests } from '../src/agent/manage/manage-defs.ts';
import { resetSeedGuardForTests } from '../src/authz/seed.ts';
import { PLATFORM_KID } from '../src/env.ts';
import { resetPluginSeedGuardForTests } from '../src/plugin/plugin-seed.ts';
import {
  TEST_ADMIN_PRINCIPAL,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  TEST_PRIVATE_JWK,
} from './fixtures/test-key.ts';

/**
 * SecretStore 平台面路由集成测试（HTTP 进 → KV_TENANTS 出，真实 workerd WebCrypto）。
 * 覆盖 POST /htbp/platform/secret 四动词 List/Get/Write/Delete（§6.6）+ 鉴权（Write/Delete=manage、
 * List/Get=read；platform://secret）+ 未知 tool + 401/403 + **响应全文永不含明文** + shadowedByEnv。
 *
 * 响应形状真源（CLI mock 照此对齐，toolchain §34）：
 *   Write → { secret:{name,updatedAt} }（无 value）；List → { items:[{name,updatedAt,shadowedByEnv}] }；
 *   Get → { secret:{name,updatedAt,shadowedByEnv} }；Delete → { deleted:true }。
 * 主密钥 WATT_SECRET_ENCRYPTION_KEY 由 vitest.config.ts 注入。WEBHOOK_SECRET_TEST 是一个 env 同名影子
 *   （config 已注入）——用于 shadowedByEnv 断言。
 */

const META: TokenMeta = { issuer: TEST_JWT_ISSUER, audience: TEST_JWT_AUDIENCE };
const BASE = 'https://gateway.test';

let signAdmin: () => Promise<string>;
let signNonAdmin: () => Promise<string>;

async function clearAll(): Promise<void> {
  await env.DB_POLICIES.prepare('DELETE FROM policies').run();
  await env.DB_POLICIES.prepare('DELETE FROM identity_mappings').run();
  let cursor: string | undefined;
  do {
    const res = await env.KV_TENANTS.list({ prefix: 'secret:', cursor });
    for (const k of res.keys) await env.KV_TENANTS.delete(k.name);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor !== undefined);
}

beforeEach(async () => {
  const { priv } = await importPrivateJwk(TEST_PRIVATE_JWK, PLATFORM_KID);
  signAdmin = () =>
    signUserToken({ principal: TEST_ADMIN_PRINCIPAL, roles: ['admin'], trace: 'tr-t' }, priv, META);
  signNonAdmin = () => signUserToken({ principal: 'user:bob', roles: ['staff'] }, priv, META);
  await clearAll();
  resetSeedGuardForTests();
  resetManageSeedGuardForTests();
  resetPluginSeedGuardForTests();
});

async function call(token: string, tool: string, args: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`${BASE}/htbp/platform/secret`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tool, arguments: args }),
  });
}

describe('POST /htbp/platform/secret — auth', () => {
  it('no token → 401', async () => {
    const res = await SELF.fetch(`${BASE}/htbp/platform/secret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'List', arguments: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('non-admin Write → 403', async () => {
    const res = await call(await signNonAdmin(), 'Write', { name: 'X_KEY', value: 'v' });
    expect(res.status).toBe(403);
  });

  it('non-admin List → 403', async () => {
    const res = await call(await signNonAdmin(), 'List', {});
    expect(res.status).toBe(403);
  });

  it('unknown tool → 400 invalid_argument', async () => {
    const res = await call(await signAdmin(), 'Frobnicate', {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_argument');
  });
});

describe('POST /htbp/platform/secret — Write/Get/Delete（永不回显明文）', () => {
  const PLAINTEXT = 'super-secret-value-do-not-leak-8675309';

  it('admin Write → {secret:{name,updatedAt}}，响应全文不含明文', async () => {
    const res = await call(await signAdmin(), 'Write', { name: 'API_KEY', value: PLAINTEXT });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(PLAINTEXT);
    const body = JSON.parse(text) as {
      secret: { name: string; updatedAt: string; value?: string };
    };
    expect(body.secret.name).toBe('API_KEY');
    expect(typeof body.secret.updatedAt).toBe('string');
    expect(body.secret.value).toBeUndefined();
  });

  it('Get 已写入 secret → 元数据（无明文）', async () => {
    await call(await signAdmin(), 'Write', { name: 'API_KEY', value: PLAINTEXT });
    const res = await call(await signAdmin(), 'Get', { name: 'API_KEY' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(PLAINTEXT);
    const body = JSON.parse(text) as {
      secret: { name: string; updatedAt: string; shadowedByEnv: boolean };
    };
    expect(body.secret.name).toBe('API_KEY');
    expect(body.secret.shadowedByEnv).toBe(false);
  });

  it('Get 不存在的 secret → 404 not_found', async () => {
    const res = await call(await signAdmin(), 'Get', { name: 'MISSING' });
    expect(res.status).toBe(404);
  });

  it('Delete → {deleted:true}，之后 Get 404', async () => {
    await call(await signAdmin(), 'Write', { name: 'API_KEY', value: PLAINTEXT });
    const del = await call(await signAdmin(), 'Delete', { name: 'API_KEY' });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });
    const get = await call(await signAdmin(), 'Get', { name: 'API_KEY' });
    expect(get.status).toBe(404);
  });

  it('Write 名字非法 → 400 invalid_argument', async () => {
    const res = await call(await signAdmin(), 'Write', { name: 'bad-name', value: 'v' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_argument');
  });

  it('Write 缺 value → 400', async () => {
    const res = await call(await signAdmin(), 'Write', { name: 'API_KEY' });
    expect(res.status).toBe(400);
  });
});

describe('POST /htbp/platform/secret — List + shadowedByEnv', () => {
  const PLAINTEXT = 'list-must-not-leak-value';

  it('List 返回元数据，响应全文不含明文', async () => {
    await call(await signAdmin(), 'Write', { name: 'K_ONE', value: PLAINTEXT });
    await call(await signAdmin(), 'Write', { name: 'K_TWO', value: 'another' });
    const res = await call(await signAdmin(), 'List', {});
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(PLAINTEXT);
    const body = JSON.parse(text) as {
      items: { name: string; updatedAt: string; shadowedByEnv: boolean }[];
    };
    const names = body.items.map((i) => i.name).sort();
    expect(names).toEqual(['K_ONE', 'K_TWO']);
    for (const i of body.items) expect(i.shadowedByEnv).toBe(false);
  });

  it('写一个与 env 同名的 secret（WEBHOOK_SECRET_TEST）→ shadowedByEnv:true', async () => {
    // WEBHOOK_SECRET_TEST 由 vitest.config.ts 注入 env → env 会先命中、KV 值不生效。
    await call(await signAdmin(), 'Write', { name: 'WEBHOOK_SECRET_TEST', value: 'kv-shadowed' });
    const list = await call(await signAdmin(), 'List', {});
    const body = (await list.json()) as {
      items: { name: string; shadowedByEnv: boolean }[];
    };
    const entry = body.items.find((i) => i.name === 'WEBHOOK_SECRET_TEST');
    expect(entry?.shadowedByEnv).toBe(true);
    // Get 同样反映 shadow。
    const get = await call(await signAdmin(), 'Get', { name: 'WEBHOOK_SECRET_TEST' });
    const gbody = (await get.json()) as { secret: { shadowedByEnv: boolean } };
    expect(gbody.secret.shadowedByEnv).toBe(true);
  });

  it('Get env-only 影子名（KV 无、env 有）→ {updatedAt:null,shadowedByEnv:true}', async () => {
    const res = await call(await signAdmin(), 'Get', { name: 'WEBHOOK_SECRET_TEST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      secret: { name: string; updatedAt: null; shadowedByEnv: boolean };
    };
    expect(body.secret.updatedAt).toBeNull();
    expect(body.secret.shadowedByEnv).toBe(true);
  });
});
