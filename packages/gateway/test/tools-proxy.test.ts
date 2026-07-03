/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, SELF } from 'cloudflare:test';
import { importPrivateJwk, signUserToken, type TokenMeta } from '@watt/core';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetSeedGuardForTests } from '../src/authz/seed.ts';
import { PLATFORM_KID } from '../src/env.ts';
import { buildUpstreamTree } from '../src/http/tools-proxy.ts';
import {
  TEST_ADMIN_PRINCIPAL,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  TEST_PRIVATE_JWK,
} from './fixtures/test-key.ts';

/**
 * Tools 消费面代理集成测试（/htbp/tools/* → service binding watt-toolbridge，vitest-pool-workers 真实
 * workerd）。TOOLBRIDGE 由 vitest.config 的 fakeToolBridge 覆盖（忠实上游契约，读 gateway 写入的共享 KV
 * 租户树）。覆盖 §R2 全流水：认证（无 token 401）、Check PEP（无权 403）、List/~help 可见性裁剪
 * （DoD 项 2 Case 4 预演——无权 path 不可见）、错误形状转换（上游 {error} → 裸 WattError）、正常转发
 * （路径重写 /htbp/tools/* → /htbp/* + 树同步 KV 写入 + 调用结果透传）。
 *
 * 树映射真源：buildUpstreamTree（ToolMount[] → 上游树）单测直接断言（无需 workerd）。
 */

const META: TokenMeta = { issuer: TEST_JWT_ISSUER, audience: TEST_JWT_AUDIENCE };
const BASE = 'https://gateway.test';

let signAdmin: () => Promise<string>;
let signScoped: () => Promise<string>;

beforeAll(async () => {
  const { priv } = await importPrivateJwk(TEST_PRIVATE_JWK, PLATFORM_KID);
  signAdmin = () =>
    signUserToken({ principal: TEST_ADMIN_PRINCIPAL, roles: ['admin'], trace: 'tr-t' }, priv, META);
  // scoped 用户：Policy 只授予 tool://echo/* 的 read/invoke，其余 tool 树不可见（Case 4 分流素材）。
  signScoped = () => signUserToken({ principal: 'user:scoped', roles: ['staff'] }, priv, META);
});

