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
 * AgentRegistry（§3.1）+ AgentRuntime（§3.2）平台面路由集成测试（HTTP 进 → D1/DO 出，真实 workerd）。
 * 覆盖 POST /htbp/platform/agent 的 Registry 四动词 + Runtime Spawn/Status/Terminate/ListInstances
 * + 鉴权（§6.4d：读=read，Write/Spawn/Send/Terminate/Update=manage；platform://agent）+ 未知 tool
 * + 无 token 401 + 非 admin 403。
 *
 * 响应形状真源（CLI mock 照此对齐，toolchain §34）：
 *   Get → { definition }；Write/Update → { definition }；List → 裸 Page{items}；
 *   Spawn → { instance, correlationId? }；Status → { instance }；Terminate → { terminated:true }；
 *   ListInstances → 裸 { items }。
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
  await env.DB_PROVIDERS.prepare('DELETE FROM agent_definitions').run();
}
beforeEach(async () => {
  await clearDb();
  resetSeedGuardForTests();
});

async function call(token: string, tool: string, args: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`${BASE}/htbp/platform/agent`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tool, arguments: args }),
  });
}

// biome-ignore lint/suspicious/noExplicitAny: 测试断言弱类型 JSON body。
async function body(res: Response): Promise<any> {
  return res.json();
}

const DEF = (name: string) => ({
  name,
  description: 'test',
  runtime: 'light',
  entry: { kind: 'do-class', className: 'AgentInstance' },
  grants: [],
  contextNamespaces: [],
  toolScopes: [],
});

let n = 0;
const uniq = (b: string) => `${b}-${n++}`;

describe('POST /htbp/platform/agent — auth', () => {
  it('no token → 401 bare WattError', async () => {
    const res = await SELF.fetch(`${BASE}/htbp/platform/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'List', arguments: {} }),
    });
    expect(res.status).toBe(401);
    expect((await body(res)).code).toBe('permission_denied');
  });

  it('non-admin denied Write (manage) → 403', async () => {
    const res = await call(await signNonAdmin(), 'Write', { definition: DEF('x') });
    expect(res.status).toBe(403);
  });

  it('unknown tool → 400 invalid_argument', async () => {
    const res = await call(await signAdmin(), 'Bogus', {});
    expect(res.status).toBe(400);
    expect((await body(res)).code).toBe('invalid_argument');
  });
});

describe('AgentRegistry verbs via route (§3.1)', () => {
  it('Write returns { definition }; Get returns { definition }', async () => {
    const token = await signAdmin();
    const name = uniq('a');
    const w = await call(token, 'Write', { definition: DEF(name) });
    expect(w.status).toBe(200);
    expect((await body(w)).definition.name).toBe(name);

    const g = await call(token, 'Get', { name });
    expect(g.status).toBe(200);
    expect((await body(g)).definition.name).toBe(name);
  });

  it('Get on missing → 404 not_found', async () => {
    const res = await call(await signAdmin(), 'Get', { name: 'nope' });
    expect(res.status).toBe(404);
  });

  it('List returns bare Page{items}', async () => {
    const token = await signAdmin();
    await call(token, 'Write', { definition: DEF(uniq('l')) });
    const res = await call(token, 'List', { opts: {} });
    expect(res.status).toBe(200);
    const page = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(page.items)).toBe(true);
  });

  it('Update returns { definition } with patched fields', async () => {
    const token = await signAdmin();
    const name = uniq('u');
    await call(token, 'Write', { definition: DEF(name) });
    const res = await call(token, 'Update', { name, patch: { description: 'changed' } });
    expect(res.status).toBe(200);
    expect((await body(res)).definition.description).toBe('changed');
  });
});

describe('AgentRuntime verbs via route (§3.2)', () => {
  it('Spawn a registered definition → { instance }, Status → { instance }, ListInstances → {items}', async () => {
    const token = await signAdmin();
    const name = uniq('rt');
    await call(token, 'Write', { definition: DEF(name) });
    const key = uniq('inst');
    const spawn = await call(token, 'Spawn', {
      request: { definition: name, instanceKey: key },
    });
    expect(spawn.status).toBe(200);
    const spawnBody = (await spawn.json()) as { instance: { instanceId: string } };
    expect(spawnBody.instance.instanceId).toBe(key);

    const status = await call(token, 'Status', { instanceId: key });
    expect(status.status).toBe(200);
    expect((await body(status)).instance.definition).toBe(name);

    const list = await call(token, 'ListInstances', { opts: {} });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { items: { instanceId: string }[] };
    expect(listBody.items.some((i) => i.instanceId === key)).toBe(true);
  });

  it('Spawn(expect) → { instance, correlationId }', async () => {
    const token = await signAdmin();
    const name = uniq('rte');
    await call(token, 'Write', { definition: DEF(name) });
    const res = await call(token, 'Spawn', {
      request: {
        definition: name,
        instanceKey: uniq('k'),
        expect: { correlationId: 'cid-route-1', timeoutMs: 60_000 },
      },
    });
    expect(res.status).toBe(200);
    expect((await body(res)).correlationId).toBe('cid-route-1');
  });

  it('Spawn unregistered definition → 404 not_found', async () => {
    const res = await call(await signAdmin(), 'Spawn', { request: { definition: 'ghost' } });
    expect(res.status).toBe(404);
  });

  it('Terminate → { terminated:true }', async () => {
    const token = await signAdmin();
    const name = uniq('term');
    await call(token, 'Write', { definition: DEF(name) });
    const key = uniq('k');
    await call(token, 'Spawn', { request: { definition: name, instanceKey: key } });
    const res = await call(token, 'Terminate', { instanceId: key, cascade: true });
    expect(res.status).toBe(200);
    expect((await body(res)).terminated).toBe(true);
  });
});
