#!/usr/bin/env node
/**
 * scripts/smoke.ts — 部署后冒烟检查雏形（DOD §1 通用验收）。
 * 打 ${WATT_BASE_URL}/healthz，断言 200 且返回体含非空 version。
 *
 * 本轮（Phase 0 DoD 项 1）只要求此文件存在且 typecheck 通过；不要求跑通部署。
 * 运行：`node --experimental-strip-types scripts/smoke.ts`（或 `pnpm smoke`）。
 */

interface Healthz {
  ok: boolean;
  version: string;
  service: string;
}

async function main(): Promise<void> {
  const base = process.env.WATT_BASE_URL?.trim();
  if (!base) {
    console.error('smoke: WATT_BASE_URL is not set.');
    process.exit(2);
  }

  const url = `${base.replace(/\/+$/, '')}/healthz`;
  // 新部署的 Worker 边缘传播有短暂窗口（首击可能 500 error code 1104），带重试。
  let res: Response | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      res = await fetch(url, { headers: { accept: 'application/json' } });
      if (res.status === 200) break;
      console.error(`smoke: attempt ${attempt}: HTTP ${res.status}, retrying...`);
    } catch (err) {
      lastError = err;
      console.error(`smoke: attempt ${attempt}: fetch failed (${String(err)}), retrying...`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!res) {
    console.error(`smoke: ${url} unreachable after retries: ${String(lastError)}`);
    process.exit(1);
  }
  if (res.status !== 200) {
    console.error(`smoke: ${url} returned HTTP ${res.status}, expected 200.`);
    process.exit(1);
  }

  const body = (await res.json()) as Healthz;
  if (!body.ok || !body.version) {
    console.error(`smoke: healthz body invalid: ${JSON.stringify(body)}`);
    process.exit(1);
  }

  console.log(`smoke: OK — ${body.service} v${body.version} at ${url}`);
}

await main();

export {};
