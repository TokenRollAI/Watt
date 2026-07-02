/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, SELF } from 'cloudflare:test';
import {
  type DeviceGrant,
  importPrivateJwk,
  importPublicJwk,
  type JWK,
  type PublicKeyMaterial,
  signUserToken,
  type TokenMeta,
  verifyToken,
} from '@watt/core';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeviceGrantStore } from '../src/authz/device-store.ts';
import { resetSeedGuardForTests } from '../src/authz/seed.ts';
import { PLATFORM_KID } from '../src/env.ts';
import {
  TEST_ADMIN_PRINCIPAL,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  TEST_PRIVATE_JWK,
} from './fixtures/test-key.ts';

/**
 * device flow 集成测试（§6.5d，RFC 8628）。真实 workerd + KV(KV_TENANTS) + D1。
 * 覆盖：authorize→pending→approve→token 全链、过期、重复 approve、非 admin approve 403、
 * 无 token approve 401、未知 device_code、错误 grant_type。
 */

const META: TokenMeta = { issuer: TEST_JWT_ISSUER, audience: TEST_JWT_AUDIENCE };
const BASE = 'https://gateway.test';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

let signAdmin: () => Promise<string>;
let signNonAdmin: () => Promise<string>;
let verifyKey: PublicKeyMaterial;

beforeAll(async () => {
  const { priv, publicJwk } = await importPrivateJwk(TEST_PRIVATE_JWK, PLATFORM_KID);
  verifyKey = await importPublicJwk(publicJwk as JWK, PLATFORM_KID);
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
  // isolate 级引导短路：清库后必须重置，否则种子 Policy 不再重建 → admin approve 丢授权 → 403。
  resetSeedGuardForTests();
});

async function authorize(): Promise<{ device_code: string; user_code: string }> {
  const res = await SELF.fetch(`${BASE}/oauth/device/authorize`, { method: 'POST' });
  expect(res.status).toBe(200);
  return (await res.json()) as { device_code: string; user_code: string };
}

async function requestToken(deviceCode: string): Promise<Response> {
  return SELF.fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: GRANT_TYPE, device_code: deviceCode }),
  });
}

async function approve(token: string, userCode: string, principal?: string): Promise<Response> {
  return SELF.fetch(`${BASE}/oauth/device/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(principal ? { user_code: userCode, principal } : { user_code: userCode }),
  });
}

describe('POST /oauth/device/authorize', () => {
  it('returns device_code/user_code/verification_uri/expires_in/interval per §6.5d', async () => {
    const res = await SELF.fetch(`${BASE}/oauth/device/authorize`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.device_code).toBe('string');
    expect(body.user_code).toMatch(/^[A-Z0-9]{8}$/);
    expect(typeof body.verification_uri).toBe('string');
    expect(body.expires_in).toBe(600);
    expect(body.interval).toBe(5);
  });
});

describe('POST /oauth/token — pending path (§6.5d OAuth shape)', () => {
  it('returns 400 {error:"authorization_pending"} before approval (bare OAuth, not WattError)', async () => {
    const { device_code } = await authorize();
    const res = await requestToken(device_code);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('authorization_pending');
    // OAuth shape, NOT WattError: no code/retryable fields.
    expect(body.code).toBeUndefined();
    expect(body.retryable).toBeUndefined();
  });

  it('returns invalid_grant for an unknown device_code', async () => {
    const res = await requestToken('does-not-exist');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('returns invalid_request for a wrong grant_type', async () => {
    const res = await SELF.fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', device_code: 'x' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_request');
  });

  it('returns expired_token for an expired grant (RFC 8628)', async () => {
    // 直接写一条 expiresAt 已过去的 grant（KV 记录仍在：TTL≥60s，但业务判定按 expiresAt）。
    const nowSec = Math.floor(Date.now() / 1000);
    const store = new DeviceGrantStore(env.KV_TENANTS);
    const grant: DeviceGrant = {
      deviceCode: 'expired-dc',
      userCode: 'EXPIRED1',
      status: 'pending',
      createdAt: nowSec - 1000,
      expiresAt: nowSec - 1, // already past
    };
    await store.put(grant, nowSec); // TTL floored to 60s so record persists for the assertion
    const res = await requestToken('expired-dc');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('expired_token');
  });
});

describe('POST /oauth/device/approve — auth guard (WattError, platform action)', () => {
  it('401 with no token', async () => {
    const { user_code } = await authorize();
    const res = await SELF.fetch(`${BASE}/oauth/device/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_code }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('permission_denied');
  });

  it('403 for a non-admin token (default-deny)', async () => {
    const { user_code } = await authorize();
    const res = await approve(await signNonAdmin(), user_code);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('permission_denied');
  });

  it('404 for an unknown user_code', async () => {
    const res = await approve(await signAdmin(), 'ZZZZZZZZ');
    expect(res.status).toBe(404);
  });
});

