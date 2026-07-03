/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { app } from '../src/index.ts';

/**
 * Gateway 穿透测试（unit + 第一条 integration：HTTP 进 → 响应出）。
 * 在真实 workerd 里经 SELF fetch 打 Worker（DOD §2 Phase 0 DoD 项 1）。
 * onError 500 用例：模块顶层（首个请求前、Hono matcher 未构建时）挂一条测试专用抛错路由，
 * 复用真实 app 的 onError；不经 SELF、不进生产路由表。
 */

// 顶层注册（在任何 SELF.fetch 触发 matcher 构建之前）。
app.get('/__test_boom', () => {
  throw new Error('boom: secret internal detail');
});

describe('GET /healthz', () => {
  it('returns 200 with a non-empty version and service name', async () => {
    const res = await SELF.fetch('https://gateway.test/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      version: string;
      service: string;
    };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('watt-gateway');
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });
});

describe('POST /channels/:channelId/inbound', () => {
  it('returns 404 bare WattError for an unknown channel (real inbound endpoint)', async () => {
    // Phase 2：占位已替换为真实端点；未配置的 channel → 404 not_found（见 http/inbound.ts）。
    // 全链集成用例在 integration-event-flow.test.ts。
    const res = await SELF.fetch('https://gateway.test/channels/feishu-main/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      code: string;
      message: string;
      retryable: boolean;
    };
    expect(body.code).toBe('not_found');
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
    expect(body.retryable).toBe(false);
  });
});

describe('notFound / onError bare WattError contract (§0.2 / §11.3)', () => {
  it('unknown path returns 404 bare WattError not_found', async () => {
    const res = await SELF.fetch('https://gateway.test/no/such/route');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; retryable: boolean };
    expect(body.code).toBe('not_found');
    expect(body.retryable).toBe(false);
  });

  it('specified-but-unimplemented tree path returns 501 unavailable', async () => {
    // /htbp/platform/agent 属 §11.3a 规范树，但 Phase 1 未落地 → 501。
    const res = await SELF.fetch('https://gateway.test/htbp/platform/agent', { method: 'POST' });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string; retryable: boolean };
    expect(body.code).toBe('unavailable');
    expect(body.retryable).toBe(false);
  });

  it('remaining unimplemented platform subtrees (task/scheduler) still return 501 unavailable', async () => {
    for (const path of ['/htbp/platform/task', '/htbp/platform/scheduler']) {
      const res = await SELF.fetch(`https://gateway.test${path}`, { method: 'POST' });
      expect(res.status).toBe(501);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('unavailable');
    }
  });

  it('tools subtree is live (Phase 4): no longer 501; unauthenticated → 401', async () => {
    // /htbp/tools/* 已落地（toolsProxyRoutes 代理），从 501 占位表移除 → 无 token 时走认证 401。
    const res = await SELF.fetch('https://gateway.test/htbp/tools/finance/foo', { method: 'POST' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('permission_denied');
  });

  it('an uncaught handler exception returns 500 internal (bare WattError, no leak)', async () => {
    // /__test_boom 已在模块顶层注册（真实 app、真实 onError）。
    const res = await SELF.fetch('https://gateway.test/__test_boom');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; message: string; retryable: boolean };
    expect(body.code).toBe('internal');
    expect(body.retryable).toBe(true);
    expect(body.message).not.toContain('secret');
  });
});
