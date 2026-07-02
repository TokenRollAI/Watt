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
 * Platform API 集成测试（HTTP 进 → PolicyStore/D1 出，vitest-pool-workers 真实 workerd）。
 * DOD §3 集成用例：种子引导后 whoami 含 admin、无 token 401、非 admin 403、policy list 含种子。
 * 用测试私钥（与 gateway env WATT_JWT_PRIVATE_JWK 同源）签发 user token。
 */

const META: TokenMeta = { issuer: TEST_JWT_ISSUER, audience: TEST_JWT_AUDIENCE };
const BASE = 'https://gateway.test';

let signAdmin: () => Promise<string>;
let signNonAdmin: () => Promise<string>;

beforeAll(async () => {
  const { priv } = await importPrivateJwk(TEST_PRIVATE_JWK, PLATFORM_KID);
  signAdmin = () =>
    signUserToken({ principal: TEST_ADMIN_PRINCIPAL, roles: ['admin'], trace: 'tr-a' }, priv, META);
  signNonAdmin = () => signUserToken({ principal: 'user:bob', roles: ['staff'] }, priv, META);
});

async function clearDb() {
  await env.DB_POLICIES.prepare('DELETE FROM policies').run();
  await env.DB_POLICIES.prepare('DELETE FROM identity_mappings').run();
}
beforeEach(async () => {
  await clearDb();
  // isolate 级引导短路：清库后必须重置，否则种子不再重建 → admin 丢角色 → 全 403。
  resetSeedGuardForTests();
});

describe('GET /.well-known/jwks.json (public)', () => {
  it('returns 200 with an Ed25519 public key and no private material', async () => {
    const res = await SELF.fetch(`${BASE}/.well-known/jwks.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Record<string, unknown>[] };
    expect(Array.isArray(body.keys)).toBe(true);
    const key = body.keys[0];
    expect(key).toBeDefined();
    if (!key) return;
    expect(key.kty).toBe('OKP');
    expect(key.crv).toBe('Ed25519');
    expect(key.alg).toBe('EdDSA');
    expect(key.use).toBe('sig');
    expect(key.d).toBeUndefined(); // 绝不暴露私钥
  });
});

describe('authentication (§11.3a / §0.2 补充)', () => {
  it('rejects a request with no token: 401 bare WattError', async () => {
    const res = await SELF.fetch(`${BASE}/htbp/platform/whoami`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string; message: string; retryable: boolean };
    expect(body.code).toBe('permission_denied');
    expect(body.retryable).toBe(false);
    expect(typeof body.message).toBe('string');
  });

  it('rejects an invalid token: 401', async () => {
    const res = await SELF.fetch(`${BASE}/htbp/platform/whoami`, {
      headers: { Authorization: 'Bearer not-a-jwt' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('permission_denied');
  });
});

describe('GET /htbp/platform/whoami', () => {
  it('after seed bootstrap, admin token whoami shows principal + role:admin', async () => {
    const token = await signAdmin();
    const res = await SELF.fetch(`${BASE}/htbp/platform/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { principal: string; roles: string[]; agent: unknown };
    expect(body.principal).toBe(TEST_ADMIN_PRINCIPAL);
    expect(body.roles).toContain('admin');
    expect(body.agent).toBeNull(); // user token 无 agent 段（§6.5a）
  });
});

describe('POST /htbp/platform/policy', () => {
  it('admin can List and sees the seed policy after bootstrap', async () => {
    const token = await signAdmin();
    const res = await SELF.fetch(`${BASE}/htbp/platform/policy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'List', arguments: { opts: {} } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { subject: string; effect: string }[] };
    const seed = body.items.find((p) => p.subject === 'role:admin');
    expect(seed).toBeDefined();
    expect(seed?.effect).toBe('allow');
  });

  it('admin can Write a new policy, then Get it back', async () => {
    const token = await signAdmin();
    const write = await SELF.fetch(`${BASE}/htbp/platform/policy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: 'Write',
        arguments: {
          policy: {
            id: 'pol-1',
            subject: 'user:carol',
            resource: 'tool://finance/*',
            actions: ['invoke'],
            effect: 'allow',
          },
        },
      }),
    });
    expect(write.status).toBe(200);
    const got = await SELF.fetch(`${BASE}/htbp/platform/policy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'Get', arguments: { id: 'pol-1' } }),
    });
    expect(got.status).toBe(200);
    const body = (await got.json()) as { policy: { subject: string } };
    expect(body.policy.subject).toBe('user:carol');
  });

  it('non-admin token is denied Write with 403 (default-deny, no seed match)', async () => {
    const token = await signNonAdmin();
    const res = await SELF.fetch(`${BASE}/htbp/platform/policy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: 'Write',
        arguments: {
          policy: {
            id: 'x',
            subject: 'user:x',
            resource: '*',
            actions: ['*'],
            effect: 'allow',
          },
        },
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('permission_denied');
  });

  it('rejects unknown tool with invalid_argument (admin authorized)', async () => {
    const token = await signAdmin();
    const res = await SELF.fetch(`${BASE}/htbp/platform/policy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'Frobnicate', arguments: {} }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_argument');
  });

  it('rejects Update with a malformed patch (invalid actions shape) as invalid_argument', async () => {
    const token = await signAdmin();
    // 先写一条可更新的 Policy。
    await SELF.fetch(`${BASE}/htbp/platform/policy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: 'Write',
        arguments: {
          policy: {
            id: 'pol-upd',
            subject: 'user:carol',
            resource: 'tool://x/*',
            actions: ['invoke'],
            effect: 'allow',
          },
        },
      }),
    });
    // actions 应为 string[]，此处传对象 → schema 拒绝 → 400，不得写入畸形数据。
    const res = await SELF.fetch(`${BASE}/htbp/platform/policy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: 'Update',
        arguments: { id: 'pol-upd', patch: { actions: { bogus: true } } },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_argument');
  });

  it('read-only caller gets invalid_argument (not 403) for an unknown tool', async () => {
    // 先由 admin 给 bob 授予 platform://policy 的 read 权限（无 manage）。
    const admin = await signAdmin();
    await SELF.fetch(`${BASE}/htbp/platform/policy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: 'Write',
        arguments: {
          policy: {
            id: 'pol-bob-read',
            subject: 'user:bob',
            resource: 'platform://policy',
            actions: ['read'],
            effect: 'allow',
          },
        },
      }),
    });
    // bob 发未知 tool：应在鉴权前判 400 invalid_argument，而非先鉴权后 403。
    const token = await signNonAdmin();
    const res = await SELF.fetch(`${BASE}/htbp/platform/policy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'Frobnicate', arguments: {} }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_argument');
  });
});

describe('POST /htbp/platform/audit (Phase 1 interface only)', () => {
  it('admin List returns empty records structure', async () => {
    const token = await signAdmin();
    const res = await SELF.fetch(`${BASE}/htbp/platform/audit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'List', arguments: { opts: {} } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it('non-admin is denied audit read with 403', async () => {
    const token = await signNonAdmin();
    const res = await SELF.fetch(`${BASE}/htbp/platform/audit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'List', arguments: {} }),
    });
    expect(res.status).toBe(403);
  });
});