async function seedScopedPolicy() {
  // 给 user:scoped 在 tool://echo 子树上 read + invoke（含目录节点 tool://echo 与叶子 tool://echo/svc）。
  // 前缀通配 tool://echo* 覆盖两者；其余 tool:// 树默认拒绝 → 裁剪不可见（Case 4 分流）。
  const now = new Date().toISOString();
  await env.DB_POLICIES.prepare(
    `INSERT INTO policies (id, subject, resource, actions, effect, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      'p-scoped',
      'user:scoped',
      'tool://echo*',
      JSON.stringify(['read', 'invoke']),
      'allow',
      now,
      now,
    )
    .run();
}

async function clearDb() {
  await env.DB_POLICIES.prepare('DELETE FROM policies').run();
  await env.DB_POLICIES.prepare('DELETE FROM identity_mappings').run();
  await env.DB_PROVIDERS.prepare('DELETE FROM tool_mounts').run();
}

async function mountHttp(token: string, path: string): Promise<void> {
  const res = await SELF.fetch(`${BASE}/htbp/platform/tool`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      tool: 'Write',
      arguments: {
        mount: {
          path,
          provider: 'http',
          providerConfig: {
            endpoints: [{ name: 'ping', method: 'GET', url: 'https://api.example.com/ping' }],
          },
          enabled: true,
        },
      },
    }),
  });
  expect(res.status).toBe(200);
}

beforeEach(async () => {
  await clearDb();
  resetSeedGuardForTests();
});

describe('buildUpstreamTree（ToolMount[] → 上游树映射，纯逻辑）', () => {
  it('把 path 斜杠分段成目录树，叶子为 provider 节点', () => {
    const tree = buildUpstreamTree([
      {
        path: 'finance/reports',
        provider: 'mcp',
        providerConfig: { endpoint: 'https://m' },
        enabled: true,
      },
      { path: 'echo/svc', provider: 'http', providerConfig: { endpoints: [] }, enabled: true },
    ]);
    expect(tree.type).toBe('directory');
    const finance = tree.children?.find((c) => c.id === 'finance');
    expect(finance?.type).toBe('directory');
    const reports = finance?.children?.find((c) => c.id === 'reports');
    expect(reports?.type).toBe('mcp');
    expect(reports?.endpoint).toBe('https://m');
  });

  it('跳过 disabled mount', () => {
    const tree = buildUpstreamTree([
      { path: 'a/b', provider: 'http', enabled: false },
      { path: 'c/d', provider: 'http', enabled: true },
    ]);
    expect(tree.children?.some((c) => c.id === 'a')).toBe(false);
    expect(tree.children?.some((c) => c.id === 'c')).toBe(true);
  });

  it('providerConfig 不得覆盖 id/type', () => {
    const tree = buildUpstreamTree([
      {
        path: 'x/y',
        provider: 'http',
        providerConfig: { id: 'evil', type: 'directory' },
        enabled: true,
      },
    ]);
    const leaf = tree.children?.find((c) => c.id === 'x')?.children?.[0];
    expect(leaf?.id).toBe('y');
    expect(leaf?.type).toBe('http');
  });
});

describe('/htbp/tools/* — 认证与 Check PEP', () => {
  it('无 token → 401 裸 WattError', async () => {
    const res = await SELF.fetch(`${BASE}/htbp/tools/echo/svc/~help`, { method: 'GET' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('permission_denied');
  });

  it('无权调用 → 403（scoped 用户调 finance 树，无 Policy）', async () => {
    const admin = await signAdmin();
    await mountHttp(admin, 'finance/reports');
    await seedScopedPolicy();
    const token = await signScoped();
    const res = await SELF.fetch(`${BASE}/htbp/tools/finance/reports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'ping', arguments: {} }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('permission_denied');
  });
});

describe('/htbp/tools/* — 正常转发（路径重写 + 树同步）', () => {
  it('admin ~help 树根：resources 列出已挂载子树（路径已重写）', async () => {
    const admin = await signAdmin();
    await mountHttp(admin, 'echo/svc');
    await mountHttp(admin, 'finance/reports');
    const res = await SELF.fetch(`${BASE}/htbp/tools/~help`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${admin}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resources: Array<{ name: string; path: string }> };
    const ids = body.resources.map((r) => r.path);
    expect(ids).toContain('./echo');
    expect(ids).toContain('./finance');
  });

  it('admin POST 调用：结果透传（fake 回显 {ok,echo}）', async () => {
    const admin = await signAdmin();
    await mountHttp(admin, 'echo/svc');
    const res = await SELF.fetch(`${BASE}/htbp/tools/echo/svc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'ping', arguments: { q: 1 } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { ok: boolean } };
    expect(body.result.ok).toBe(true);
  });
});

describe('/htbp/tools/* — 可见性裁剪（Case 4 预演）', () => {
  it('~help 树根：scoped 用户只见有权子树（finance 被裁剪）', async () => {
    const admin = await signAdmin();
    await mountHttp(admin, 'echo/svc');
    await mountHttp(admin, 'finance/reports');
    await seedScopedPolicy();
    const token = await signScoped();
    const res = await SELF.fetch(`${BASE}/htbp/tools/~help`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resources: Array<{ path: string }> };
    const paths = body.resources.map((r) => r.path);
    expect(paths).toContain('./echo'); // 有 tool://echo/* read
    expect(paths).not.toContain('./finance'); // 无权 → 裁剪不可见
  });
});

describe('/htbp/tools/* — 错误形状转换', () => {
  it('上游 404 not_found → 裸 WattError not_found（HTTP 404）', async () => {
    const admin = await signAdmin();
    // 未挂载任何 mount → 树里无 nope 节点 → 上游 {error:{code:not_found}} 404。
    const res = await SELF.fetch(`${BASE}/htbp/tools/nope/x/~help`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${admin}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; retryable: boolean };
    expect(body.code).toBe('not_found');
    expect(body.retryable).toBe(false);
  });
});
