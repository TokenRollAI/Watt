/**
 * `watt whoami`：GET /htbp/platform/whoami（Bearer）→ 打印 principal/roles。
 * token 读取顺序：WATT_TOKEN > ~/.watt/credentials.json（见 client.ts）。
 */

import type { HttpDeps } from './client.ts';
import { CliError } from './env.ts';

export interface WhoamiResult {
  principal: string;
  roles: string[];
  traceId: string;
  agent: unknown;
}

export async function whoami(
  base: string,
  token: string,
  deps: HttpDeps = {},
): Promise<WhoamiResult> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const url = `${base}/htbp/platform/whoami`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
  } catch (cause) {
    throw new CliError(
      `Failed to reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
      1,
    );
  }
  if (!res.ok) {
    if (res.status === 401) {
      throw new CliError('Unauthorized (HTTP 401) — token missing/invalid; run `watt login`', 1);
    }
    throw new CliError(`whoami failed: ${url} returned HTTP ${res.status}`, 1);
  }
  return res.json() as Promise<WhoamiResult>;
}

export function formatWhoamiHuman(r: WhoamiResult): string {
  const roles = r.roles.length ? r.roles.join(', ') : '(none)';
  return `principal: ${r.principal}\nroles:     ${roles}`;
}
