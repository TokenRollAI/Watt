/**
 * 既有平台面 typed wrappers（自旧 src/api.ts 原样移植——请求形状已被契约测试锁定）。
 * 新增模块的 wrapper 放各自 domain 文件：events.ts / agents.ts / tasks.ts / policies.ts /
 * context.ts / tools.ts（各视图族 worker 对照 packages/cli/src/<module>.ts 的形状真源实现）。
 */

import { htbp, whoami } from './core.ts';
import type {
  AgentDefinition,
  AgentInstance,
  AuditRecord,
  ChannelConfig,
  CronJob,
  MetricSeries,
  ModelProviderPublic,
  Page,
  PluginHealth,
  PluginManifest,
  SecretMeta,
  TaskInfo,
} from './types.ts';

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
  writeChannel: (channel: Record<string, unknown>) =>
    htbp<{ channel: ChannelConfig }>('channel', 'Write', { channel }),
  // ── PluginRegistry（§11.1/§11.2）——List → {items}；Get → {plugin}；Health → {health}。
  //   注册（plugin Write → {registration}，含仅回传一次的 pluginToken）在 config.ts registerPlugin。
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
  whoami,
};
