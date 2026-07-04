/**
 * init 向导：部署编排（P5，计划 §P5——移植 deploy-all.mjs 的次序 + 参数化前缀 + npx pinned wrangler）。
 *
 * wrangler 经 `npx --yes wrangler@4.107.0`（不把 wrangler 本体进 CLI deps；版本 pin 对齐 toolchain 锚点）。
 * 部署产物已由 build:deploy 预 bundle（worker.js），故 `wrangler deploy --no-bundle`（main: worker.js）。
 *
 * 部署次序（deploy-all.mjs 既定）：toolbridge → plugin-feishu(启用时) → gateway → dashboard(Pages)。
 *   service binding 目标 Worker 必须先于 gateway 存在（同账户 workers.dev 互调被拦截，走 binding）。
 *
 * 所有 spawn 经 Spawner 注入（单测不做真实部署——真验证由人工在真实账户跑）。
 */

/** wrangler 版本锚点（toolchain-pitfalls：锁 4.107.0，对齐 vitest-pool-workers 0.18）。 */
export const WRANGLER_SPEC = 'wrangler@4.107.0';

export interface SpawnResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface SpawnOpts {
  cwd?: string;
  /** 喂 stdin（secret put 用；绝不走 argv）。 */
  input?: string;
  /** 继承 stdio（部署长输出直连终端）；有 input 时忽略。 */
  inherit?: boolean;
}

export type Spawner = (bin: string, args: string[], opts?: SpawnOpts) => SpawnResult;

/** 经 npx 跑 pinned wrangler。 */
export function wrangler(spawn: Spawner, args: string[], opts?: SpawnOpts): SpawnResult {
  return spawn('npx', ['--yes', WRANGLER_SPEC, ...args], opts);
}

/** wrangler whoami（凭据检查，toolchain §5——只用 whoami，不用 /user/tokens/verify）。 */
export function checkAuth(spawn: Spawner): { ok: boolean; detail: string } {
  const res = wrangler(spawn, ['whoami']);
  const out = `${res.stdout}${res.stderr}`;
  return { ok: res.status === 0, detail: out.split('\n').slice(-6).join('\n') };
}

/** `wrangler deploy --no-bundle`（cwd=worker 目录，读其 wrangler.jsonc + worker.js）。 */
export function deployWorker(spawn: Spawner, cwd: string): SpawnResult {
  return wrangler(spawn, ['deploy', '--no-bundle'], { cwd, inherit: true });
}

/** `wrangler d1 migrations apply <db> --remote`（cwd=gateway 目录，读 migrations_dir）。 */
export function applyMigration(spawn: Spawner, gatewayDir: string, dbName: string): SpawnResult {
  return wrangler(spawn, ['d1', 'migrations', 'apply', dbName, '--remote'], {
    cwd: gatewayDir,
    inherit: true,
  });
}

/** `wrangler secret put <name>`（value 经 stdin，绝不走 argv 防 shell history）。 */
export function putSecret(spawn: Spawner, cwd: string, name: string, value: string): SpawnResult {
  return wrangler(spawn, ['secret', 'put', name], { cwd, input: value });
}

/** 幂等确保 Pages 项目存在（已存在报错吞掉——非交互创建，deploy-all.mjs 待办转正）。 */
export function ensurePagesProject(spawn: Spawner, projectName: string): SpawnResult {
  return wrangler(spawn, [
    'pages',
    'project',
    'create',
    projectName,
    '--production-branch',
    'main',
  ]);
}

/** `wrangler pages deploy <dir> --project-name <name>`。 */
export function deployPages(spawn: Spawner, distDir: string, projectName: string): SpawnResult {
  return wrangler(spawn, ['pages', 'deploy', distDir, '--project-name', projectName], {
    inherit: true,
  });
}
