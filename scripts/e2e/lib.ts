/**
 * scripts/e2e/lib.ts — 六条 E2E 的公共库（DOD §9：CLI --json 驱动 + 协议事实断言）。
 *
 * 模式来源 scripts/smoke.ts + toolchain-pitfalls：
 * - 网络：base 缺省 workers.dev（勿用 .env 的 WATT_BASE_URL=watt.pdjjq.org，本机 DNS 污染 §11）；
 *   本机代理由调用侧 shell 提供（https_proxy + NODE_USE_ENV_PROXY=1，§28）。
 * - 重试：每个断言步骤经 waitFor 吸收边缘传播窗口（§9）。
 * - exit 分层：0=通过；1=断言失败；2=前置缺失（env/token/种子）。
 * - 消耗门控（LOOP 纪律 3）：@llm 步骤看 E2E_LLM=1、@feishu 步骤看 E2E_FEISHU=1——未开时
 *   走协议降级（如 task signal 代替飞书卡片点击）或 skip 并在 summary 里标注。
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const cliBin = resolve(repoRoot, 'packages', 'cli', 'src', 'bin.ts');

export const DEFAULT_BASE = 'https://watt-gateway.shuaiqijianhao.workers.dev';

export interface E2eEnv {
  base: string;
  token: string;
  llmEnabled: boolean;
  feishuEnabled: boolean;
  testChatId?: string;
}

/** 读取运行环境；缺 token → exit 2（前置缺失）。 */
export function loadEnv(): E2eEnv {
  const base = (process.env.E2E_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, '');
  const token = process.env.WATT_TOKEN?.trim() ?? '';
  if (token.length === 0) {
    console.error(
      'e2e: WATT_TOKEN is not set (sign one via scripts/sign-admin-token.mjs --rotate)',
    );
    process.exit(2);
  }
  return {
    base,
    token,
    llmEnabled: process.env.E2E_LLM === '1',
    feishuEnabled: process.env.E2E_FEISHU === '1',
    testChatId: process.env.E2E_FEISHU_TEST_CHAT_ID?.trim() || undefined,
  };
}

/** 跑一条 watt CLI 命令（--json），解析 stdout 为 JSON。失败抛 CliFailure（stderr 附带）。 */
export class CliFailure extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'CliFailure';
  }
}

export function cli<T = unknown>(env: E2eEnv, args: string[]): T {
  const res = spawnSync('node', [cliBin, ...args, '--json'], {
    env: {
      ...process.env,
      WATT_BASE_URL: env.base,
      WATT_TOKEN: env.token,
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (res.status !== 0) {
    throw new CliFailure(
      `watt ${args.join(' ')} exited ${res.status}`,
      res.status ?? 1,
      res.stderr ?? '',
    );
  }
  const out = (res.stdout ?? '').trim();
  if (out.length === 0) return undefined as T;
  // --json 输出可能是多行 NDJSON（tail）——调用方需要多行时用 cliLines；此处取第一段完整 JSON。
  try {
    return JSON.parse(out) as T;
  } catch {
    // NDJSON：逐行解析取数组。
    const lines = out.split('\n').filter((l) => l.trim().length > 0);
    return lines.map((l) => JSON.parse(l)) as T;
  }
}

/** 原始 Platform API 调用（HTBP POST）——CLI 没有动词的注入面（如入站事件 Publish，§1.7）。 */
export async function htbp<T = unknown>(
  env: E2eEnv,
  module: string,
  tool: string,
  args: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${env.base}/htbp/platform/${module}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token ?? env.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ tool, arguments: args }),
  });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

/** 轮询直到 fn 返回非 undefined（吸收边缘传播/异步推进）；超时抛 AssertionFailure。 */
export async function waitFor<T>(
  what: string,
  fn: () => Promise<T | undefined> | T | undefined,
  opts: { retries?: number; intervalMs?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 20;
  const interval = opts.intervalMs ?? 3000;
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new AssertionFailure(
    `timed out waiting for: ${what}${lastErr !== undefined ? ` (last error: ${String(lastErr)})` : ''}`,
  );
}

export class AssertionFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionFailure';
  }
}

export function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new AssertionFailure(msg);
}

/** 步骤记录器：每步打印 PASS/SKIP，失败抛出由 runE2e 收口。 */
export interface StepLog {
  pass(name: string, detail?: string): void;
  skip(name: string, why: string): void;
}

export function stepLog(prefix: string): StepLog {
  return {
    pass(name, detail) {
      console.log(`${prefix}: PASS ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
    },
    skip(name, why) {
      console.log(`${prefix}: SKIP ${name} — ${why}`);
    },
  };
}

/** E2E 入口收口：断言失败 exit 1、前置缺失 exit 2、其余异常 exit 1。 */
export async function runE2e(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`${name}: OK`);
  } catch (err) {
    if (err instanceof AssertionFailure) {
      console.error(`${name}: FAIL — ${err.message}`);
      process.exit(1);
    }
    if (err instanceof CliFailure) {
      console.error(`${name}: FAIL — ${err.message}\n${err.stderr}`);
      process.exit(1);
    }
    console.error(`${name}: ERROR — ${String(err)}`);
    process.exit(1);
  }
}
