/**
 * Platform API 共享类型（响应形状真源 = gateway 路由测试；与 CLI 各命令文件对齐）。
 * 各视图族扩展的类型放各自 domain 文件（events/agents/tasks/policies/context/tools）。
 */

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
