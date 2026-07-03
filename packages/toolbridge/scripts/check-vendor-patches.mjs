#!/usr/bin/env node
/**
 * check-vendor-patches.mjs — vendored 上游 patch 漂移守卫。
 *
 * watt-toolbridge 的 vendor/ 源码整体照抄自上游 TokenRollAI/tool-bridge，唯一偏离是标注
 * `WATT VENDOR PATCH` 的 headless 部署改动（ASSETS 绑定可选：vendor/index.ts 的 fetch 兜底 +
 * vendor/types.d.ts 的 Env.ASSETS?）。重新 vendor（升级上游）时若 patch 被覆盖冲掉，headless
 * 部署会退回上游"必有 ASSETS"假设 → 运行时崩。此脚本锁定 patch 标记数量恒定，冲掉即 CI/verify 红。
 *
 * 期望：vendor 代码内（index.ts + types.d.ts）恰好 EXPECTED_MARKS 处标记。改动 patch 时同步改常量。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const MARK = 'WATT VENDOR PATCH';
const EXPECTED_MARKS = 2;
// vendor 代码内标注 patch 的文件（README 里的说明性提及不算——只查真实源码/类型声明）。
const FILES = ['vendor/index.ts', 'vendor/types.d.ts'];

let total = 0;
for (const rel of FILES) {
  const p = resolve(pkgRoot, rel);
  let src;
  try {
    src = readFileSync(p, 'utf8');
  } catch {
    console.error(`check-vendor-patches: FAILED — ${rel} not found (vendor layout changed?).`);
    process.exit(1);
  }
  const count = src.split(MARK).length - 1;
  total += count;
}

if (total !== EXPECTED_MARKS) {
  console.error(
    `check-vendor-patches: FAILED — expected ${EXPECTED_MARKS} "${MARK}" mark(s) in vendor code,` +
      ` found ${total}. 升级 vendor 时 patch 可能被冲掉；核对 headless ASSETS 改动是否还在，` +
      '确认后同步 EXPECTED_MARKS。',
  );
  process.exit(1);
}

console.log(`check-vendor-patches: OK — ${total} "${MARK}" mark(s) intact.`);
