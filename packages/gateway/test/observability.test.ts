/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, SELF } from 'cloudflare:test';
import { importPrivateJwk, signUserToken, type TokenMeta } from '@watt/core';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditStore } from '../src/audit/audit-store.ts';
import { resetSeedGuardForTests } from '../src/authz/seed.ts';
import { PLATFORM_KID } from '../src/env.ts';
import { Metrics } from '../src/metrics/metrics.ts';
import { UsageStore } from '../src/metrics/usage-store.ts';
import {
  TEST_ADMIN_PRINCIPAL,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  TEST_PRIVATE_JWK,
} from './fixtures/test-key.ts';

/**
 * Observability 集成测试（R23）——AuditLog 数据面（Check→audit_records→List/Get filter）+ Metrics.Query。
 * PEP 单点收口：每个 Authorizer.check 判定（allow/deny）在 DB_AUDIT 落一条 AuditRecord。
 * vitest-pool-workers 真实 workerd + D1（watt-audit/watt-events 本地 SQLite）。
 */

const META: TokenMeta = { issuer: TEST_JWT_ISSUER, audience: TEST_JWT_AUDIENCE };
const BASE = 'https://gateway.test';

let signAdmin: () => Promise<string>;
let signNonAdmin: () => Promise<string>;

beforeAll(async () => {
  const { priv } = await importPrivateJwk(TEST_PRIVATE_JWK, PLATFORM_KID);
  signAdmin = () =>
    signUserToken(
      { principal: TEST_ADMIN_PRINCIPAL, roles: ['admin'], trace: 'tr-audit' },
      priv,
      META,
    );
  signNonAdmin = () => signUserToken({ principal: 'user:bob', roles: ['staff'] }, priv, META);
});

async function clearDb() {
  await env.DB_POLICIES.prepare('DELETE FROM policies').run();
  await env.DB_POLICIES.prepare('DELETE FROM identity_mappings').run();
  await env.DB_AUDIT.prepare('DELETE FROM audit_records').run();
  await env.DB_AUDIT.prepare('DELETE FROM usage').run();
  await env.DB_EVENTS.prepare('DELETE FROM events').run();
  await env.DB_EVENTS.prepare('DELETE FROM tasks').run();
}
beforeEach(async () => {
  await clearDb();
  resetSeedGuardForTests();
});

