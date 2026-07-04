/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, SELF } from 'cloudflare:test';
import {
  importPrivateJwk,
  importPublicJwk,
  type JWK,
  type PublicKeyMaterial,
  verifyToken,
} from '@watt/core';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetSeedGuardForTests } from '../src/authz/seed.ts';
import { PLATFORM_KID } from '../src/env.ts';
import { TEST_ADMIN_PRINCIPAL, TEST_PRIVATE_JWK } from './fixtures/test-key.ts';

/**
 * Root Key 换发集成测试（§6.5e）。真实 workerd + D1。
 * 覆盖：正确 key → admin token（可验签、principal/roles 正确、TTL 生效与钳制）；
 * 错误 key → 401 invalid_grant + deny 审计；缺 key/非 JSON → invalid_request；
 * 审计 allow 留痕（resource platform://auth / action root-exchange）。
 * fixture：vitest.config bindings WATT_ROOT_KEY_HASH = sha256(TEST_ROOT_KEY)。
 */

const BASE = 'https://gateway.test';
const TEST_ROOT_KEY = 'wrk_test_root_key_fixture_0001';

let verifyKey: PublicKeyMaterial;

beforeAll(async () => {
  const { publicJwk } = await importPrivateJwk(TEST_PRIVATE_JWK, PLATFORM_KID);
  verifyKey = await importPublicJwk(publicJwk as JWK, PLATFORM_KID);
});

beforeEach(async () => {
  await env.DB_POLICIES.prepare('DELETE FROM policies').run();
  await env.DB_POLICIES.prepare('DELETE FROM identity_mappings').run();
  await env.DB_AUDIT.prepare('DELETE FROM audit_records').run();
  resetSeedGuardForTests();
});

async function exchange(body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/oauth/root/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /oauth/root/token (§6.5e Root Key 换发)', () => {
  it('correct key → admin token verifiable; roles resolved; audit allow', async () => {
    const res = await exchange({ root_key: TEST_ROOT_KEY });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    expect(body.expires_in).toBe(7 * 24 * 3600); // 缺省 7d
    const verified = await verifyToken(body.access_token, verifyKey, {
      issuer: 'watt-platform',
      audience: 'watt-api',
    });
    expect(verified.claims.sub).toBe(TEST_ADMIN_PRINCIPAL);
    expect(verified.claims.roles).toContain('admin'); // 种子引导幂等 + ResolvePrincipal 实时解析
    const audit = await env.DB_AUDIT.prepare(
      "SELECT decision FROM audit_records WHERE resource = 'platform://auth' AND action = 'root-exchange' ORDER BY at DESC LIMIT 1",
    ).first<{ decision: string }>();
    expect(audit?.decision).toBe('allow');
  });

  it('ttl_sec 生效且钳制上限 30d / 下限 60s', async () => {
    const short = (await (await exchange({ root_key: TEST_ROOT_KEY, ttl_sec: 120 })).json()) as {
      expires_in: number;
    };
    expect(short.expires_in).toBe(120);
    const over = (await (
      await exchange({ root_key: TEST_ROOT_KEY, ttl_sec: 999 * 24 * 3600 })
    ).json()) as { expires_in: number };
    expect(over.expires_in).toBe(30 * 24 * 3600);
  });

  it('wrong key → 401 invalid_grant + deny audit; no token leaked', async () => {
    const res = await exchange({ root_key: 'wrk_wrong_key' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string; access_token?: string };
    expect(body.error).toBe('invalid_grant');
    expect(body.access_token).toBeUndefined();
    const audit = await env.DB_AUDIT.prepare(
      "SELECT decision FROM audit_records WHERE resource = 'platform://auth' AND action = 'root-exchange' ORDER BY at DESC LIMIT 1",
    ).first<{ decision: string }>();
    expect(audit?.decision).toBe('deny');
  });

  it('missing root_key / non-JSON body → 400 invalid_request', async () => {
    const missing = await exchange({});
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error?: string }).error).toBe('invalid_request');
    const bad = await SELF.fetch(`${BASE}/oauth/root/token`, { method: 'POST', body: 'not-json' });
    expect(bad.status).toBe(400);
  });
});
