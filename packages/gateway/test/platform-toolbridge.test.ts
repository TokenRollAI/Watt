/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, SELF } from 'cloudflare:test';
import { importPrivateJwk, signUserToken, type TokenMeta } from '@watt/core';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetSeedGuardForTests } from '../src/authz/seed.ts';
import { PLATFORM_KID } from '../src/env.ts';
import { convertToolBridgeAdminError } from '../src/tools/toolbridge-admin.ts';
import {
  TEST_ADMIN_PRINCIPAL,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  TEST_PRIVATE_JWK,
} from './fixtures/test-key.ts';

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

beforeEach(async () => {
  await env.DB_POLICIES.prepare('DELETE FROM policies').run();
  await env.DB_POLICIES.prepare('DELETE FROM identity_mappings').run();
  resetSeedGuardForTests();
});

async function call(token: string, tool: string, args: Record<string, unknown> = {}) {
  return SELF.fetch(`${BASE}/htbp/platform/toolbridge`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tool, arguments: args }),
  });
}

describe('POST /htbp/platform/toolbridge — Admin SDK bridge', () => {
  it('admin can call read methods through Tool Bridge Admin SDK', async () => {
    const res = await call(await signAdmin(), 'ProvidersList');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: unknown[] };
    expect(Array.isArray(body.providers)).toBe(true);
  });

  it('delete methods return a JSON object when the SDK returns no body', async () => {
    const res = await call(await signAdmin(), 'ProvidersDelete', { id: 'acme' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean };
    expect(body).toEqual({ deleted: true });
  });

  it('non-admin is denied before Tool Bridge is called', async () => {
    const res = await call(await signNonAdmin(), 'ProvidersList');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('permission_denied');
  });

  it('unknown method returns invalid_argument', async () => {
    const res = await call(await signAdmin(), 'NoSuchMethod');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_argument');
  });

  it('admin error conversion handles nullish thrown values', () => {
    expect(convertToolBridgeAdminError(null).code).toBe('internal');
    expect(convertToolBridgeAdminError(undefined).code).toBe('internal');
  });
});
