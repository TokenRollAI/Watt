/**
 * `watt login`：RFC 8628 device flow（Proto §6.5d）。
 *
 * 流程：
 *   1. POST /oauth/device/authorize → 打印 user_code + verification_uri（+ admin approve 提示）。
 *   2. 按 interval 轮询 POST /oauth/token（grant_type=device_code）：
 *      - 400 {error:"authorization_pending"} → 继续等；
 *      - 400 {error:"expired_token"} → 报错退出；
 *      - 200 {access_token} → 存 ~/.watt/credentials.json（0600）。
 *   3. `watt login --approve <user_code>`：用当前已有 token 调 /oauth/device/approve（admin 代确认）。
 *
 * sleep / fetch / 凭据写入均可注入，便于单测轮询逻辑。
 */

import { DEVICE_GRANT_TYPE } from '@watt/core';
import { type Credentials, type FsDeps, writeCredentials } from './client.ts';
import { CliError } from './env.ts';

export interface LoginDeps {
  fetch?: typeof globalThis.fetch;
  /** 轮询间隔 sleep（ms），测试可注入即时返回。 */
  sleep?: (ms: number) => Promise<void>;
  /** now()（ms epoch），用于超时判定；测试可注入。 */
  now?: () => number;
  fs?: FsDeps;
  credentialsPath?: string;
  /**
   * device authorize 成功后的结构化回调（授权码等），与人类可读 out() 并行。
   * 供 `--json` 模式产出机器可解析的授权码，避免进度提示被丢弃。
   */
  onDeviceAuthorized?: (auth: DeviceAuthorizeResponse) => void;
}

export interface DeviceAuthorizeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface LoginResult {
  access_token: string;
  token_type: string;
  expires_in: number;
  user_code: string;
  verification_uri: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 发起 device flow 并轮询直到拿到 token（或过期/超时）。
 * out：登录进度提示（人类可读，走 stdout）。
 */
export async function login(
  base: string,
  out: (line: string) => void,
  deps: LoginDeps = {},
): Promise<LoginResult> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());

  // 1. authorize
  let authRes: Response;
  try {
    authRes = await fetchImpl(`${base}/oauth/device/authorize`, { method: 'POST' });
  } catch (cause) {
    throw new CliError(
      `Failed to reach ${base}/oauth/device/authorize: ${cause instanceof Error ? cause.message : String(cause)}`,
      1,
    );
  }
  if (!authRes.ok) {
    throw new CliError(`device authorize failed: HTTP ${authRes.status}`, 1);
  }
  const auth = (await authRes.json()) as DeviceAuthorizeResponse;

  deps.onDeviceAuthorized?.(auth);
  out(`To authorize this device, an admin must approve user code: ${auth.user_code}`);
  out(`  Verification URL: ${auth.verification_uri}`);
  out(`  Or an admin can run: watt login --approve ${auth.user_code}`);
  out(`Waiting for approval (expires in ${auth.expires_in}s)...`);

  // 2. poll /oauth/token
  const intervalMs = Math.max(1, auth.interval) * 1000;
  const deadline = now() + auth.expires_in * 1000;
  for (;;) {
    if (now() >= deadline) {
      throw new CliError('device authorization timed out before approval', 1);
    }
    await sleep(intervalMs);
    let tokenRes: Response;
    try {
      tokenRes = await fetchImpl(`${base}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: auth.device_code,
        }),
      });
    } catch (cause) {
      throw new CliError(
        `Failed to reach ${base}/oauth/token: ${cause instanceof Error ? cause.message : String(cause)}`,
        1,
      );
    }
    if (tokenRes.ok) {
      const token = (await tokenRes.json()) as {
        access_token: string;
        token_type: string;
        expires_in: number;
      };
      const creds: Credentials = {
        access_token: token.access_token,
        token_type: token.token_type,
        base_url: base,
        saved_at: new Date(now()).toISOString(),
      };
      writeCredentials(creds, deps.credentialsPath, deps.fs);
      return {
        access_token: token.access_token,
        token_type: token.token_type,
        expires_in: token.expires_in,
        user_code: auth.user_code,
        verification_uri: auth.verification_uri,
      };
    }
    // 非 2xx：解 OAuth 错误形状（§6.5d：{error:"..."}）。
    const errBody = (await safeJson(tokenRes)) as { error?: string; error_description?: string };
    if (errBody.error === 'authorization_pending') {
      continue; // 未确认，继续轮询
    }
    if (errBody.error === 'expired_token') {
      throw new CliError('device_code expired before approval; run `watt login` again', 1);
    }
    throw new CliError(
      `token exchange failed: ${errBody.error ?? `HTTP ${tokenRes.status}`}${errBody.error_description ? ` (${errBody.error_description})` : ''}`,
      1,
    );
  }
}

/** `watt login --approve <user_code>`：用已有 token 调 approve（admin 代确认）。 */
export async function approveDevice(
  base: string,
  token: string,
  userCode: string,
  principal: string | undefined,
  deps: { fetch?: typeof globalThis.fetch } = {},
): Promise<{ approved: boolean; principal?: string; alreadyApproved?: boolean }> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const body: Record<string, string> = { user_code: userCode };
  if (principal) body.principal = principal;
  let res: Response;
  try {
    res = await fetchImpl(`${base}/oauth/device/approve`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new CliError(
      `Failed to reach ${base}/oauth/device/approve: ${cause instanceof Error ? cause.message : String(cause)}`,
      1,
    );
  }
  if (!res.ok) {
    const detail = (await safeJson(res)) as { message?: string };
    if (res.status === 401) throw new CliError('Unauthorized (HTTP 401) — admin token required', 1);
    if (res.status === 403) throw new CliError('Forbidden (HTTP 403) — admin role required', 1);
    throw new CliError(`approve failed: HTTP ${res.status}: ${detail.message ?? ''}`, 1);
  }
  return res.json() as Promise<{
    approved: boolean;
    principal?: string;
    alreadyApproved?: boolean;
  }>;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/** Root Key 换发 admin token（§6.5e）——POST /oauth/root/token，成功写凭据文件。 */
export async function loginWithRootKey(
  base: string,
  rootKey: string,
  opts: {
    ttlSec?: number;
    fetch?: typeof globalThis.fetch;
    fs?: FsDeps;
    credentialsPath?: string;
  } = {},
): Promise<{ expiresIn: number }> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const res = await fetchImpl(`${base.replace(/\/+$/, '')}/oauth/root/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      root_key: rootKey,
      ...(opts.ttlSec !== undefined ? { ttl_sec: opts.ttlSec } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || typeof body.access_token !== 'string') {
    const detail = body.error_description ?? body.error ?? `HTTP ${res.status}`;
    throw new CliError(`root key exchange failed: ${detail}`, res.status === 401 ? 1 : 2);
  }
  const creds: Credentials = { access_token: body.access_token };
  writeCredentials(creds, opts.credentialsPath, opts.fs);
  return { expiresIn: body.expires_in ?? 0 };
}
