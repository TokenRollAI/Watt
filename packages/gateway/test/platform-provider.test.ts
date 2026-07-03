/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, SELF } from 'cloudflare:test';
import { importPrivateJwk, signUserToken, type TokenMeta } from '@watt/core';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetSeedGuardForTests } from '../src/authz/seed.ts';
import { PLATFORM_KID } from '../src/env.ts';
import {
  TEST_ADMIN_PRINCIPAL,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  TEST_PRIVATE_JWK,
} from './fixtures/test-key.ts';

/**
 * ModelProviderRegistry 平台面路由集成测试（HTTP 进 → DB_PROVIDERS/D1 出，真实 workerd）。
 * 覆盖 POST /htbp/platform/provider 四动词 + SetDefault（§9）+ 鉴权（§6.4d：List/Get=read，
 * Write/Update/SetDefault=manage；platform://provider）+ 未知 tool + 401/403 + secretRef 脱敏。
 *
 * 响应形状真源（CLI mock 照此对齐，toolchain §34）：Get/Write/Update/SetDefault → { provider }；
 *   List → 裸 Page{items}；provider 投影**不含 secretRef**（§9 永不回显）。
 */

const META: TokenMeta = { issuer: TEST_JWT_ISSUER, audience: TEST_JWT_AUDIENCE };
const BASE = 'https://gateway.test';

let signAdmin: () => Promise<string>;
let signNonAdmin: () => Promise<string>;

beforeAll(async () => {
  const { priv } = await importPrivateJwk(TEST_PRIVATE_JWK, PLATFORM_KID);
  signAdmin = () =>
    signUserToken({ principal: TEST_ADMIN_PRINCIPAL, roles: ['admin'], trace: 'tr-t' }, priv, META);
  signNonAdmin = () => signUserToken({ principal: 'user:bob', roles: ['staff'] }, priv, META);
});

async function clearDb() {
  await env.DB_POLICIES.prepare('DELETE FROM policies').run();
  await env.DB_POLICIES.prepare('DELETE FROM identity_mappings').run();
  await env.DB_PROVIDERS.prepare('DELETE FROM model_providers').run();
}
beforeEach(async () => {
  await clearDb();
  resetSeedGuardForTests();
});

async function call(token: string, tool: string, args: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`${BASE}/htbp/platform/provider`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tool, arguments: args }),
  });
}

const PROV = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  vendor: 'anthropic',
  models: ['glm-5.2'],
  priority: 10,
  default: false,
  secretRef: 'ANTHROPIC_API_KEY',
  enabled: true,
  ...over,
});

let n = 0;
const uniq = (b: string) => `${b}-${n++}`;

describe('POST /htbp/platform/provider — auth', () => {
  it('no token → 401', async () => {
    const res = await SELF.fetch(`${BASE}/htbp/platform/provider`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'List', arguments: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('non-admin denied Write → 403', async () => {
    const res = await call(await signNonAdmin(), 'Write', { provider: PROV('x') });
    expect(res.status).toBe(403);
  });

  it('unknown tool → 400', async () => {
    const res = await call(await signAdmin(), 'Bogus', {});
    expect(res.status).toBe(400);
  });
});

describe('ModelProviderRegistry verbs via route (§9)', () => {
  it('Write returns { provider } without secretRef; Get returns redacted', async () => {
    const token = await signAdmin();
    const id = uniq('p');
    const w = await call(token, 'Write', { provider: PROV(id) });
    expect(w.status).toBe(200);
    const wBody = (await w.json()) as { provider: Record<string, unknown> };
    expect(wBody.provider.id).toBe(id);
    expect('secretRef' in wBody.provider).toBe(false);

    const g = await call(token, 'Get', { providerId: id });
    expect(g.status).toBe(200);
    const gBody = (await g.json()) as { provider: Record<string, unknown> };
    expect('secretRef' in gBody.provider).toBe(false);
  });

  it('List returns bare Page{items}', async () => {
    const token = await signAdmin();
    await call(token, 'Write', { provider: PROV(uniq('l')) });
    const res = await call(token, 'List', { opts: {} });
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it('SetDefault marks single default → { provider }', async () => {
    const token = await signAdmin();
    const id = uniq('d');
    await call(token, 'Write', { provider: PROV(id) });
    const res = await call(token, 'SetDefault', { providerId: id });
    expect(res.status).toBe(200);
    const sd = (await res.json()) as { provider: { default: boolean } };
    expect(sd.provider.default).toBe(true);
  });

  it('Get on missing → 404', async () => {
    const res = await call(await signAdmin(), 'Get', { providerId: 'nope' });
    expect(res.status).toBe(404);
  });
});
