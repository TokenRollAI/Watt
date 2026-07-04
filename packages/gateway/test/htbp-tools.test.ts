/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import type { TokenClaims } from '@watt/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createHtbpTools } from '../src/agent/harness/htbp-tools.ts';
import type { HarnessTool } from '../src/agent/harness/types.ts';
import { newAuthorizer } from '../src/audit/audit-sink.ts';
import { PolicyStore } from '../src/authz/policy-store.ts';
import { SEED_POLICY } from '../src/authz/seed.ts';
import type { Bindings } from '../src/env.ts';
import { resetSyncStateForTests } from '../src/tools/tool-invoker.ts';
import { ToolRegistry } from '../src/tools/tool-registry.ts';

/**
 * Agent HTBP 工具单测（P2）——vitest-pool-workers 真实 workerd，TOOLBRIDGE 由 vitest.config 的
 * fakeToolBridge 覆盖（忠实上游契约，读 gateway 写入的共享 KV 树，与 tools-proxy.test 同一手法）。
 *
 * 断言协议事实：
 *  - toolScopes 前缀约束：越权 path → 错误对象（不 forward，不抛异常）。
 *  - Check PEP deny → 错误对象（回喂模型，照抄 scheduler-tools deniedResult 模式）。
 *  - htbp_help → describe 结果回喂（resources/endpoint）。
 *  - htbp_call → 上游结果透传（http provider {arguments} 信封被代理拆掉，远端收裸参数）。
 *  - htbp_skill 上游 404/501 → 友好 unavailable 文本（不报错）。
 */

const bindings = env as unknown as Bindings;
const ADMIN_CLAIMS: TokenClaims = { sub: 'user:admin', roles: ['admin'] };
const STAFF_CLAIMS: TokenClaims = { sub: 'user:staff', roles: ['staff'] };

async function clearDb(): Promise<void> {
  await bindings.DB_POLICIES.prepare('DELETE FROM policies').run();
  await bindings.DB_PROVIDERS.prepare('DELETE FROM tool_mounts').run();
}

async function mountEchoHttp(): Promise<void> {
  await new ToolRegistry(bindings.DB_PROVIDERS).write({
    path: 'echo/svc',
    provider: 'http',
    providerConfig: {
      endpoints: [{ name: 'ping', method: 'GET', url: 'https://api.example.com/ping' }],
    },
    enabled: true,
  });
}

/** htbp_help/skill/call 三工具（按名取）。 */
function tools(claims: TokenClaims, scopes: string[]): Record<string, HarnessTool> {
  const list = createHtbpTools({
    env: bindings,
    claims,
    authorizer: newAuthorizer(bindings),
    toolScopes: scopes,
  });
  return Object.fromEntries(list.map((t) => [t.name, t]));
}

beforeEach(async () => {
  await clearDb();
  resetSyncStateForTests();
});

describe('createHtbpTools — 工具集构造', () => {
  it('纯路径 scopes → 三工具；空 scopes → 空数组', () => {
    expect(Object.keys(tools(ADMIN_CLAIMS, ['echo'])).sort()).toEqual([
      'htbp_call',
      'htbp_help',
      'htbp_skill',
    ]);
    expect(
      createHtbpTools({
        env: bindings,
        claims: ADMIN_CLAIMS,
        authorizer: newAuthorizer(bindings),
        toolScopes: [],
      }),
    ).toHaveLength(0);
  });
});

describe('toolScopes 前缀约束（越权拒绝，不 forward）', () => {
  it('path 不在任一 scope 前缀下 → 错误对象', async () => {
    await mountEchoHttp();
    const t = tools(ADMIN_CLAIMS, ['echo']);
    const help = (await t.htbp_help?.execute({ path: 'finance' })) as { error?: string };
    expect(help.error).toContain('not within your allowed tool scopes');
    const call = (await t.htbp_call?.execute({ path: 'finance/reports/query', arguments: {} })) as {
      error?: string;
    };
    expect(call.error).toContain('not within your allowed tool scopes');
  });
});

describe('Check PEP deny → 错误对象（回喂模型）', () => {
  it('scope 内但无 Policy → invoke deny 错误对象', async () => {
    await mountEchoHttp();
    // staff 无任何 Policy（未 seed admin）→ Check(invoke) deny。scope 允许 finance 前缀。
    const t = tools(STAFF_CLAIMS, ['finance']);
    const call = (await t.htbp_call?.execute({
      path: 'finance/reports/query',
      arguments: { limit: 5 },
    })) as { error?: string };
    expect(call.error).toContain('permission denied');
    expect(call.error).toContain('invoke');
  });

  it('help read deny → 错误对象', async () => {
    await mountEchoHttp();
    const t = tools(STAFF_CLAIMS, ['echo']);
    const help = (await t.htbp_help?.execute({ path: 'echo/svc' })) as { error?: string };
    expect(help.error).toContain('permission denied');
  });
});

describe('htbp_help → describe 结果回喂（admin 全放行）', () => {
  it('leaf ~help 返回 endpoint resources', async () => {
    await new PolicyStore(bindings.DB_POLICIES).write(SEED_POLICY);
    await mountEchoHttp();
    const t = tools(ADMIN_CLAIMS, ['echo']);
    const help = (await t.htbp_help?.execute({ path: 'echo/svc' })) as {
      kind?: string;
      resources?: Array<{ path: string }>;
      error?: string;
    };
    expect(help.error).toBeUndefined();
    expect(help.kind).toBe('http');
    expect(help.resources?.map((r) => r.path)).toContain('./ping');
  });
});

describe('htbp_call → 上游结果透传（http 信封拆解）', () => {
  it('http provider：远端收裸参数（{arguments} 被代理拆掉）', async () => {
    await new PolicyStore(bindings.DB_POLICIES).write(SEED_POLICY);
    await mountEchoHttp();
    const t = tools(ADMIN_CLAIMS, ['echo']);
    const res = (await t.htbp_call?.execute({
      path: 'echo/svc/ping',
      arguments: { q: 1 },
    })) as {
      result?: { ok: boolean; kind: string; echo: Record<string, unknown> };
      error?: string;
    };
    expect(res.error).toBeUndefined();
    expect(res.result?.ok).toBe(true);
    expect(res.result?.kind).toBe('http');
    // 信封已拆：远端收到裸 {q:1}，而非 {arguments:{q:1}}（§38 契约）。
    expect(res.result?.echo).toEqual({ q: 1 });
  });
});

describe('htbp_skill 上游未实现 → 友好 unavailable（不报错）', () => {
  it('未知节点 ~skill 404 → unavailable 文本', async () => {
    await new PolicyStore(bindings.DB_POLICIES).write(SEED_POLICY);
    await mountEchoHttp();
    // 'nope' 在 scope 内、admin 有 read 权，但树里无此节点 → 上游 404 not_found → 降级。
    const t = tools(ADMIN_CLAIMS, ['nope']);
    const skill = (await t.htbp_skill?.execute({ path: 'nope' })) as {
      unavailable?: string;
      error?: string;
    };
    expect(skill.error).toBeUndefined();
    expect(skill.unavailable).toContain('~skill');
  });
});
