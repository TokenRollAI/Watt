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
  /** §3.2 四态（gateway ListInstances 返回字段名为 state，非 status——形状真源 gateway 路由测试）。 */
  state: string;
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

// ─── P6 配置面类型（SecretStore / ChannelRegistry / PluginRegistry / ModelProviderRegistry）────

/** SecretStore.List/Get 元数据（§6.6，永不含明文）。updatedAt env-only 影子名为 null。 */
export interface SecretMeta {
  name: string;
  updatedAt: string | null;
  shadowedByEnv: boolean;
}
/** ChannelConfig（§2.2）——settings 不透明对象。 */
export interface ChannelConfig {
  id: string;
  adapter: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  defaultAgent?: string;
}
/** PluginManifest（§11.1）——List/Get 投影（无 built_in/pluginToken）。 */
export interface PluginManifest {
  id: string;
  kind: string;
  interfaceVersion: string;
  endpoint: string;
  auth: { kind: string; secretRef?: string };
  requiredGrants: { resources: string[]; actions: string[] }[];
  healthPath: string;
  enabled: boolean;
}
/** PluginLifecycle.Health（§11.2）。 */
export interface PluginHealth {
  healthy: boolean;
  detail?: string;
}
/** ModelProviderPublic（§9）——List/Get 脱敏投影**不含 secretRef**（永不回显）。 */
export interface ModelProviderPublic {
  id: string;
  vendor: string;
  models: string[];
  priority: number;
  default: boolean;
  enabled: boolean;
}

export const api = {
  // Agents（AgentRegistry.List + AgentRuntime.ListInstances）
  listAgentDefs: () => htbp<Page<AgentDefinition>>('agent', 'List', { opts: {} }),
  // ListInstances 全列语义 = opts 不带 tree（tree=<instanceId> 是「该实例的派生子树」，
  //   传 tree:'all' 会对不存在的 rootId 恒返回 []——Proto §3.2 / gateway agent-runtime.ts）。
  listAgentInstances: () => htbp<Page<AgentInstance>>('agent', 'ListInstances', { opts: {} }),
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
  // ── SecretStore（§6.6）——List/Write/Delete。**args 直取 name/value（非 opts 信封）**，
  //   响应永不含明文：List → items[{name,updatedAt,shadowedByEnv}]；Write → {secret:{name,updatedAt}}；
  //   Delete → {deleted}。value 提交后视图层立即清空 state（不入日志/不回显）。
  listSecrets: () => htbp<Page<SecretMeta>>('secret', 'List', {}),
  writeSecret: (name: string, value: string) =>
    htbp<{ secret: { name: string; updatedAt: string } }>('secret', 'Write', { name, value }),
  deleteSecret: (name: string) => htbp<{ deleted: boolean }>('secret', 'Delete', { name }),
  // ── ChannelRegistry（§2.2）——List → 裸 Page{items}；Update → {channel}（patch=局部字段）。
  listChannels: () => htbp<Page<ChannelConfig>>('channel', 'List', { opts: {} }),
  updateChannel: (channelId: string, patch: Record<string, unknown>) =>
    htbp<{ channel: ChannelConfig }>('channel', 'Update', { channelId, patch }),
  // ── PluginRegistry（§11.1/§11.2）——List → {items}；Get → {plugin}；Health → {health}。
  listPlugins: () => htbp<Page<PluginManifest>>('plugin', 'List', { opts: {} }),
  getPlugin: (pluginId: string) => htbp<{ plugin: PluginManifest }>('plugin', 'Get', { pluginId }),
  pluginHealth: (pluginId: string) =>
    htbp<{ health: PluginHealth }>('plugin', 'Health', { pluginId }),
  // ── ModelProviderRegistry（§9）——List → 裸 Page{items}（脱敏，无 secretRef）；
  //   Write/Update/SetDefault → {provider}。Write 需完整 provider（含 secretRef）。
  listProviders: () => htbp<Page<ModelProviderPublic>>('provider', 'List', { opts: {} }),
  writeProvider: (provider: Record<string, unknown>) =>
    htbp<{ provider: ModelProviderPublic }>('provider', 'Write', { provider }),
  updateProvider: (providerId: string, patch: Record<string, unknown>) =>
    htbp<{ provider: ModelProviderPublic }>('provider', 'Update', { providerId, patch }),
  setDefaultProvider: (providerId: string) =>
    htbp<{ provider: ModelProviderPublic }>('provider', 'SetDefault', { providerId }),
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
