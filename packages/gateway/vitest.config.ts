import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// vitest-pool-workers 0.18.0 (vitest 4)：Vite 插件形式，在真实 workerd 里跑测试（DOD §1）。
// 复用 wrangler.jsonc 的 Worker 配置；额外注入：
//  - 测试用 WATT_JWT_PRIVATE_JWK / WATT_ADMIN_PRINCIPAL（专用测试密钥，不与生产共用）；
//  - D1 migrations（读 migrations/ 目录，setup 里 applyD1Migrations 建表）。

const here = dirname(fileURLToPath(import.meta.url));

// 测试私钥 fixture（与 test/fixtures/test-key.ts 同源；此处读文件避免 config↔worker 双份维护）。
const testKeyPath = resolve(here, 'test/fixtures/test-key.json');
const testKey = JSON.parse(readFileSync(testKeyPath, 'utf8')) as {
  privateJwk: unknown;
  adminPrincipal: string;
};

const migrations = await readD1Migrations(resolve(here, 'migrations'));
const migrationsEvents = await readD1Migrations(resolve(here, 'migrations-events'));
const migrationsContext = await readD1Migrations(resolve(here, 'migrations-context'));
const migrationsProviders = await readD1Migrations(resolve(here, 'migrations-providers'));

// Fake watt-toolbridge（service binding TOOLBRIDGE）——真实 watt-toolbridge Worker 是独立部署单元
// （packages/toolbridge），本地 vitest 无从加载。此 fake 忠实上游契约：读共享 KV（tenant:<id> 树，
// 由 gateway 代理层 syncTenantTree 写入）→ 按 path 解析 → ~help 返 resources / 调用返 {resource,result}
// / 缺省节点返上游错误形状 {error:{code:'not_found'}}（HTTP 404）。这样"树同步 + 路径重写 + 错误形状
// 转换"被真实穿透（proxy 写 KV，fake 从同一 KV 读回并解析），而非 mock 掉转发。
async function fakeToolBridge(
  request: Request,
  // biome-ignore lint/suspicious/noExplicitAny: miniflare 实例的窄类型由 pool-workers 提供，此处仅取 KV。
  mf: any,
): Promise<Response> {
  const url = new URL(request.url);
  const err = (status: number, code: string, message: string): Response =>
    new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  // 断言路径已被重写为 /htbp/*（非 /htbp/tools/*）——代理契约。
  if (!url.pathname.startsWith('/htbp')) return err(404, 'not_found', 'not a tb path');
  if (url.pathname.startsWith('/htbp/tools'))
    return err(400, 'bad_request', 'path was not rewritten');

  // 从共享 KV 读租户树（proxy 已写入）——fake 与 gateway 共用 KV_TENANTS，故树同步被真实穿透。
  const token = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const kv = await mf.getKVNamespace('KV_TENANTS');
  const mapping = (await kv.get(`apikey:${hash}`, 'json')) as { tenantId?: string } | null;
  if (!mapping?.tenantId) return err(401, 'unauthorized', 'unknown secret key');
  const treeRaw = await kv.get(`tenant:${mapping.tenantId}`);
  if (!treeRaw) return err(404, 'not_found', 'no tenant tree');
  const tree = JSON.parse(treeRaw) as {
    children?: Array<{ id: string; type: string; children?: unknown[] }>;
  };

  const rest = url.pathname.slice('/htbp'.length).replace(/^\/+/, '');
  const segs = rest.split('/').filter((s) => s.length > 0);
  const isHelp = segs[segs.length - 1] === '~help';
  const pathSegs = isHelp ? segs.slice(0, -1) : segs;

  // 解析节点（只走 directory.children，与上游 findNode 一致）。
  // biome-ignore lint/suspicious/noExplicitAny: 树节点是弱类型 JSON，fake 内联解析。
  let node: any = tree;
  for (const seg of pathSegs) {
    const child = node.children?.find((c: { id: string }) => c.id === seg);
    if (!child) return err(404, 'not_found', `No TB resource at '/${pathSegs.join('/')}'.`);
    node = child;
  }

  if (isHelp || request.method === 'GET') {
    // directory / mid-path：resources[] 列子节点（相对 path）。
    const resources = (node.children ?? []).map((c: { id: string; title?: string }) => ({
      name: c.title ?? c.id,
      path: `./${c.id}`,
    }));
    return new Response(
      JSON.stringify({ htbp: 'draft', kind: node.type, title: node.title ?? node.id, resources }),
      {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    );
  }
  if (request.method === 'POST') {
    const input = await request.json().catch(() => ({}));
    return new Response(
      JSON.stringify({
        resource: `/htbp/${pathSegs.join('/')}`,
        result: { ok: true, echo: input },
      }),
      { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
    );
  }
  return err(400, 'method_not_allowed', 'use GET ~help or POST');
}

export default defineConfig({
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
  plugins: [
    cloudflareTest({
      // remoteBindings:false —— 禁用 vitest-pool-workers 的远程代理会话。默认 true 会为无本地
      // 模拟器的绑定（Workers AI）起远程代理，触发多账户非交互选择失败。vector provider 走依赖
      // 注入 fake（测试从不读 env.AI），故本地测试无需远程 AI；Vectorize 仅 WARNING（toolchain §10）。
      remoteBindings: false,
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // DB_CONTEXT（M3 structured provider）本地 D1：wrangler.jsonc 的 D1 marker 段由
        // provision 生成、尚未含 DB_CONTEXT（避免占位 database_id 破坏部署）。测试侧用
        // miniflare.d1Databases 直接注入本地 SQLite（id 任意值，本地不连远端）——本库测试
        // 因此不依赖 wrangler.jsonc D1 绑定。部署前 team-lead 跑 provision 回填真实绑定。
        d1Databases: { DB_CONTEXT: 'watt-context-local' },
        // TOOLBRIDGE service binding：wrangler.jsonc 声明它指向独立 Worker watt-toolbridge，本地
        // 无从加载 → 用 fakeToolBridge 函数覆盖（忠实上游契约，读共享 KV 树，见函数注释）。
        serviceBindings: { TOOLBRIDGE: fakeToolBridge },
        bindings: {
          WATT_JWT_PRIVATE_JWK: JSON.stringify(testKey.privateJwk),
          WATT_ADMIN_PRINCIPAL: testKey.adminPrincipal,
          TEST_MIGRATIONS: migrations,
          TEST_MIGRATIONS_EVENTS: migrationsEvents,
          TEST_MIGRATIONS_CONTEXT: migrationsContext,
          TEST_MIGRATIONS_PROVIDERS: migrationsProviders,
          // webhook adapter 验签 secret（inbound 集成测试；channel settings.verifySecretRef 指向此名）。
          WEBHOOK_SECRET_TEST: 'integration-webhook-secret',
        },
      },
    }),
  ],
});
