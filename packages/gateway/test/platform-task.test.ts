/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, introspectWorkflowInstance, SELF } from 'cloudflare:test';
import type { AgentDefinition } from '@watt/core';
import { importPrivateJwk, signUserToken, type TokenMeta } from '@watt/core';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agent/agent-registry.ts';
import { resetSeedGuardForTests } from '../src/authz/seed.ts';
import { PLATFORM_KID } from '../src/env.ts';
import { TaskStore } from '../src/task/task-store.ts';
import {
  TEST_ADMIN_PRINCIPAL,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  TEST_PRIVATE_JWK,
} from './fixtures/test-key.ts';

/**
 * TaskManager（§8）平台面路由集成测试（HTTP 进 → D1/Workflows 出，真实 workerd）。
 * 覆盖 POST /htbp/platform/task 的七动词 + 鉴权（§6.4d：List/Get/ListDefinitions=read，
 * Write/Update/Cancel=manage，Signal=signal；platform://task）+ 未知 tool + 无 token 401 + 非 admin 403。
 *
 * 响应形状真源（CLI mock 照此对齐，toolchain §34；无双形态兜底）：
 *   Write → { task }（TaskInfo）；Get → { task }（TaskDetail）；List → 裸 Page{items}；
 *   Update → { task }；Cancel → { cancelled:true }；Signal → { signalled:true }；
 *   ListDefinitions → 裸 Page{items}（DefinitionInfo）。
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
    signUserToken({ principal: TEST_ADMIN_PRINCIPAL, roles: ['admin'], trace: 'tr-t' }, priv, META);
  signNonAdmin = () => signUserToken({ principal: 'user:bob', roles: ['staff'] }, priv, META);
});

async function clearDb() {
  await env.DB_POLICIES.prepare('DELETE FROM policies').run();
  await env.DB_POLICIES.prepare('DELETE FROM identity_mappings').run();
  await env.DB_EVENTS.prepare('DELETE FROM tasks').run();
  await env.DB_PROVIDERS.prepare('DELETE FROM agent_definitions').run();
}
beforeEach(async () => {
  await clearDb();
  resetSeedGuardForTests();
  await new AgentRegistry(env.DB_PROVIDERS).write(ECHO);
});

async function call(token: string, tool: string, args: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`${BASE}/htbp/platform/task`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tool, arguments: args }),
  });
}

describe('POST /htbp/platform/task — ListDefinitions (§8)', () => {
  it('returns the two deployed templates with checkpoints (kind=deployed)', async () => {
    const token = await signAdmin();
    const res = await call(token, 'ListDefinitions', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { name: string; kind: string; checkpoints: string[] }[];
    };
    const names = body.items.map((d) => d.name).sort();
    expect(names).toEqual(['auto-delivery-lite', 'deep-research']);
    for (const d of body.items) expect(d.kind).toBe('deployed');
    const dr = body.items.find((d) => d.name === 'deep-research');
    expect(dr?.checkpoints).toEqual(['confirm-plan']);
  });
});

describe('POST /htbp/platform/task — Write / Get / List (§8)', () => {
  it('Write starts a task (→ { task } TaskInfo), createdBy from claims', async () => {
    const token = await signAdmin();
    const res = await call(token, 'Write', {
      request: { definition: 'auto-delivery-lite', input: { bug: 'x' }, taskId: 'rt-1' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      task: { taskId: string; definition: string; state: string; createdBy: string };
    };
    expect(body.task.taskId).toBe('rt-1');
    expect(body.task.definition).toBe('auto-delivery-lite');
    expect(body.task.createdBy).toBe(TEST_ADMIN_PRINCIPAL);
  });

  it('Write with unknown definition → invalid_argument', async () => {
    const token = await signAdmin();
    const res = await call(token, 'Write', { request: { definition: 'no-such' } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_argument');
  });

  it('Get returns { task } TaskDetail with steps/artifacts', async () => {
    const token = await signAdmin();
    await call(token, 'Write', { request: { definition: 'auto-delivery-lite', taskId: 'rt-2' } });
    const res = await call(token, 'Get', { taskId: 'rt-2' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      task: { taskId: string; steps: unknown[]; artifacts: unknown[] };
    };
    expect(body.task.taskId).toBe('rt-2');
    expect(Array.isArray(body.task.steps)).toBe(true);
    expect(Array.isArray(body.task.artifacts)).toBe(true);
  });

  it('Get on unknown task → not_found', async () => {
    const token = await signAdmin();
    const res = await call(token, 'Get', { taskId: 'missing' });
    expect(res.status).toBe(404);
  });

  it('List returns bare Page{items} filtered by definition', async () => {
    const token = await signAdmin();
    await call(token, 'Write', { request: { definition: 'auto-delivery-lite', taskId: 'rt-3' } });
    const res = await call(token, 'List', {
      opts: { filter: { definition: 'auto-delivery-lite' } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { taskId: string }[] };
    expect(body.items.some((t) => t.taskId === 'rt-3')).toBe(true);
  });
});

describe('POST /htbp/platform/task — Update / Cancel / Signal (§8)', () => {
  it('Update patches note → { task }', async () => {
    const token = await signAdmin();
    await call(token, 'Write', { request: { definition: 'auto-delivery-lite', taskId: 'rt-4' } });
    const res = await call(token, 'Update', { taskId: 'rt-4', patch: { note: 'hi' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { note: string } };
    expect(body.task.note).toBe('hi');
  });

  it('Cancel → { cancelled:true } and marks task cancelled', async () => {
    const token = await signAdmin();
    await call(token, 'Write', { request: { definition: 'auto-delivery-lite', taskId: 'rt-5' } });
    const res = await call(token, 'Cancel', { taskId: 'rt-5', reason: 'stop' });
    expect(res.status).toBe(200);
    expect((await res.json()) as { cancelled: boolean }).toEqual({ cancelled: true });
    const got = await call(token, 'Get', { taskId: 'rt-5' });
    expect(((await got.json()) as { task: { state: string } }).task.state).toBe('cancelled');
  });

  it('Signal on a non-waiting task → conflict (409, DoD §7)', async () => {
    const token = await signAdmin();
    // Write 立即返回 pending；auto-delivery-lite 快速经 register 到 waiting，但 register-bug 前是
    //   pending/running（非 waiting）——用刚 cancel 的任务确定性地测 conflict。
    await call(token, 'Write', { request: { definition: 'auto-delivery-lite', taskId: 'rt-6' } });
    await call(token, 'Cancel', { taskId: 'rt-6' });
    const res = await call(token, 'Signal', {
      taskId: 'rt-6',
      signal: { checkpoint: 'confirm-release', decision: 'approve' },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('conflict');
  });

  it('Signal on a waiting task → { signalled:true } (200, 响应形状真源)', async () => {
    const token = await signAdmin();
    const taskId = 'rt-sig-ok';
    const store = new TaskStore(env.DB_EVENTS);
    await using instance = await introspectWorkflowInstance(env.WATT_TASK, taskId);
    // R29：locate 改 expect fan-in——本地无 consumer 回送，令其超时以推进到 checkpoint。
    await instance.modify(async (m) => {
      await m.forceEventTimeout({ name: 'await-locate' });
    });
    await call(token, 'Write', { request: { definition: 'auto-delivery-lite', taskId } });
    // 轮询等任务进 waiting_human（以状态表为真源，§8 引擎驱动状态）。
    let waiting = false;
    for (let i = 0; i < 30; i++) {
      const detail = await store.getDetail(taskId);
      if (!('code' in detail) && detail.state === 'waiting_human') {
        waiting = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(waiting).toBe(true);

    const res = await call(token, 'Signal', {
      taskId,
      signal: { checkpoint: 'confirm-release', decision: 'approve' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { signalled: boolean }).toEqual({ signalled: true });
    await instance.waitForStatus('complete');
  }, 15000);
});

describe('POST /htbp/platform/task — authz + protocol (§6.4d / §11.3)', () => {
  it('unknown tool → invalid_argument', async () => {
    const token = await signAdmin();
    const res = await call(token, 'Bogus', {});
    expect(res.status).toBe(400);
  });

  it('missing token → 401', async () => {
    const res = await SELF.fetch(`${BASE}/htbp/platform/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'ListDefinitions', arguments: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('non-admin (no manage/read grant) → 403 on Write', async () => {
    const token = await signNonAdmin();
    const res = await call(token, 'Write', { request: { definition: 'auto-delivery-lite' } });
    expect(res.status).toBe(403);
  });
});
