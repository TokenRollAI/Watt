/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, SELF } from 'cloudflare:test';
import type { AgentDefinition } from '@watt/core';
import { importPrivateJwk, signUserToken, type TokenMeta } from '@watt/core';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agent/agent-registry.ts';
import { resetSeedGuardForTests } from '../src/authz/seed.ts';
import { PLATFORM_KID } from '../src/env.ts';
import {
  TEST_ADMIN_PRINCIPAL,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  TEST_PRIVATE_JWK,
} from './fixtures/test-key.ts';

/**
 * Scheduler（§7）平台面路由集成测试（HTTP 进 → SchedulerHub DO 出，真实 workerd）。
 * 覆盖 POST /htbp/platform/scheduler 的六动词 + Trigger + 鉴权（§6.4d：List/Get=read，
 * Write/Update/Delete/Trigger=manage；platform://scheduler）+ 未知 tool + 无 token 401 + 非 admin 403。
 *
 * 响应形状真源（CLI mock 照此对齐，toolchain §34；无双形态兜底）：
 *   Write → { job }（CronJob）；Get → { job }；List → 裸 { items }；Update → { job }；
 *   Delete → { deleted:true }；Trigger → { eventId }（本次 cron.fired 的 id）。
 *
 * 注：Trigger 会真触发 action（publish 走 event-bus）——测试用 publish action（无 agent/isolate 依赖），
 *   断言 cron.fired + cron.completed 落库（EventStore.List）。
 */

const META: TokenMeta = { issuer: TEST_JWT_ISSUER, audience: TEST_JWT_AUDIENCE };
const BASE = 'https://gateway.test';

let signAdmin: () => Promise<string>;
let signNonAdmin: () => Promise<string>;

const ECHO: AgentDefinition = {
  name: 'echo',
  description: 'echo test agent',
  runtime: 'light',
  entry: { kind: 'do-class', className: 'AgentInstance' },
  grants: [],
  contextNamespaces: [],
  toolScopes: [],
};

beforeAll(async () => {
  const { priv } = await importPrivateJwk(TEST_PRIVATE_JWK, PLATFORM_KID);
  signAdmin = () =>
    signUserToken({ principal: TEST_ADMIN_PRINCIPAL, roles: ['admin'], trace: 'tr-s' }, priv, META);
  signNonAdmin = () => signUserToken({ principal: 'user:bob', roles: ['staff'] }, priv, META);
});

async function clearDb() {
  await env.DB_POLICIES.prepare('DELETE FROM policies').run();
  await env.DB_POLICIES.prepare('DELETE FROM identity_mappings').run();
  await env.DB_EVENTS.prepare('DELETE FROM events').run();
  await env.DB_PROVIDERS.prepare('DELETE FROM agent_definitions').run();
}
beforeEach(async () => {
  await clearDb();
  resetSeedGuardForTests();
  await new AgentRegistry(env.DB_PROVIDERS).write(ECHO);
});

async function call(token: string, tool: string, args: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`${BASE}/htbp/platform/scheduler`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tool, arguments: args }),
  });
}

const PUBLISH_JOB = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  description: 'test cron',
  schedule: '*/5 * * * *',
  enabled: true,
  action: { kind: 'publish', event: { type: 'nightly.tick', payload: { n: 1 } } },
  ...over,
});

