/**
 * init 向导：部署工作目录与存档读写（P5）。
 *
 * 布局 `~/.watt/deployments/<prefix>/`：
 *   answers.json                 —— 应答存档（无 secret；--resume 续跑源）
 *   gateway/ toolbridge/ plugin-feishu/  —— 各 worker 的 wrangler.jsonc + worker.js + (gateway)migrations*
 *   dashboard/                   —— vite dist（Pages deploy 源）
 *
 * 部署产物来源 = npm 包内 `packages/cli/deploy/`（build:deploy 预生成）。init 把它拷进部署目录并渲染配置。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeploymentState } from './state.ts';

/** 部署工作目录 ~/.watt/deployments/<prefix>/。 */
export function deploymentDir(namePrefix: string, home: string = homedir()): string {
  return join(home, '.watt', 'deployments', namePrefix);
}

/** 应答存档路径。 */
export function answersPath(namePrefix: string, home: string = homedir()): string {
  return join(deploymentDir(namePrefix, home), 'answers.json');
}

/**
 * npm 包内部署产物目录 packages/cli/deploy/（相对本模块：src/init/paths.ts → ../../deploy，
 * bundle 后 dist/bin.js → ./deploy）。允许 env WATT_DEPLOY_ASSETS 覆盖（build:deploy 未跑时的开发路径）。
 */
export function deployAssetsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WATT_DEPLOY_ASSETS) return resolve(env.WATT_DEPLOY_ASSETS);
  const here = dirname(fileURLToPath(import.meta.url));
  // 源码运行：src/init/paths.ts → packages/cli/deploy；bundle 运行：dist/bin.js → dist/../deploy。
  const primary = resolve(here, '..', '..', 'deploy');
  const candidates = [primary, resolve(here, '..', 'deploy')];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return primary;
}

/** fs 注入（测试 mock）。 */
export interface StateFsDeps {
  readFile?: (p: string) => string;
  writeFile?: (p: string, d: string) => void;
  mkdir?: (p: string) => void;
  exists?: (p: string) => boolean;
}

/** 读应答存档（不存在/畸形 → undefined）。 */
export function loadState(
  namePrefix: string,
  home: string = homedir(),
  fs: StateFsDeps = {},
): DeploymentState | undefined {
  const read = fs.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  try {
    return JSON.parse(read(answersPath(namePrefix, home))) as DeploymentState;
  } catch {
    return undefined;
  }
}

/** 写应答存档（0700 目录）。 */
export function saveState(
  state: DeploymentState,
  home: string = homedir(),
  fs: StateFsDeps = {},
): void {
  const mkdirImpl = fs.mkdir ?? ((p: string) => mkdirSync(p, { recursive: true, mode: 0o700 }));
  const writeImpl = fs.writeFile ?? ((p: string, d: string) => writeFileSync(p, d, 'utf8'));
  const path = answersPath(state.namePrefix, home);
  mkdirImpl(dirname(path));
  writeImpl(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** 递归拷贝目录（部署产物 → 部署目录；生产用 node:fs.cpSync）。 */
export function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}
