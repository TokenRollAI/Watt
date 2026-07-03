import type { HttpDeps } from './client.ts';
import { CliError, type WattEnv } from './env.ts';
import { metricsQuery, sumSeries } from './metrics.ts';

/** healthz 响应形状（对齐 watt-gateway GET /healthz）。 */
export interface HealthzResponse {
  ok: boolean;
  version: string;
  service: string;
}

/** status 汇总的实时指标（DoD ③：实例数/Task 数/今日 token）。缺 token 时省略。 */
export interface StatusMetrics {
  agentInstances: number;
  tasks: number;
  tokensToday: number;
}

/** `watt status` 的返回：原始 JSON + 便于人类阅读的摘要 + 可选实时指标。 */
export interface StatusResult {
  raw: HealthzResponse;
  metrics?: StatusMetrics;
}

export interface FetchStatusDeps {
  fetch?: typeof globalThis.fetch;
  /** now 注入（测试）：今日 token 窗口起点计算。 */
  now?: () => number;
}

/**
 * `watt status` 核心逻辑：GET ${baseUrl}/healthz。
 * BASE_URL 缺失 → CliError(2)；网络失败或非 2xx → CliError(1)。
 * 依赖注入 fetch 以便单测 mock。
 *
 * R23：token 存在时额外查 Metrics.Query 汇总（agent_instances/tasks 最近 7d + 今日 tokens）——
 *   聚合方式选便宜的（复用 Metrics.Query，不新增专用 status 端点，实现声明）。metrics 查询失败
 *   不影响 healthz 结果（best-effort，缺 token 或查询报错则省略 metrics 段）。
 */
export async function fetchStatus(
  env: WattEnv,
  deps: FetchStatusDeps = {},
  token?: string,
): Promise<StatusResult> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (!env.baseUrl) {
    throw new CliError(
      'WATT_BASE_URL is not set. Export WATT_BASE_URL=<platform base url> and retry.',
      2,
    );
  }

  const base = env.baseUrl.replace(/\/+$/, '');
  const url = `${base}/healthz`;
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

  const result: StatusResult = { raw };
  if (token !== undefined) {
    const metrics = await fetchStatusMetrics(base, token, { fetch: fetchImpl }, deps.now);
    if (metrics !== undefined) result.metrics = metrics;
  }
  return result;
}

/** 查实时指标汇总（best-effort：任一查询失败 → 返回 undefined，不阻塞 status）。 */
async function fetchStatusMetrics(
  base: string,
  token: string,
  httpDeps: HttpDeps,
  now: () => number = Date.now,
): Promise<StatusMetrics | undefined> {
  try {
    const nowMs = now();
    const startOfToday = new Date(new Date(nowMs).toISOString().slice(0, 10)).toISOString();
    const [instances, tasks, tokens] = await Promise.all([
      metricsQuery(base, token, { metric: 'agent_instances', range: '7d' }, httpDeps, now),
      metricsQuery(base, token, { metric: 'tasks', range: '7d' }, httpDeps, now),
      metricsQuery(
        base,
        token,
        { metric: 'tokens', from: startOfToday, to: new Date(nowMs).toISOString() },
        httpDeps,
        now,
      ),
    ]);
    return {
      agentInstances: sumSeries(instances.series),
      tasks: sumSeries(tasks.series),
      tokensToday: sumSeries(tokens.series),
    };
  } catch {
    return undefined;
  }
}

/** 人类可读摘要文本。 */
export function formatStatusHuman(result: StatusResult): string {
  const { service, version, ok } = result.raw;
  let line = `${service ?? 'watt'} ${ok ? 'healthy' : 'UNHEALTHY'} (version ${version ?? 'unknown'})`;
  if (result.metrics !== undefined) {
    const m = result.metrics;
    line += `\n  agent instances (7d): ${m.agentInstances}\n  tasks (7d): ${m.tasks}\n  tokens today: ${m.tokensToday}`;
  }
  return line;
}
