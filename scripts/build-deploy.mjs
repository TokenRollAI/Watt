#!/usr/bin/env node
/**
 * scripts/build-deploy.mjs — 生成随 npm 包分发的部署产物 packages/cli/deploy/（P5，计划 §P5）。
 *
 * 产物（不进 git；.gitignore packages/cli/deploy）：
 *   deploy/<worker>/worker.js               —— esbuild 预 bundle（wrangler deploy --no-bundle 用）
 *   deploy/<worker>/wrangler.template.jsonc —— 占位符化配置（__NAME_PREFIX__ / __D1_*_ID__ / __KV_*_ID__ / __ROUTES_BLOCK__ / __SERVICES_BLOCK__）
 *   deploy/gateway/migrations(-*)/ SQL     —— 五库 migrations 原文（migrations_dir 相对 wrangler.jsonc）
 *   deploy/dashboard/**                      —— vite dist（Pages deploy 源）
 *
 * esbuild：入口=各包 src/index.ts，external cloudflare 内建 + node 内建，format esm，bundle。
 * 模板生成：读真实 wrangler.jsonc → 替换资源 id 为占位符 → routes/services 段占位符化 → main→worker.js
 *   → blanket `watt-` → `__NAME_PREFIX__-`（资源名/worker 名/service 名派生）。
 *
 * release/init 前必跑此脚本（产物新鲜度靠 release 流程强制 build:deploy 先行）。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const deployDir = resolve(root, 'packages/cli/deploy');

const WORKERS = [
  { name: 'gateway', pkg: 'packages/gateway' },
  { name: 'toolbridge', pkg: 'packages/toolbridge' },
  { name: 'plugin-feishu', pkg: 'packages/plugin-feishu' },
];

// Workers 运行时提供：cloudflare:* 内建 + 全部 node 内建（裸名 + node: 前缀，经 nodejs_compat）。
// 裸名 external 覆盖依赖里 require('path') 一类（如 mime-types）；其余业务依赖照常 bundle。
const NODE_EXTERNAL = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];
const EXTERNAL = ['cloudflare:*', ...NODE_EXTERNAL];

console.log('build:deploy — clean deploy/ …');
rmSync(deployDir, { recursive: true, force: true });
mkdirSync(deployDir, { recursive: true });

// ---- 1. esbuild bundle 三 worker ----------------------------------------------
for (const w of WORKERS) {
  const entry = resolve(root, w.pkg, 'src/index.ts');
  const outfile = join(deployDir, w.name, 'worker.js');
  mkdirSync(dirname(outfile), { recursive: true });
  console.log(`build:deploy — esbuild ${w.name} …`);
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    // Workers 运行时提供：cloudflare:* 内建 + node 内建经 nodejs_compat。其余依赖全 bundle。
    external: EXTERNAL,
    conditions: ['workerd', 'worker', 'browser', 'import', 'module', 'default'],
    mainFields: ['module', 'main'],
    legalComments: 'none',
    logLevel: 'warning',
  });
}

// ---- 2. 生成 wrangler.template.jsonc ------------------------------------------
console.log('build:deploy — generate wrangler templates …');
writeFileSync(
  join(deployDir, 'gateway', 'wrangler.template.jsonc'),
  gatewayTemplate(readFileSync(resolve(root, 'packages/gateway/wrangler.jsonc'), 'utf8')),
);
writeFileSync(
  join(deployDir, 'toolbridge', 'wrangler.template.jsonc'),
  toolbridgeTemplate(readFileSync(resolve(root, 'packages/toolbridge/wrangler.jsonc'), 'utf8')),
);
writeFileSync(
  join(deployDir, 'plugin-feishu', 'wrangler.template.jsonc'),
  pluginTemplate(readFileSync(resolve(root, 'packages/plugin-feishu/wrangler.jsonc'), 'utf8')),
);

// ---- 3. 拷 gateway migrations（保留 migrations_dir 相对名）----------------------
console.log('build:deploy — copy gateway migrations …');
const gwPkg = resolve(root, 'packages/gateway');
for (const d of readdirSync(gwPkg)) {
  if (d === 'migrations' || d.startsWith('migrations-')) {
    cpSync(join(gwPkg, d), join(deployDir, 'gateway', d), { recursive: true });
  }
}

// ---- 4. build + 拷 dashboard dist ---------------------------------------------
console.log('build:deploy — build dashboard (vite) …');
const vite = spawnSync('pnpm', ['--filter', '@watt/dashboard', 'build'], {
  cwd: root,
  stdio: 'inherit',
});
if (vite.status !== 0) {
  console.error('build:deploy — dashboard build failed.');
  process.exit(vite.status ?? 1);
}
cpSync(resolve(root, 'packages/dashboard/dist'), join(deployDir, 'dashboard'), { recursive: true });

console.log(`\nbuild:deploy — done. Artifacts in ${deployDir}`);

// ================================ 模板转换 ======================================

/** 通用：main → worker.js + blanket `watt-` → `__NAME_PREFIX__-`（须在 id/块替换之后调用）。 */
function finalize(src) {
  return src
    .replace(/"main"\s*:\s*"src\/index\.ts"/, '"main": "worker.js"')
    .replaceAll('watt-', '__NAME_PREFIX__-');
}

