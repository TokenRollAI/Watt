/**
 * Watt Platform API 客户端（M10 Dashboard）——HTBP POST {tool,arguments} 到 /htbp/platform/<module>。
 *
 * 与 CLI（packages/cli/src/client.ts）同一 HTBP 调用形态；响应形状真源同为 gateway 路由测试。
 * token：手填（localStorage 持久化，调研报告 §6 已定最小面——OAuth device flow 留后续）。
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

/** GET /healthz（同 base 根，非 /htbp）——Overview 健康探针。 */
export async function healthz(): Promise<{ ok: boolean; version?: string; service?: string }> {
  const res = await fetch(`${getBase()}/healthz`);
  if (!res.ok) throw new ApiError(`healthz HTTP ${res.status}`, res.status);
  return (await res.json()) as { ok: boolean; version?: string };
}

// ─── Typed method wrappers（模块↔接口，对齐 M10 Dashboard 视图↔接口表）──────────────

export interface Page<T> {
  items: T[];
}

export interface AgentDefinition {
  name: string;
  description: string;
  runtime: string;
}
export interface AgentInstance {
  instanceId: string;
  definition: string;
  status: string;
  parent?: string;
}
export interface TaskInfo {
  taskId: string;
  definition: string;
  state: string;
  createdBy?: string;
}
export interface CronJob {
  id: string;
  description: string;
  schedule: string;
  enabled: boolean;
  action: { kind: string; [k: string]: unknown };
  createdBy?: string;
}
export interface AuditRecord {
  id: string;
  at: string;
  context: { principal: string };
  resource: string;
  action: string;
  decision: 'allow' | 'deny';
}
export interface MetricSeries {
  labels: Record<string, string>;
  points: { t: string; v: number }[];
}

export const api = {
  // Agents（AgentRegistry.List + AgentRuntime.ListInstances）
  listAgentDefs: () => htbp<Page<AgentDefinition>>('agent', 'List', { opts: {} }),
  listAgentInstances: () =>
    htbp<Page<AgentInstance>>('agent', 'ListInstances', { opts: { tree: 'all' } }),
  // Tasks（TaskManager.List）
  listTasks: () => htbp<Page<TaskInfo>>('task', 'List', { opts: {} }),
  // Cron（Scheduler.List/Write/Delete）
  listCron: () => htbp<Page<CronJob>>('scheduler', 'List', { opts: {} }),
  createCron: (job: Record<string, unknown>) =>
    htbp<{ job: CronJob }>('scheduler', 'Write', { job }),
  deleteCron: (jobId: string) => htbp<{ deleted: boolean }>('scheduler', 'Delete', { jobId }),
  // Audit（AuditLog.List）
  listAudit: (filter: Record<string, string> = {}, limit = 50) =>
    htbp<Page<AuditRecord>>('audit', 'List', { opts: { filter, limit } }),
  // Metrics（Metrics.Query）
  queryMetric: (metric: string, from: string, to: string) =>
    htbp<{ series: MetricSeries[] }>('metrics', 'Query', {
      query: { metric, range: { from, to } },
    }),
  // whoami（GET /htbp/platform/whoami，token 校验 + principal 展示）
  whoami: () => whoamiGet(),
};

/** GET /htbp/platform/whoami（非 HTBP POST——便捷读端点，见 gateway routes.ts）。 */
async function whoamiGet(): Promise<{ principal: string; roles: string[] }> {
  const token = getToken();
  if (!token) throw new ApiError('No token set. Paste a Watt token in Settings.', 401);
  const res = await fetch(`${getBase()}/htbp/platform/whoami`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!res.ok) throw new ApiError(`whoami HTTP ${res.status}`, res.status);
  return (await res.json()) as { principal: string; roles: string[] };
}
