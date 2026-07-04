/**
 * scripts/e2e/index.ts — 六条 E2E 编排入口（DOD §9，`pnpm e2e`）。
 *
 * 用法：
 *   pnpm e2e            # 跑全部已实现条目（未实现的标 TODO 跳过）
 *   pnpm e2e 5 6        # 只跑指定条目
 * 门控（LOOP 纪律 3——真实消耗每轮每 tag 一次）：
 *   E2E_LLM=1     开真实模型步骤（缺省协议降级/SKIP）
 *   E2E_FEISHU=1  开真实飞书步骤（缺省协议降级/SKIP）
 * exit：0=全部通过（含 SKIP）；1=任一条失败；2=前置缺失。
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 六条注册表：已实现的指向脚本；未实现的标 TODO（R29~R31 逐轮补齐）。 */
const SUITE: Record<string, string | null> = {
  '1': resolve(here, 'e2e-1.ts'),
  '2': resolve(here, 'e2e-2.ts'),
  '3': resolve(here, 'e2e-3.ts'),
  '4': null, // R32: 权限对照
  '5': resolve(here, 'e2e-5.ts'),
  '6': resolve(here, 'e2e-6.ts'),
};

const picked = process.argv.slice(2).filter((a) => a in SUITE);
const targets = picked.length > 0 ? picked : Object.keys(SUITE);

let failed = 0;
for (const id of targets) {
  const file = SUITE[id];
  if (file === null || file === undefined) {
    console.log(`e2e-${id}: TODO (not yet implemented — see PROGRESS.md round plan)`);
    continue;
  }
  console.log(`\n=== e2e-${id} ===`);
  const res = spawnSync('node', [file], { stdio: 'inherit', env: process.env });
  if (res.status === 2) {
    console.error(`e2e-${id}: prerequisite missing (exit 2) — aborting suite.`);
    process.exit(2);
  }
  if (res.status !== 0) failed++;
}

if (failed > 0) {
  console.error(`\ne2e: ${failed} of ${targets.length} target(s) FAILED.`);
  process.exit(1);
}
console.log(`\ne2e: all ${targets.length} target(s) passed (TODO items skipped).`);
