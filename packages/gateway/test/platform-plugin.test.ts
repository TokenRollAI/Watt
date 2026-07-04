/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, SELF } from 'cloudflare:test';
import { importPrivateJwk, signUserToken, type TokenMeta } from '@watt/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetManageSeedGuardForTests } from '../src/agent/manage/manage-defs.ts';
import { resetSeedGuardForTests } from '../src/authz/seed.ts';
import { PLATFORM_KID } from '../src/env.ts';
import { setRegistrationProbeFetchForTests } from '../src/plugin/plugin-registry.ts';
import { resetPluginSeedGuardForTests } from '../src/plugin/plugin-seed.ts';
import {
  TEST_ADMIN_PRINCIPAL,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  TEST_PRIVATE_JWK,
} from './fixtures/test-key.ts';

/**
 * PluginRegistry 平台面路由集成测试（HTTP 进 → DB_PROVIDERS/D1 出，真实 workerd）。
 * 覆盖 POST /htbp/platform/plugin 四动词 List/Get/Write/Update + Health（§11.1/§11.2）+ 鉴权
 * （§6.4d：List/Get/Health=read，Write/Update=manage；platform://plugin）+ 未知 tool + 401/403。
 *
 * 响应形状真源（CLI mock 照此对齐，toolchain §34）：
 *   List → { items:[PluginManifest] }；Get → { plugin }；Write → { registration }（+ jwksUrl/pluginToken）；
 *   Update → { plugin }；Health → { health:{healthy,detail?} }。内置 webhook/feishu 种子在首请求幂等注册。
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
  // Write 注册探活（§11.1）：按 host 分派的 fake fetch（pool-workers 0.18 无 fetchMock 导出，
  // 走 plugin-registry 的 *ForTests 钩子；SELF.fetch 与测试共享 isolate 模块态，钩子对路由生效）。
  setRegistrationProbeFetchForTests((async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://plugin.example.com')) return new Response('ok', { status: 200 });
    if (url.startsWith('https://dead.example.com')) return new Response('boom', { status: 500 });
    throw new Error(`unreachable host: ${url}`);
  }) as typeof globalThis.fetch);
});

afterAll(() => {
  setRegistrationProbeFetchForTests(undefined);
});

async function clearDb() {
  await env.DB_POLICIES.prepare('DELETE FROM policies').run();
  await env.DB_POLICIES.prepare('DELETE FROM identity_mappings').run();
  await env.DB_PROVIDERS.prepare('DELETE FROM plugin_registrations').run();
}
beforeEach(async () => {
  await clearDb();
  resetSeedGuardForTests();
  resetManageSeedGuardForTests();
  resetPluginSeedGuardForTests();
});

async function call(token: string, tool: string, args: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`${BASE}/htbp/platform/plugin`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tool, arguments: args }),
  });
}

const MANIFEST = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'context-provider' as const,
  interfaceVersion: 'context-provider/v1',
  endpoint: 'https://plugin.example.com',
  auth: { kind: 'platform-token' as const },
  requiredGrants: [{ resources: ['context://feedback/bugs'], actions: ['read', 'write'] }],
  healthPath: '/health',
  enabled: true,
  ...over,
});

let n = 0;
const uniq = (b: string) => `${b}-${n++}`;

describe('POST /htbp/platform/plugin — auth', () => {
  it('no token → 401', async () => {
    const res = await SELF.fetch(`${BASE}/htbp/platform/plugin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'List', arguments: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('non-admin denied Write → 403', async () => {
    const res = await call(await signNonAdmin(), 'Write', { manifest: MANIFEST('x') });
    expect(res.status).toBe(403);
  });

  it('unknown tool → 400', async () => {
    const res = await call(await signAdmin(), 'Bogus', {});
    expect(res.status).toBe(400);
  });

  it('invalid manifest → 400', async () => {
    const res = await call(await signAdmin(), 'Write', { manifest: { id: 'bad' } });
    expect(res.status).toBe(400);
  });
});

describe('PluginRegistry verbs via route (§11.1)', () => {
  it('Write returns { registration } with jwksUrl + pluginToken', async () => {
    const token = await signAdmin();
    const id = uniq('p');
    const w = await call(token, 'Write', { manifest: MANIFEST(id) });
    expect(w.status).toBe(200);
    const body = (await w.json()) as {
      registration: {
        id: string;
        jwksUrl: string;
        platformBaseUrl: string;
        pluginToken: string;
      };
    };
    expect(body.registration.id).toBe(id);
    expect(body.registration.jwksUrl).toContain('/.well-known/jwks.json');
    expect(typeof body.registration.pluginToken).toBe('string');
    expect(body.registration.pluginToken.length).toBeGreaterThan(10);
  });

  it('Write rejects an endpoint that fails the registration health probe → 400, not stored (§11.1)', async () => {
    const token = await signAdmin();
    // fake fetch 对 dead.example.com 探活回 500 → 拒绝注册。
    const id = uniq('dead');
    const res = await call(token, 'Write', {
      manifest: MANIFEST(id, { endpoint: 'https://dead.example.com' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_argument');
    // 未落库、未签 token。
    const g = await call(token, 'Get', { pluginId: id });
    expect(g.status).toBe(404);
  });

  it('Write rejects an unreachable endpoint (fetch throws) → 400 (§11.1)', async () => {
    const token = await signAdmin();
    // fake fetch 对未知 host 抛错 → 探活失败。
    const id = uniq('unreach');
    const res = await call(token, 'Write', {
      manifest: MANIFEST(id, { endpoint: 'https://no-such-host.example.net' }),
    });
    expect(res.status).toBe(400);
  });

  it('Get returns { plugin } (PluginManifest, no built_in leak)', async () => {
    const token = await signAdmin();
    const id = uniq('g');
    await call(token, 'Write', { manifest: MANIFEST(id) });
    const g = await call(token, 'Get', { pluginId: id });
    expect(g.status).toBe(200);
    const body = (await g.json()) as { plugin: Record<string, unknown> };
    expect(body.plugin.id).toBe(id);
    expect('builtIn' in body.plugin).toBe(false);
    expect('pluginToken' in body.plugin).toBe(false);
  });

  it('List returns { items } including seeded built-in channel adapters', async () => {
    const token = await signAdmin();
    await call(token, 'Write', { manifest: MANIFEST(uniq('l')) });
    const res = await call(token, 'List', { opts: {} });
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(Array.isArray(body.items)).toBe(true);
    const ids = body.items.map((i) => i.id);
    // 首请求幂等种子内置 webhook channel adapter（feishu 不再内置种子——经 watt setup feishu 真实注册，P1）。
    expect(ids).toContain('channel-webhook');
  });

  it('List filter kind=channel-adapter returns only channel adapters', async () => {
    const token = await signAdmin();
    await call(token, 'Write', { manifest: MANIFEST(uniq('c')) }); // context-provider
    const res = await call(token, 'List', { opts: { filter: { kind: 'channel-adapter' } } });
    const body = (await res.json()) as { items: Array<{ kind: string }> };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => i.kind === 'channel-adapter')).toBe(true);
  });

  it('List unknown filter key → 400', async () => {
    const res = await call(await signAdmin(), 'List', { opts: { filter: { bogus: 'x' } } });
    expect(res.status).toBe(400);
  });

  it('Update toggles enabled → { plugin }', async () => {
    const token = await signAdmin();
    const id = uniq('u');
    await call(token, 'Write', { manifest: MANIFEST(id) });
    const res = await call(token, 'Update', { pluginId: id, patch: { enabled: false } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugin: { enabled: boolean } };
    expect(body.plugin.enabled).toBe(false);
  });

  it('seed does not resurrect an admin Update on isolate cold start (enabled=false persists)', async () => {
    const token = await signAdmin();
    // 内置 channel-webhook 先由种子建出，管理员将其停用。
    const upd = await call(token, 'Update', {
      pluginId: 'channel-webhook',
      patch: { enabled: false },
    });
    expect(upd.status).toBe(200);
    // 模拟新 isolate 冷启动：清种子 once-guard 后再打任意 platform 请求（触发种子中间件重跑）。
    resetPluginSeedGuardForTests();
    const got = await call(token, 'Get', { pluginId: 'channel-webhook' });
    expect(got.status).toBe(200);
    const body = (await got.json()) as { plugin: { enabled: boolean } };
    expect(body.plugin.enabled).toBe(false);
  });

  it('Update on missing → 404', async () => {
    const res = await call(await signAdmin(), 'Update', {
      pluginId: 'nope',
      patch: { enabled: false },
    });
    expect(res.status).toBe(404);
  });

  it('Update with bad patch key → 400', async () => {
    const token = await signAdmin();
    const id = uniq('u2');
    await call(token, 'Write', { manifest: MANIFEST(id) });
    const res = await call(token, 'Update', { pluginId: id, patch: { bogus: 1 } });
    expect(res.status).toBe(400);
  });

  it('Get on missing → 404', async () => {
    const res = await call(await signAdmin(), 'Get', { pluginId: 'nope' });
    expect(res.status).toBe(404);
  });
});

describe('PluginLifecycle.Health via route (§11.2)', () => {
  it('built-in channel-adapter → healthy ok (no external probe)', async () => {
    const token = await signAdmin();
    const res = await call(token, 'Health', { pluginId: 'channel-webhook' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { health: { healthy: boolean; detail?: string } };
    expect(body.health.healthy).toBe(true);
    expect(body.health.detail).toContain('built-in');
  });

  it('Health on missing → 404', async () => {
    const res = await call(await signAdmin(), 'Health', { pluginId: 'nope' });
    expect(res.status).toBe(404);
  });

  it('Health requires pluginId → 400', async () => {
    const res = await call(await signAdmin(), 'Health', {});
    expect(res.status).toBe(400);
  });
});
