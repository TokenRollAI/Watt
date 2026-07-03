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
 * ToolRegistry 管理面路由集成测试（HTTP 进 → DB_PROVIDERS/D1 出，vitest-pool-workers 真实 workerd）。
 * 覆盖 POST /htbp/platform/tool 四动词（§5.2）+ 鉴权（§6.4d：List/Get=read，Write/Update=manage；
 * platform://tool 资源）+ 未知 tool invalid_argument + not_found + 无 token 401 + 非 admin 403。
 *
 * 响应形状真源（CLI mock 照此对齐，toolchain §34）：Get/Write/Update → { mount }；List → 裸 Page{items}。
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
  await env.DB_PROVIDERS.prepare('DELETE FROM tool_mounts').run();
}
beforeEach(async () => {
  await clearDb();
  resetSeedGuardForTests();
});

async function call(token: string, tool: string, args: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`${BASE}/htbp/platform/tool`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tool, arguments: args }),
  });
}

describe('POST /htbp/platform/tool — authentication & authorization', () => {
  it('rejects a request with no token: 401 bare WattError', async () => {
    const res = await SELF.fetch(`${BASE}/htbp/platform/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'List', arguments: {} }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string; retryable: boolean };
    expect(body.code).toBe('permission_denied');
    expect(body.retryable).toBe(false);
  });

  it('non-admin is denied manage (Write) with 403', async () => {
    const token = await signNonAdmin();
    const res = await call(token, 'Write', {
      mount: { path: 'x', provider: 'http', enabled: true },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('permission_denied');
  });

  it('non-admin is denied read (List) with 403', async () => {
    const token = await signNonAdmin();
    const res = await call(token, 'List', { opts: {} });
    expect(res.status).toBe(403);
  });
});

describe('POST /htbp/platform/tool — four verbs (§5.2)', () => {
  it('admin Write then Get returns { mount } with the same shape', async () => {
    const token = await signAdmin();
    const write = await call(token, 'Write', {
      mount: {
        path: 'finance/reports',
        provider: 'mcp',
        providerConfig: { endpoint: 'https://mcp.example.com', secretRef: 'MCP_TOKEN' },
        virtualize: { prefix: 'fin', hide: ['delete_all'] },
        enabled: true,
      },
    });
    expect(write.status).toBe(200);
    const written = (await write.json()) as { mount: { path: string; provider: string } };
    expect(written.mount.path).toBe('finance/reports');
    expect(written.mount.provider).toBe('mcp');

    const get = await call(token, 'Get', { path: 'finance/reports' });
    expect(get.status).toBe(200);
    const got = (await get.json()) as {
      mount: { path: string; providerConfig: Record<string, unknown>; enabled: boolean };
    };
    expect(got.mount.path).toBe('finance/reports');
    expect(got.mount.providerConfig.endpoint).toBe('https://mcp.example.com');
    expect(got.mount.enabled).toBe(true);
  });

  it('admin List returns a bare Page { items } including written mounts', async () => {
    const token = await signAdmin();
    await call(token, 'Write', {
      mount: { path: 'a/b', provider: 'http', enabled: true },
    });
    const res = await call(token, 'List', { opts: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { path: string }[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.some((m) => m.path === 'a/b')).toBe(true);
  });

  it('admin Update patches an existing mount and returns { mount }', async () => {
    const token = await signAdmin();
    await call(token, 'Write', {
      mount: { path: 'obs/logs', provider: 'http', enabled: true },
    });
    const res = await call(token, 'Update', {
      path: 'obs/logs',
      patch: { enabled: false, provider: 'builtin' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mount: { enabled: boolean; provider: string } };
    expect(body.mount.enabled).toBe(false);
    expect(body.mount.provider).toBe('builtin');
  });

  it('Get on a missing path → 404 not_found', async () => {
    const token = await signAdmin();
    const res = await call(token, 'Get', { path: 'nope' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('not_found');
  });

  it('Update on a missing path → 404 not_found', async () => {
    const token = await signAdmin();
    const res = await call(token, 'Update', { path: 'nope', patch: { enabled: false } });
    expect(res.status).toBe(404);
  });
});

describe('POST /htbp/platform/tool — validation', () => {
  it('unknown tool → 400 invalid_argument (before authz)', async () => {
    const token = await signAdmin();
    const res = await call(token, 'Bogus', {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_argument');
  });

  it('Write with an invalid mount (missing enabled) → 400 invalid_argument', async () => {
    const token = await signAdmin();
    const res = await call(token, 'Write', { mount: { path: 'x', provider: 'http' } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_argument');
  });

  it('Get without a path → 400 invalid_argument', async () => {
    const token = await signAdmin();
    const res = await call(token, 'Get', {});
    expect(res.status).toBe(400);
  });

  it('Update with an unknown patch key → 400 invalid_argument (strict)', async () => {
    const token = await signAdmin();
    await call(token, 'Write', { mount: { path: 'p', provider: 'http', enabled: true } });
    const res = await call(token, 'Update', { path: 'p', patch: { bogus: 1 } });
    expect(res.status).toBe(400);
  });

  it('non-JSON body → 400 invalid_argument', async () => {
    const token = await signAdmin();
    const res = await SELF.fetch(`${BASE}/htbp/platform/tool`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_argument');
  });
});
