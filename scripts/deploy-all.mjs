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
const skipPlugins = process.argv.includes('--skip-plugins');

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

// watt-plugin-feishu（M11 channel-adapter plugin，P1 飞书 plugin 化）：独立 Worker，自持回调 + §11.4 出站面。
// **必须先于 gateway 部署**——gateway 的 service binding FEISHU_PLUGIN 指向此 Worker（同账户 workers.dev
// 互调被平台拦截，HTTPS endpoint 不可用，走平台内 Worker 推荐形态）。--skip-plugins 时若 gateway 保留该
// binding 且目标 Worker 从未部署过，gateway deploy 会失败（首次拉起勿跳）。其 secrets（FEISHU_* /
// WATT_PLUGIN_TOKEN / WATT_BASE_URL）由 checkPluginSecrets 单独预检；首次注册用
// `watt setup feishu --endpoint binding:FEISHU_PLUGIN`。
if (!skipPlugins) {
  steps.push({
    name: 'deploy watt-plugin-feishu (before gateway; gateway service binding depends on it)',
    cmd: ['pnpm', '--filter', '@watt/plugin-feishu', 'exec', 'wrangler', 'deploy'],
  });
} else {
  console.log('deploy-all: --skip-plugins set, skipping plugin worker deploys.');
}

// watt-dashboard（M10 Management，R34 单域化）：静态 SPA 经 Workers Static Assets 随 gateway 同 Worker
// 服务（gateway wrangler.jsonc "assets" → ../dashboard/dist）——**必须在 gateway deploy 之前 build**，
// 否则 assets 目录缺失 gateway deploy 失败。独立 Pages 项目 watt-dashboard 已弃用（保留的项目可手动删除）。
steps.push({
  name: 'build watt-dashboard (Vite static SPA; served via gateway Workers Static Assets)',
  cmd: ['pnpm', '--filter', '@watt/dashboard', 'build'],
});

steps.push({
  name: 'deploy watt-gateway (serves /htbp API + dashboard static assets on one domain)',
  cmd: ['pnpm', '--filter', '@watt/gateway', 'exec', 'wrangler', 'deploy'],
});

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
if (!skipPlugins) checkPluginFeishuSecrets();

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
  const REQUIRED = ['WATT_JWT_PRIVATE_JWK', 'WATT_ADMIN_PRINCIPAL', 'WATT_SECRET_ENCRYPTION_KEY'];
  // 飞书凭据已随 P1 迁往 watt-plugin-feishu（见 checkPluginFeishuSecrets）——gateway 不再需要 FEISHU_*。
  const OPTIONAL = ['ANTHROPIC_API_KEY'];
  const missingReq = REQUIRED.filter((n) => !listed.includes(n));
  const missingOpt = OPTIONAL.filter((n) => !listed.includes(n));
  if (missingReq.length) {
    console.warn(
      `deploy-all: WARNING — gateway 缺必需 secret: ${missingReq.join(', ')}。` +
        ' 认证端点会 500（WATT_JWT_PRIVATE_JWK/WATT_ADMIN_PRINCIPAL）；' +
        'WATT_SECRET_ENCRYPTION_KEY 缺则 /htbp/platform/secret 报 unavailable（32B base64url，' +
        "生成：node -e \"process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))\")。" +
        ' 补：wrangler secret put <NAME>（见 scripts/gen-jwt-keys.mjs）。',
    );
  }
  if (missingOpt.length) {
    console.warn(
      `deploy-all: note — gateway 缺可选 secret: ${missingOpt.join(', ')}（相关路径不可用：ANTHROPIC_API_KEY→@llm agent；非阻断）。`,
    );
  }
  if (!missingReq.length && !missingOpt.length) {
    console.log('deploy-all: gateway secrets present (required + optional).');
  }
}

// watt-plugin-feishu 运行时 secrets 预检（非阻断）——飞书渠道逻辑/凭据全在 plugin 侧自持（P1）。
// 加密模式（推荐）：FEISHU_ENCRYPT_KEY；明文模式：FEISHU_VERIFICATION_TOKEN（二者至少其一，缺则来源校验弱）。
function checkPluginFeishuSecrets() {
  console.log('\n=== check watt-plugin-feishu secrets (advisory) ===');
  const res = spawnSync(
    'pnpm',
    ['--filter', '@watt/plugin-feishu', 'exec', 'wrangler', 'secret', 'list'],
    { env: childEnv, encoding: 'utf8' },
  );
  if (res.status !== 0) {
    console.warn('deploy-all: could not list plugin-feishu secrets (skip check); output tail:');
    console.warn(`${res.stdout ?? ''}${res.stderr ?? ''}`.split('\n').slice(-8).join('\n'));
    return;
  }
  const listed = `${res.stdout ?? ''}`;
  // 出站 + 回调必需；入站来源校验（加密 or 明文）二选一。
  const REQUIRED = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'WATT_PLUGIN_TOKEN', 'WATT_BASE_URL'];
  const missingReq = REQUIRED.filter((n) => !listed.includes(n));
  const hasSourceCheck =
    listed.includes('FEISHU_ENCRYPT_KEY') || listed.includes('FEISHU_VERIFICATION_TOKEN');
  if (missingReq.length) {
    console.warn(
      `deploy-all: note — watt-plugin-feishu 缺 secret: ${missingReq.join(', ')}（飞书收发不可用；` +
        ' 补：wrangler secret put <NAME> 到 watt-plugin-feishu，随后 watt setup feishu --endpoint <plugin-url>）。',
    );
  }
  if (!hasSourceCheck) {
    console.warn(
      'deploy-all: note — watt-plugin-feishu 未配 FEISHU_ENCRYPT_KEY（推荐加密模式）或 FEISHU_VERIFICATION_TOKEN（明文模式来源校验）。',
    );
  }
  if (!missingReq.length && hasSourceCheck) {
    console.log('deploy-all: watt-plugin-feishu secrets present.');
  }
}
