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
// （packages/toolbridge），本地 vitest 无从加载。此 fake **忠实复现** vendored 上游 packages/toolbridge/
// vendor/ 的调用语义（逐项对齐，注释标源）：读共享 KV（tenant:<id> 树，由 gateway 代理层 syncTenantTree
// 写入）→ 按 findNode 语义解析节点 + adapter sub 段 → 按节点 type 分派 describe/call。关键忠实点（这些正是
// fake 曾掩盖的契约漂移面）：
//   - findNode（registry.ts）：directory 逐级下钻，走到非 directory 叶子后剩余段是 adapter sub。
//   - http adapter（adapters/http.ts）：call 要求 sub.length>0（endpoint 名），否则上游抛
//     "requires an endpoint name" → 500 internal_error；call 把 input **整包** JSON.stringify 转发到远端
//     URL（不解 {arguments} 信封）。fake 用回显 body 复现"整包转发"，暴露信封是否被代理层拆掉。
//   - mcp/builtin adapter（adapters/mcp.ts / builtin.ts）：call 要求 sub.length>0（工具名），
//     extractArguments 解 {arguments} 信封（或整体当参数）。
//   - directory adapter（adapters/directory.ts）：call 不可调用 → 上游抛 "not callable" → 500。
//   - describe：directory/叶子·无 sub → resources[]（列子节点/端点）；叶子·有 sub → endpoint schema。
//   - 缺省节点 → 上游 NotFoundError → {error:{code:'not_found'}}（HTTP 404）。
// 这样"树同步 + 路径重写 + body 归一化 + 错误形状转换"被真实穿透（proxy 写 KV，fake 从同一 KV 读回并按
// 上游语义解析），而非 mock 掉转发。
//
// 上游 tools/call 的 arguments 信封容忍逻辑（adapters/mcp.ts extractArguments，builtin 同）。
function extractArguments(input: unknown): unknown {
  if (input && typeof input === 'object' && !Array.isArray(input) && 'arguments' in input) {
    return (input as { arguments?: unknown }).arguments ?? {};
  }
  return input ?? {};
}

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
  const tree = JSON.parse(treeRaw) as TbNode;

  const rest = url.pathname.slice('/htbp'.length).replace(/^\/+/, '');
  const segsAll = rest.split('/').filter((s) => s.length > 0);
  const isHelp = segsAll[segsAll.length - 1] === '~help';
  const pathSegs = isHelp ? segsAll.slice(0, -1) : segsAll;

  // findNode（registry.ts）：directory 逐级下钻；走到非 directory 叶子后，剩余段是 adapter sub。
  let node: TbNode = tree;
  let sub: string[] = [];
  for (let i = 0; i < pathSegs.length; i++) {
    if (node.type !== 'directory') {
      sub = pathSegs.slice(i);
      break;
    }
    const child = node.children?.find((c) => c.id === pathSegs[i]);
    if (!child) return err(404, 'not_found', `No TB resource at '/${pathSegs.join('/')}'.`);
    node = child;
  }

  if (isHelp || request.method === 'GET') {
    // describe：directory 或叶子·无 sub → resources[]（列子节点/端点名）；叶子·有 sub → endpoint schema。
    if (node.type === 'directory' || sub.length === 0) {
      const children = node.type === 'directory' ? (node.children ?? []) : endpointRefs(node);
      const resources = children.map((c) => ({ name: c.title ?? c.id, path: `./${c.id}` }));
      return json({ htbp: 'draft', kind: node.type, title: node.title ?? node.id, resources });
    }
    return json({ htbp: 'draft', kind: node.type, endpoint: { method: 'POST' } });
  }
  if (request.method === 'POST') {
    // call：directory 不可调用（directory.ts）；叶子要求 sub.length>0（endpoint/工具名，http.ts/mcp.ts）。
    if (node.type === 'directory') {
      return err(500, 'internal_error', `Directory '${node.id}' is not callable.`);
    }
    if (sub.length === 0) {
      return err(
        500,
        'internal_error',
        `Node '${node.id}' requires an endpoint/tool name to call.`,
      );
    }
    const input = await request.json().catch(() => ({}));
    // http adapter：整包转发 input 到远端（不解信封）——fake 回显整个 input，暴露未拆的 {arguments} 信封。
    // mcp/builtin adapter：extractArguments 解 {arguments} 信封。
    const forwarded = node.type === 'http' ? (input ?? {}) : extractArguments(input);
    return json({
      resource: `/htbp/${pathSegs.join('/')}`,
      result: { ok: true, kind: node.type, echo: forwarded },
    });
  }
  return err(400, 'method_not_allowed', 'use GET ~help or POST');
}

// http 节点的端点作为 describe resources[]（endpoints[].name → ./name）；非 http 叶子无内嵌端点列表。
function endpointRefs(node: TbNode): Array<{ id: string; title?: string }> {
  const endpoints = Array.isArray(node.endpoints) ? node.endpoints : [];
  return endpoints.map((e) => ({ id: String(e.name), title: String(e.name) }));
}

// 上游树节点的弱类型投影（fake 内联解析用；对齐 registry.ts TreeNode 形状的子集）。
interface TbNode {
  type: string;
  id: string;
  title?: string;
  children?: TbNode[];
  endpoints?: Array<{ name: string }>;
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
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
          // @llm 门控透传：workerd 内读不到宿主 process.env，经 binding 注入（缺省空 → 测试 skip）。
          LLM_TESTS: process.env.LLM_TESTS ?? '',
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
          ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? '',
          ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? '',
        },
      },
    }),
  ],
});