describe('POST /htbp/platform/scheduler — Write / Get / List (§7)', () => {
  it('Write registers a cron job (→ { job }), createdBy from claims', async () => {
    const token = await signAdmin();
    const res = await call(token, 'Write', { job: PUBLISH_JOB('c-1') });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: { id: string; createdBy: string; enabled: boolean } };
    expect(body.job.id).toBe('c-1');
    expect(body.job.createdBy).toBe(TEST_ADMIN_PRINCIPAL);
    expect(body.job.enabled).toBe(true);
  });

  it('Write with invalid cron expression → invalid_argument', async () => {
    const token = await signAdmin();
    const res = await call(token, 'Write', {
      job: PUBLISH_JOB('c-bad', { schedule: '99 99 99 99 99' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_argument');
  });

  it('Get returns { job }; List returns bare { items }', async () => {
    const token = await signAdmin();
    await call(token, 'Write', { job: PUBLISH_JOB('c-2') });
    const got = await call(token, 'Get', { jobId: 'c-2' });
    expect(got.status).toBe(200);
    expect(((await got.json()) as { job: { id: string } }).job.id).toBe('c-2');

    const list = await call(token, 'List', {});
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: { id: string }[] };
    expect(body.items.some((j) => j.id === 'c-2')).toBe(true);
  });

  it('Get on unknown job → not_found', async () => {
    const token = await signAdmin();
    const res = await call(token, 'Get', { jobId: 'missing' });
    expect(res.status).toBe(404);
  });

  it('List rejects unknown opts key → invalid_argument (对齐 task List 口径)', async () => {
    const token = await signAdmin();
    // Scheduler List 只支持 limit；filter/cursor 等未声明键必须报错而非静默丢弃。
    const res = await call(token, 'List', { opts: { filter: { state: 'x' } } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_argument');
  });

  it('List accepts limit (声明键透传)', async () => {
    const token = await signAdmin();
    await call(token, 'Write', { job: PUBLISH_JOB('c-lim') });
    const res = await call(token, 'List', { opts: { limit: 10 } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items.some((j) => j.id === 'c-lim')).toBe(true);
  });
});

describe('POST /htbp/platform/scheduler — Update / Delete (§7)', () => {
  it('Update flips enabled → { job }', async () => {
    const token = await signAdmin();
    await call(token, 'Write', { job: PUBLISH_JOB('c-3') });
    const res = await call(token, 'Update', { jobId: 'c-3', patch: { enabled: false } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { job: { enabled: boolean } }).job.enabled).toBe(false);
  });

  it('Update on unknown job → not_found', async () => {
    const token = await signAdmin();
    const res = await call(token, 'Update', { jobId: 'nope', patch: { description: 'x' } });
    expect(res.status).toBe(404);
  });

  it('Delete → { deleted:true } and job gone', async () => {
    const token = await signAdmin();
    await call(token, 'Write', { job: PUBLISH_JOB('c-4') });
    const del = await call(token, 'Delete', { jobId: 'c-4' });
    expect(del.status).toBe(200);
    expect((await del.json()) as { deleted: boolean }).toEqual({ deleted: true });
    const got = await call(token, 'Get', { jobId: 'c-4' });
    expect(got.status).toBe(404);
  });
});

describe('POST /htbp/platform/scheduler — Trigger full chain (§7 fired/completed)', () => {
  it('Trigger publish action → { eventId } + cron.fired/completed traced', async () => {
    const token = await signAdmin();
    await call(token, 'Write', { job: PUBLISH_JOB('c-5') });
    const res = await call(token, 'Trigger', { jobId: 'c-5' });
    expect(res.status).toBe(200);
    const { eventId } = (await res.json()) as { eventId: string };
    expect(typeof eventId).toBe('string');

    // cron.fired 与 cron.completed 双留痕（§7 步骤 1/4）——经 EventStore.List（platform/event List）。
    const listFired = await SELF.fetch(`${BASE}/htbp/platform/event`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: 'List',
        arguments: { opts: { filter: { type: 'cron.fired' } } },
      }),
    });
    const firedItems = ((await listFired.json()) as { items: { id: string }[] }).items;
    expect(firedItems.some((e) => e.id === eventId)).toBe(true);

    const listCompleted = await SELF.fetch(`${BASE}/htbp/platform/event`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: 'List',
        arguments: { opts: { filter: { type: 'cron.completed' } } },
      }),
    });
    const completedItems = ((await listCompleted.json()) as { items: unknown[] }).items;
    expect(completedItems.length).toBeGreaterThanOrEqual(1);
  });

  it('Trigger on unknown job → not_found', async () => {
    const token = await signAdmin();
    const res = await call(token, 'Trigger', { jobId: 'ghost' });
    expect(res.status).toBe(404);
  });
});

describe('POST /htbp/platform/scheduler — authz + protocol (§6.4d / §11.3)', () => {
  it('unknown tool → invalid_argument', async () => {
    const token = await signAdmin();
    const res = await call(token, 'Bogus', {});
    expect(res.status).toBe(400);
  });

  it('missing token → 401', async () => {
    const res = await SELF.fetch(`${BASE}/htbp/platform/scheduler`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'List', arguments: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('non-admin (no manage/read grant) → 403 on Write', async () => {
    const token = await signNonAdmin();
    const res = await call(token, 'Write', { job: PUBLISH_JOB('c-forbidden') });
    expect(res.status).toBe(403);
  });
});
