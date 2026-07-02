/**
 * Watt CLI 平台客户端共享层（token 读取顺序 + HTBP/OAuth 请求 + 凭据落盘）。
 *
 * token 读取顺序（统一）：WATT_TOKEN env > ~/.watt/credentials.json（§8 调研报告 / Architecture M10）。
 * base URL：WATT_BASE_URL env。错误 → CliError（携带退出码），stderr 输出，语义对齐 status 命令。
 *
 * 依赖注入 fetch / 文件读写 / env，便于单测 mock。
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError, type WattEnv } from './env.ts';

/** 凭据文件路径：~/.watt/credentials.json。 */
export function credentialsPath(home: string = homedir()): string {
  return join(home, '.watt', 'credentials.json');
}

export interface Credentials {
  /** 平台签发的 user token（Bearer）。 */
  access_token: string;
  /** token 类型（固定 "Bearer"）。 */
  token_type?: string;
  /** 绑定的 base URL（多环境区分，可选）。 */
  base_url?: string;
  /** 写入时刻 ISO8601。 */
  saved_at?: string;
}

/** 文件系统注入（测试可 mock）。 */
export interface FsDeps {
  readFile?: (path: string) => string;
  writeFile?: (path: string, data: string) => void;
  mkdir?: (path: string) => void;
  chmod?: (path: string, mode: number) => void;
}

/** 读凭据文件（不存在/畸形 → undefined，不抛）。 */
export function readCredentials(
  path: string = credentialsPath(),
  fs: FsDeps = {},
): Credentials | undefined {
  const read = fs.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  try {
    return JSON.parse(read(path)) as Credentials;
  } catch {
    return undefined;
  }
}

/** 写凭据文件（0700 目录 + 0600 文件权限）。 */
export function writeCredentials(
  creds: Credentials,
  path: string = credentialsPath(),
  fs: FsDeps = {},
): void {
  const mkdirImpl = fs.mkdir ?? ((p: string) => mkdirSync(p, { recursive: true, mode: 0o700 }));
  const writeImpl =
    fs.writeFile ?? ((p: string, d: string) => writeFileSync(p, d, { mode: 0o600 }));
  const chmodImpl = fs.chmod ?? ((p: string, m: number) => chmodSync(p, m));
  mkdirImpl(dirname(path));
  writeImpl(path, `${JSON.stringify(creds, null, 2)}\n`);
  // 显式收紧权限（writeFileSync 的 mode 受 umask 影响，chmod 强制 0600）。
  chmodImpl(path, 0o600);
}

/** 解析出可用 token：WATT_TOKEN > credentials.json。缺则返回 undefined。 */
export function resolveToken(
  env: WattEnv,
  path: string = credentialsPath(),
  fs: FsDeps = {},
): string | undefined {
  if (env.token) return env.token;
  return readCredentials(path, fs)?.access_token;
}

/** 要求 base URL，缺失 → CliError(2)（对齐 status 命令语义）。 */
export function requireBaseUrl(env: WattEnv): string {
  if (!env.baseUrl) {
    throw new CliError(
      'WATT_BASE_URL is not set. Export WATT_BASE_URL=<platform base url> and retry.',
      2,
    );
  }
  return env.baseUrl.replace(/\/+$/, '');
}

/** 要求 token，缺失 → CliError(2)。 */
export function requireToken(
  env: WattEnv,
  path: string = credentialsPath(),
  fs: FsDeps = {},
): string {
  const token = resolveToken(env, path, fs);
  if (!token) {
    throw new CliError(
      'Not authenticated. Run `watt login` or set WATT_TOKEN=<token> and retry.',
      2,
    );
  }
  return token;
}

export interface HttpDeps {
  fetch?: typeof globalThis.fetch;
}

/**
 * POST 一个 HTBP 方法调用（`{tool,arguments}`）到 `<base>/htbp/platform/<module>`，带 Bearer。
 * 非 2xx → CliError（401 特判：给出"未认证/无权"提示，退出码 1）。
 */
export async function htbpCall(
  base: string,
  token: string,
  module: string,
  tool: string,
  args: Record<string, unknown>,
  deps: HttpDeps = {},
): Promise<unknown> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const url = `${base}/htbp/platform/${module}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ tool, arguments: args }),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new CliError(`Failed to reach ${url}: ${detail}`, 1);
  }
  if (!res.ok) {
    const detail = await safeErrDetail(res);
    if (res.status === 401) {
      throw new CliError(`Unauthorized (HTTP 401): ${detail}`, 1);
    }
    throw new CliError(`${url} returned HTTP ${res.status}: ${detail}`, 1);
  }
  return res.json();
}

/** 从错误响应体提取可读信息（WattError.message 或原文）。 */
async function safeErrDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
