#!/usr/bin/env node
/**
 * CLI 发行冒烟（release:cli 的 `npm pack` 环节，计划 §P4）。
 *
 * 1. `pnpm pack` 打出 @token-roll/watt tarball（尊重 package.json files 白名单）；
 * 2. 在临时项目里 `npm install <tarball>`（安装 external deps commander/zod/jose，
 *    optionalDependency @larksuiteoapi/node-sdk 缺失不阻塞）；
 * 3. 运行安装后的 `watt --version` / `watt --help` 断言 bundle 依赖闭环、可独立运行。
 *
 * 直接 `node dist/bin.js` 解包裸跑会因 external deps 未安装而 ERR_MODULE_NOT_FOUND——
 *   必须经真实安装才是有效冒烟。真正 publish 由 release:cli 的 `pnpm publish` 环节负责。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../..');
const cliDir = join(repoRoot, 'packages', 'cli');
const packDir = mkdtempSync(join(tmpdir(), 'watt-cli-pack-'));
const projDir = mkdtempSync(join(tmpdir(), 'watt-cli-proj-'));

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

try {
  console.error(`[pack-smoke] packing @token-roll/watt → ${packDir}`);
  sh('pnpm', ['pack', '--pack-destination', packDir], cliDir);
  const tarball = readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('no tarball produced');
  console.error(`[pack-smoke] tarball: ${tarball}`);

  writeFileSync(
    join(projDir, 'package.json'),
    JSON.stringify({ name: 'watt-cli-smoke', private: true }),
  );
  console.error('[pack-smoke] installing tarball into temp project…');
  sh('npm', ['install', '--no-audit', '--no-fund', join(packDir, tarball)], projDir);

  const bin = join(projDir, 'node_modules', '.bin', 'watt');
  const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
  console.error(`[pack-smoke] watt --version → ${version}`);
  if (!/\d+\.\d+\.\d+/.test(version)) throw new Error(`unexpected --version output: ${version}`);
  execFileSync(bin, ['--help'], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'inherit'] });

  console.error('[pack-smoke] OK');
} finally {
  rmSync(packDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
}