function post(path: string, token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('AuditLog data plane (§10) — Check writes a record', () => {
  it('allow decision (admin policy List) lands an allow AuditRecord', async () => {
    const token = await signAdmin();
    await post('/htbp/platform/policy', token, { tool: 'List', arguments: { opts: {} } });

    const list = await post('/htbp/platform/audit', token, {
      tool: 'List',
      arguments: { opts: { filter: { resource: 'platform://policy' } } },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      items: {
        decision: string;
        resource: string;
        action: string;
        context: { principal: string };
      }[];
    };
    const rec = body.items.find((r) => r.resource === 'platform://policy');
    expect(rec).toBeDefined();
    expect(rec?.decision).toBe('allow');
    expect(rec?.action).toBe('read');
    expect(rec?.context.principal).toBe(TEST_ADMIN_PRINCIPAL);
  });

  it('deny decision (non-admin policy Write) lands a deny AuditRecord; filter by decision', async () => {
    const admin = await signAdmin();
    const bob = await signNonAdmin();
    // 非 admin 尝试写 policy → 403 deny（PEP 记 deny 一条）。
    const denied = await post('/htbp/platform/policy', bob, {
      tool: 'Write',
      arguments: {
        policy: {
          id: 'p',
          subject: 'user:x',
          resource: 'tool://a',
          actions: ['invoke'],
          effect: 'allow',
        },
      },
    });
    expect(denied.status).toBe(403);

    // admin 查 audit（filter decision=deny）——应见 bob 的 deny。
    const list = await post('/htbp/platform/audit', admin, {
      tool: 'List',
      arguments: { opts: { filter: { decision: 'deny' } } },
    });
    const body = (await list.json()) as {
      items: { decision: string; context: { principal: string } }[];
    };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((r) => r.decision === 'deny')).toBe(true);
    expect(body.items.some((r) => r.context.principal === 'user:bob')).toBe(true);
  });

  it('rejects an unknown filter key with invalid_argument (400), not silent ignore (§0.2)', async () => {
    const admin = await signAdmin();
    const list = await post('/htbp/platform/audit', admin, {
      tool: 'List',
      arguments: { opts: { filter: { bogus: 'x' } } },
    });
    expect(list.status).toBe(400);
    const body = (await list.json()) as { code: string };
    expect(body.code).toBe('invalid_argument');
  });

  it('filter by principal narrows results', async () => {
    const admin = await signAdmin();
    const bob = await signNonAdmin();
    await post('/htbp/platform/policy', bob, {
      tool: 'Write',
      arguments: {
        policy: {
          id: 'p',
          subject: 'user:x',
          resource: 'tool://a',
          actions: ['invoke'],
          effect: 'allow',
        },
      },
    });
    const list = await post('/htbp/platform/audit', admin, {
      tool: 'List',
      arguments: { opts: { filter: { principal: 'user:bob' } } },
    });
    const body = (await list.json()) as { items: { context: { principal: string } }[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((r) => r.context.principal === 'user:bob')).toBe(true);
  });

  it('Get(recordId) returns the full record; missing → not_found', async () => {
    const token = await signAdmin();
    await post('/htbp/platform/policy', token, { tool: 'List', arguments: { opts: {} } });
    const list = await post('/htbp/platform/audit', token, {
      tool: 'List',
      arguments: { opts: {} },
    });
    const items = ((await list.json()) as { items: { id: string }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    const id = items[0]?.id as string;

    const got = await post('/htbp/platform/audit', token, {
      tool: 'Get',
      arguments: { recordId: id },
    });
    expect(got.status).toBe(200);
    const rec = (await got.json()) as { record: { id: string; context: { traceId: string } } };
    expect(rec.record.id).toBe(id);
    expect(typeof rec.record.context.traceId).toBe('string');

    const miss = await post('/htbp/platform/audit', token, {
      tool: 'Get',
      arguments: { recordId: 'nope' },
    });
    expect(miss.status).toBe(404);
  });

  it('non-admin is denied audit List (403)', async () => {
    const bob = await signNonAdmin();
    const res = await post('/htbp/platform/audit', bob, { tool: 'List', arguments: { opts: {} } });
    expect(res.status).toBe(403);
  });

  it('unknown audit tool → invalid_argument', async () => {
    const token = await signAdmin();
    const res = await post('/htbp/platform/audit', token, { tool: 'Nope', arguments: {} });
    expect(res.status).toBe(400);
  });
});

describe('AuditStore unit (traceId propagation + limit)', () => {
  it('write stores CallContext incl. traceId + agent; limit caps results', async () => {
    const store = new AuditStore(env.DB_AUDIT);
    await store.write({
      context: {
        principal: 'agent:finance',
        roles: ['agent'],
        traceId: 'trace-xyz',
        agent: { instanceId: 'inst-1', chain: ['inst-0', 'inst-1'] },
      },
      resource: 'tool://finance/pay',
      action: 'invoke',
      decision: 'allow',
      detail: { obligations: ['require_confirm'] },
    });
    const page = await store.list({ filter: { agent: 'inst-1' } });
    expect(page.items.length).toBe(1);
    const rec = page.items[0];
    expect(rec?.context.traceId).toBe('trace-xyz');
    expect(rec?.context.agent?.instanceId).toBe('inst-1');
    expect(rec?.detail).toEqual({ obligations: ['require_confirm'] });

    // limit 上限 200：写 3 条同 principal，limit=2 只返回 2。
    for (let i = 0; i < 3; i++) {
      await store.write({
        context: { principal: 'user:z', roles: [], traceId: `t${i}` },
        resource: 'platform://policy',
        action: 'read',
        decision: 'allow',
      });
    }
    const limited = await store.list({ filter: { principal: 'user:z' }, limit: 2 });
    expect(limited.items.length).toBe(2);
  });
});

describe('Metrics.Query (§10)', () => {
  it('metric=tokens sums usage rows; groupBy model splits series', async () => {
    const usage = new UsageStore(env.DB_AUDIT);
    await usage.write({
      provider: 'anthropic',
      model: 'glm-5.2',
      inputTokens: 100,
      outputTokens: 50,
    });
    await usage.write({
      provider: 'anthropic',
      model: 'glm-5.2',
      inputTokens: 10,
      outputTokens: 5,
    });
    await usage.write({
      provider: 'anthropic',
      model: 'minimax-m3',
      inputTokens: 200,
      outputTokens: 100,
    });

    const metrics = new Metrics(env.DB_AUDIT, env.DB_EVENTS);
    const range = { from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z' };

    const total = await metrics.query({ metric: 'tokens', range });
    expect(total.length).toBe(1);
    expect(total[0]?.points[0]?.v).toBe(465); // 150+15+300

    const byModel = await metrics.query({ metric: 'tokens', range, groupBy: ['model'] });
    expect(byModel.length).toBe(2);
    const glm = byModel.find((s) => s.labels.model === 'glm-5.2');
    expect(glm?.points[0]?.v).toBe(165);
  });

  it('metric=agent_instances counts distinct instances', async () => {
    const usage = new UsageStore(env.DB_AUDIT);
    await usage.write({
      provider: 'anthropic',
      model: 'm',
      instance: 'a',
      inputTokens: 1,
      outputTokens: 1,
    });
    await usage.write({
      provider: 'anthropic',
      model: 'm',
      instance: 'a',
      inputTokens: 1,
      outputTokens: 1,
    });
    await usage.write({
      provider: 'anthropic',
      model: 'm',
      instance: 'b',
      inputTokens: 1,
      outputTokens: 1,
    });
    const metrics = new Metrics(env.DB_AUDIT, env.DB_EVENTS);
    const range = { from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z' };
    const res = await metrics.query({ metric: 'agent_instances', range });
    expect(res[0]?.points[0]?.v).toBe(2);
  });

  it('metric=authz_denials counts deny audit records', async () => {
    const audit = new AuditStore(env.DB_AUDIT);
    const ctx = { principal: 'user:x', roles: [], traceId: 't' };
    await audit.write({ context: ctx, resource: 'r', action: 'a', decision: 'deny' });
    await audit.write({ context: ctx, resource: 'r', action: 'a', decision: 'deny' });
    await audit.write({ context: ctx, resource: 'r', action: 'a', decision: 'allow' });
    const metrics = new Metrics(env.DB_AUDIT, env.DB_EVENTS);
    const range = { from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z' };
    const res = await metrics.query({ metric: 'authz_denials', range });
    expect(res[0]?.points[0]?.v).toBe(2);
  });

  it('cache_hit_rate / tool_calls → empty series (not yet wired)', async () => {
    const metrics = new Metrics(env.DB_AUDIT, env.DB_EVENTS);
    const range = { from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z' };
    expect(await metrics.query({ metric: 'cache_hit_rate', range })).toEqual([]);
    expect(await metrics.query({ metric: 'tool_calls', range })).toEqual([]);
  });

  it('route /htbp/platform/metrics Query returns { series }; bad query → invalid_argument', async () => {
    const usage = new UsageStore(env.DB_AUDIT);
    await usage.write({ provider: 'anthropic', model: 'glm-5.2', inputTokens: 7, outputTokens: 3 });
    const token = await signAdmin();
    const res = await post('/htbp/platform/metrics', token, {
      tool: 'Query',
      arguments: {
        query: {
          metric: 'tokens',
          range: { from: '2000-01-01T00:00:00Z', to: '2999-01-01T00:00:00Z' },
        },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { series: { points: { v: number }[] }[] };
    expect(body.series[0]?.points[0]?.v).toBe(10);

    const bad = await post('/htbp/platform/metrics', token, {
      tool: 'Query',
      arguments: { query: { metric: 'nope' } },
    });
    expect(bad.status).toBe(400);
  });

  it('non-admin denied metrics Query (403)', async () => {
    const bob = await signNonAdmin();
    const res = await post('/htbp/platform/metrics', bob, {
      tool: 'Query',
      arguments: { query: { metric: 'tokens', range: { from: 'a', to: 'b' } } },
    });
    expect(res.status).toBe(403);
  });
});