describe('full chain: authorize → pending → approve → token', () => {
  it('issues a user token bound to the approved principal after admin approve', async () => {
    const { device_code, user_code } = await authorize();

    // 1. token before approval → pending
    expect((await requestToken(device_code)).status).toBe(400);

    // 2. admin approves (defaults principal to admin's own sub)
    const appRes = await approve(await signAdmin(), user_code);
    expect(appRes.status).toBe(200);
    const appBody = (await appRes.json()) as { approved: boolean; principal: string };
    expect(appBody.approved).toBe(true);
    expect(appBody.principal).toBe(TEST_ADMIN_PRINCIPAL);

    // 3. token now returns access_token
    const tokenRes = await requestToken(device_code);
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(tokenBody.token_type).toBe('Bearer');
    expect(typeof tokenBody.access_token).toBe('string');

    // 4. the issued token is a valid platform user token with admin roles (live-resolved)
    const verified = await verifyToken(tokenBody.access_token, verifyKey, META);
    expect(verified.claims.sub).toBe(TEST_ADMIN_PRINCIPAL);
    expect(verified.claims.roles).toContain('admin');
    expect(verified.claims.agent_def).toBeUndefined(); // user token, no agent segment
  });

  it('repeated approve is idempotent (alreadyApproved) and does not change binding', async () => {
    const { device_code, user_code } = await authorize();
    await approve(await signAdmin(), user_code, 'user:target');
    const second = await approve(await signAdmin(), user_code, 'user:someone-else');
    expect(second.status).toBe(200);
    const body = (await second.json()) as { alreadyApproved?: boolean; principal: string };
    expect(body.alreadyApproved).toBe(true);
    expect(body.principal).toBe('user:target'); // binding unchanged

    const tokenRes = await requestToken(device_code);
    const tokenBody = (await tokenRes.json()) as { access_token: string };
    const verified = await verifyToken(tokenBody.access_token, verifyKey, META);
    expect(verified.claims.sub).toBe('user:target');
  });

  it('consumes device_code on success: replay returns invalid_grant (§6.5d one-time use)', async () => {
    const { device_code, user_code } = await authorize();
    await approve(await signAdmin(), user_code);
    // 首次换取成功
    expect((await requestToken(device_code)).status).toBe(200);
    // 重放同一 device_code → grant 已消费 → 400 invalid_grant
    const replay = await requestToken(device_code);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');
  });
});

describe('POST /oauth/token — approved but expired grant (§6.5d, expiry precedence)', () => {
  it('returns expired_token for an approved grant past expiresAt', async () => {
    // 直写一条 approved 且 expiresAt 已过去的 grant：过期判定必须先于 approved 状态。
    const nowSec = Math.floor(Date.now() / 1000);
    const store = new DeviceGrantStore(env.KV_TENANTS);
    const grant: DeviceGrant = {
      deviceCode: 'expired-approved-dc',
      userCode: 'EXPAPPR1',
      status: 'approved',
      principal: 'user:djj',
      createdAt: nowSec - 1000,
      expiresAt: nowSec - 1, // already past
    };
    await store.put(grant, nowSec); // TTL floored to 60s so record persists for the assertion
    const res = await requestToken('expired-approved-dc');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('expired_token');
  });
});

describe('POST /oauth/device/approve — user_code normalization (§6.5d)', () => {
  it('approves when the submitted user_code is lowercase', async () => {
    const { device_code, user_code } = await authorize();
    // 提交小写 user_code：归一化后应命中 approve
    const res = await approve(await signAdmin(), user_code.toLowerCase());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { approved: boolean }).approved).toBe(true);
    // 且随后可换取 token（证明命中的是同一 grant）
    expect((await requestToken(device_code)).status).toBe(200);
  });
});