function gatewayTemplate(src) {
  let s = src;
  // D1 database_id → 占位符（按 database_name 锚定，替换前为原始 watt- 名）。
  const d1 = {
    'watt-policies': '__D1_POLICIES_ID__',
    'watt-providers': '__D1_PROVIDERS_ID__',
    'watt-audit': '__D1_AUDIT_ID__',
    'watt-events': '__D1_EVENTS_ID__',
    'watt-context': '__D1_CONTEXT_ID__',
  };
  for (const [name, ph] of Object.entries(d1)) {
    const re = new RegExp(
      `("database_name"\\s*:\\s*"${name}"\\s*,\\s*"database_id"\\s*:\\s*")[0-9a-f-]{36}(")`,
      'i',
    );
    s = s.replace(re, `$1${ph}$2`);
  }
  // KV id → 占位符（按 binding 锚定）。
  s = s.replace(
    /("binding"\s*:\s*"KV_AUTHZ_CACHE"\s*,\s*"id"\s*:\s*")[0-9a-f]{32}(")/i,
    '$1__KV_AUTHZ_CACHE_ID__$2',
  );
  s = s.replace(
    /("binding"\s*:\s*"KV_TENANTS"\s*,\s*"id"\s*:\s*")[0-9a-f]{32}(")/i,
    '$1__KV_TENANTS_ID__$2',
  );
  // routes 段（workers_dev + routes）→ 占位符（custom domain 可选，render 时决定）。
  s = s.replace(
    /"workers_dev"\s*:\s*true\s*,\s*\n\s*"routes"\s*:\s*\[[\s\S]*?\]\s*,/,
    '__ROUTES_BLOCK__,',
  );
  // services 段 → 占位符（TOOLBRIDGE 常在；FEISHU_PLUGIN 视飞书开关，render 时决定）。
  s = s.replace(/"services"\s*:\s*\[[\s\S]*?\]\s*,/, '__SERVICES_BLOCK__,');
  // assets 目录（R34 单域化）：仓库布局 ../dashboard/dist → init 部署布局 <dir>/dashboard（deploy.ts 拷贝落点）。
  s = s.replace('"directory": "../dashboard/dist"', '"directory": "../dashboard"');
  return finalize(s);
}

function toolbridgeTemplate(src) {
  // TENANTS KV id → 占位符（与 gateway 共享 namespace）。
  const s = src.replace(
    /("binding"\s*:\s*"TENANTS"\s*,\s*"id"\s*:\s*")[0-9a-f]{32}(")/i,
    '$1__KV_TENANTS_ID__$2',
  );
  return finalize(s);
}

function pluginTemplate(src) {
  return finalize(src);
}
