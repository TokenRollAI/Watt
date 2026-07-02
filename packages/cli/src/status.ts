import { CliError, type WattEnv } from './env.ts';

/** healthz 响应形状（对齐 watt-gateway GET /healthz）。 */
export interface HealthzResponse {
  ok: boolean;
  version: string;
  service: string;
}

/** `watt status` 的返回：原始 JSON + 便于人类阅读的摘要。 */
export interface StatusResult {
  raw: HealthzResponse;
}

export interface FetchStatusDeps {
  fetch?: typeof globalThis.fetch;
}

/**
 * `watt status` 核心逻辑：GET ${baseUrl}/healthz。
 * BASE_URL 缺失 → CliError(2)；网络失败或非 2xx → CliError(1)。
 * 依赖注入 fetch 以便单测 mock。
 */
export async function fetchStatus(env: WattEnv, deps: FetchStatusDeps = {}): Promise<StatusResult> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (!env.baseUrl) {
    throw new CliError(
      'WATT_BASE_URL is not set. Export WATT_BASE_URL=<platform base url> and retry.',
      2,
    );
  }

  const url = `${env.baseUrl.replace(/\/+$/, '')}/healthz`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (env.token) {
    headers.authorization = `Bearer ${env.token}`;
  }

  let res: Response;
  try {
    res = await fetchImpl(url, { headers });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new CliError(`Failed to reach ${url}: ${detail}`, 1);
  }

  if (!res.ok) {
    throw new CliError(`Health check failed: ${url} returned HTTP ${res.status}`, 1);
  }

  let raw: HealthzResponse;
  try {
    raw = (await res.json()) as HealthzResponse;
  } catch {
    throw new CliError(`Health check returned non-JSON body from ${url}`, 1);
  }

  return { raw };
}

/** 人类可读摘要文本。 */
export function formatStatusHuman(result: StatusResult): string {
  const { service, version, ok } = result.raw;
  return `${service ?? 'watt'} ${ok ? 'healthy' : 'UNHEALTHY'} (version ${version ?? 'unknown'})`;
}
