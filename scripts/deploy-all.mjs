#!/usr/bin/env node
/**
 * scripts/deploy-all.mjs — 从零拉起部署编排（DOD §0 第 4 条：`.env` + `pnpm deploy:all`）。
 *
 * 步骤（幂等）：
 *   1. 从项目根 .env 载入并注入 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN 到子进程
 *      env（已在 process.env 的不覆盖；缺失 fail-fast）——见 scripts/lib/env.mjs。
 *   2. 跑 scripts/provision.mjs 幂等创建/绑定附B storage 资源并回填 wrangler.jsonc
 *      （成本低、幂等；可用 --skip-provision 跳过）。
 *   3. 对 watt-policies 执行 D1 migrations（幂等；从零拉起时必须，否则认证端点 500）。
 *   4. wrangler deploy watt-gateway。
 *
 * 不打印任何秘密值。
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnvWithCfCreds } from './lib/env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const skipProvision = process.argv.includes('--skip-provision');
const skipDashboard = process.argv.includes('--skip-dashboard');

// fix 5：注入 CF 凭据（缺失即 fail-fast），供 provision + wrangler deploy 复用。
const childEnv = childEnvWithCfCreds('deploy-all');

const steps = [];

// fix 6：deploy 前先编排 provision，实现"从零拉起闭环"（DOD §0 第 4 条）。
if (!skipProvision) {
  steps.push({
    name: 'provision附B storage resources (idempotent)',
    cmd: ['node', resolve(here, 'provision.mjs')],
  });
} else {
  console.log('deploy-all: --skip-provision set, skipping resource provisioning.');
}

// fix：从零拉起时 D1 库刚建好是空的，认证内核（watt-policies）需先跑 migrations，
// 否则部署后所有查库的认证端点必然 500。wrangler d1 migrations apply 幂等——已应用
// 的会自动跳过，故每次 deploy:all 都执行是安全的。
// 后续新增含 migrations 的 D1 库时同步扩展此步骤（再 push 一条对应库的 apply）。
steps.push({
  name: 'apply D1 migrations (watt-policies)',
  cmd: [
    'pnpm',
    '--filter',
    '@watt/gateway',
    'exec',
    'wrangler',
    'd1',
    'migrations',
    'apply',
    'watt-policies',
    '--remote',
  ],
});

// watt-events：Event Gateway 存储层（EventStore + ChannelRegistry，Proto §2.4/§2.2）。
// 同 watt-policies 幂等；migrations_dir=migrations-events（wrangler.jsonc DB_EVENTS 绑定）。
steps.push({
  name: 'apply D1 migrations (watt-events)',
  cmd: [
    'pnpm',
    '--filter',
    '@watt/gateway',
    'exec',
    'wrangler',
    'd1',
    'migrations',
    'apply',
    'watt-events',
    '--remote',
  ],
});

// watt-context：Context Layer structured provider 存储（Proto §4.1）。
// 同上幂等；migrations_dir=migrations-context（wrangler.jsonc DB_CONTEXT 绑定，provision 回填）。
steps.push({
  name: 'apply D1 migrations (watt-context)',
  cmd: [
    'pnpm',
    '--filter',
    '@watt/gateway',
    'exec',
    'wrangler',
    'd1',
    'migrations',
    'apply',
    'watt-context',
    '--remote',
  ],
});

// watt-providers：Tool Layer ToolRegistry 存储（tool_mounts 表，Proto §5.2）。
// 同上幂等；migrations_dir=migrations-providers（wrangler.jsonc DB_PROVIDERS 绑定，provision 回填）。
steps.push({
  name: 'apply D1 migrations (watt-providers)',
  cmd: [
    'pnpm',
    '--filter',
    '@watt/gateway',
    'exec',
    'wrangler',
    'd1',
    'migrations',
    'apply',
    'watt-providers',
    '--remote',
  ],
});

// watt-audit：Observability 数据面（AuditLog records + Metrics usage 聚合表，Proto §10）。
// 同上幂等；migrations_dir=migrations-audit（wrangler.jsonc DB_AUDIT 绑定，provision 回填）。R23 新增。
steps.push({
  name: 'apply D1 migrations (watt-audit)',
  cmd: [
    'pnpm',
    '--filter',
    '@watt/gateway',
    'exec',
    'wrangler',
    'd1',
    'migrations',
    'apply',
    'watt-audit',
    '--remote',
  ],
});

// watt-toolbridge：Tool Gateway 部署单元（Proto §5 / Architecture M4）。**必须先于 gateway 部署**——
// gateway 的 service binding TOOLBRIDGE 指向此 Worker，目标 Worker 不存在时 gateway deploy 会失败。
// 无 D1/migrations（树配置走共享 KV watt-tenants，运行时由 gateway 代理层写入）。
steps.push({
  name: 'deploy watt-toolbridge (before gateway; gateway service binding depends on it)',
  cmd: ['pnpm', '--filter', 'watt-toolbridge', 'exec', 'wrangler', 'deploy'],
});

steps.push({
  name: 'deploy watt-gateway',
  cmd: ['pnpm', '--filter', '@watt/gateway', 'exec', 'wrangler', 'deploy'],
});

// watt-dashboard（M10 Management）：静态 React SPA 部署到 Cloudflare Pages。可选（--skip-dashboard 跳过）。
// 先 `pnpm --filter @watt/dashboard build`（Vite → packages/dashboard/dist）再 `wrangler pages deploy`。
// Pages 项目 watt-dashboard 首次部署时 wrangler 会交互式提示创建——CI/非交互场景须先 `wrangler pages
//   project create watt-dashboard --production-branch main`（见报告部署待办）。gateway CORS 已放行 *.pages.dev。
if (!skipDashboard) {
  steps.push({
    name: 'build watt-dashboard (Vite static SPA)',
    cmd: ['pnpm', '--filter', '@watt/dashboard', 'build'],
  });
  steps.push({
    name: 'deploy watt-dashboard (Cloudflare Pages)',
    cmd: [
      'pnpm',
      '--filter',
      '@watt/dashboard',
      'exec',
      'wrangler',
      'pages',
      'deploy',
      'dist',
      '--project-name',
      'watt-dashboard',
    ],
  });
} else {
  console.log('deploy-all: --skip-dashboard set, skipping dashboard build + Pages deploy.');
}

for (const step of steps) {
  console.log(`\n=== ${step.name} ===`);
  const [bin, ...args] = step.cmd;
  const res = spawnSync(bin, args, { stdio: 'inherit', env: childEnv });
  if (res.status !== 0) {
    console.error(`deploy-all: step "${step.name}" failed (exit ${res.status}).`);
    process.exit(res.status ?? 1);
  }
}
console.log('\ndeploy-all: done.');

// gateway 运行时必需 secrets 预检（非阻断警告）：缺了不 fail（部署本身能成，只是运行时端点会崩），
// 但提前提示可省一轮"部署成功→端点 500→查半天"。@llm（ANTHROPIC_API_KEY）为可选，缺仅警告。
// 放在 deploy 之后：wrangler secret list 需 Worker 已存在（首次从零拉起时 Worker 刚由上面部署出来）。
checkGatewaySecrets();

function checkGatewaySecrets() {
  console.log('\n=== check gateway secrets (advisory) ===');
  const res = spawnSync(
    'pnpm',
    ['--filter', '@watt/gateway', 'exec', 'wrangler', 'secret', 'list'],
    { env: childEnv, encoding: 'utf8' },
  );
  if (res.status !== 0) {
    console.warn('deploy-all: could not list gateway secrets (skip check); wrangler output tail:');
    console.warn(`${res.stdout ?? ''}${res.stderr ?? ''}`.split('\n').slice(-8).join('\n'));
    return;
  }
  // secret list 输出可能是 JSON 数组或 name 行；用 substring 匹配名字（避开 env-token banner，§7）。
  const listed = `${res.stdout ?? ''}`;
  const REQUIRED = ['WATT_JWT_PRIVATE_JWK', 'WATT_ADMIN_PRINCIPAL'];
  const OPTIONAL = ['ANTHROPIC_API_KEY', 'FEISHU_APP_ID', 'FEISHU_APP_SECRET'];
  const missingReq = REQUIRED.filter((n) => !listed.includes(n));
  const missingOpt = OPTIONAL.filter((n) => !listed.includes(n));
  if (missingReq.length) {
    console.warn(
      `deploy-all: WARNING — gateway 缺必需 secret: ${missingReq.join(', ')}。` +
        ' 认证端点会 500。补：wrangler secret put <NAME>（见 scripts/gen-jwt-keys.mjs）。',
    );
  }
  if (missingOpt.length) {
    console.warn(
      `deploy-all: note — gateway 缺可选 secret: ${missingOpt.join(', ')}（相关路径不可用：ANTHROPIC_API_KEY→@llm agent，FEISHU_APP_*→飞书出站；非阻断）。`,
    );
  }
  if (!missingReq.length && !missingOpt.length) {
    console.log('deploy-all: gateway secrets present (required + optional).');
  }
}
