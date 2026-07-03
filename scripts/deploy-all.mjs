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

steps.push({
  name: 'deploy watt-gateway',
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
