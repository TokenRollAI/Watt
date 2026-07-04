/**
 * Watt Platform API 客户端核心（M10 Dashboard）——HTBP POST {tool,arguments} 到 /htbp/platform/<module>。
 *
 * 与 CLI（packages/cli/src/client.ts htbpCall）同一 HTBP 调用形态；响应形状真源同为 gateway 路由测试。
 * token：手填 / Root Key 换发（localStorage 持久化——OAuth device flow 留后续）。
 * base URL：可配置（localStorage `watt.base`；默认同源 '' → /htbp/platform/*；开发时可指向 workers.dev）。
 */

const LS_TOKEN = 'watt.token';
const LS_BASE = 'watt.base';

export function getToken(): string {
  return localStorage.getItem(LS_TOKEN) ?? '';
}
export function setToken(token: string): void {
  localStorage.setItem(LS_TOKEN, token);
}
export function clearToken(): void {
  localStorage.removeItem(LS_TOKEN);
}
export function getBase(): string {
  return localStorage.getItem(LS_BASE) ?? '';
}
export function setBase(base: string): void {
  localStorage.setItem(LS_BASE, base.replace(/\/+$/, ''));
}

export interface WattError {
  code: string;
  message: string;
  retryable?: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 统一错误文案：403（权限失败）显示"当前 token 无权限"而非把 WattError 原文抛出；网络错误（status 0）
 * 提示可重试；其余用后端 message。视图层 catch 一律经此，避免 permission_denied 崩溃/裸码泄露。
 */
export function formatError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return '当前 token 无权限（permission denied）';
    if (e.status === 0) return `${e.message}（网络错误，可重试）`;
    return e.message;
  }
  return String(e);
}

/** POST 一个 HTBP 方法到 /htbp/platform/<module>，携带 Bearer token。非 2xx → ApiError（裸 WattError）。 */
export async function htbp<T>(
  module: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const token = getToken();
  if (!token) throw new ApiError('No token set. Paste a Watt token in Settings.', 401);
  const url = `${getBase()}/htbp/platform/${module}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ tool, arguments: args }),
    });
  } catch (cause) {
    throw new ApiError(`Cannot reach ${url}: ${String(cause)}`, 0);
  }
  if (!res.ok) {
    let body: Partial<WattError> = {};
    try {
      body = (await res.json()) as WattError;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(body.message ?? `HTTP ${res.status}`, res.status, body.code);
  }
  return (await res.json()) as T;
}

/**
 * 认证请求原语（非 platform HTBP 面）——供 context 消费面（/htbp/context/*）与 tools 消费面
 * （/htbp/tools/*）的 wrapper 复用：带 Bearer，非 2xx 抛 ApiError（裸 WattError body）。
 */
export async function authedFetch(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const token = getToken();
  if (!token) throw new ApiError('No token set. Paste a Watt token in Settings.', 401);
  const url = `${getBase()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (cause) {
    throw new ApiError(`Cannot reach ${url}: ${String(cause)}`, 0);
  }
  if (!res.ok) {
    let body: Partial<WattError> = {};
    try {
      body = (await res.json()) as WattError;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(body.message ?? `HTTP ${res.status}`, res.status, body.code);
  }
  return res;
}

/** GET /healthz（同 base 根，非 /htbp）——Overview 健康探针。 */
export async function healthz(): Promise<{ ok: boolean; version?: string; service?: string }> {
  const res = await fetch(`${getBase()}/healthz`);
  if (!res.ok) throw new ApiError(`healthz HTTP ${res.status}`, res.status);
  return (await res.json()) as { ok: boolean; version?: string };
}

/** GET /htbp/platform/whoami（非 HTBP POST——便捷读端点，见 gateway routes.ts）。 */
export async function whoami(): Promise<{ principal: string; roles: string[] }> {
  const res = await authedFetch('/htbp/platform/whoami');
  return (await res.json()) as { principal: string; roles: string[] };
}

/** Root Key 换发 admin token（§6.5e）——POST /oauth/root/token；成功返回 token（调用方负责 setToken）。 */
export async function rootExchange(rootKey: string, ttlSec?: number): Promise<string> {
  const res = await fetch(`${getBase()}/oauth/root/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      root_key: rootKey,
      ...(ttlSec !== undefined ? { ttl_sec: ttlSec } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || typeof body.access_token !== 'string') {
    throw new Error(body.error_description ?? body.error ?? `HTTP ${res.status}`);
  }
  return body.access_token;
}
