import { z } from 'zod';

/**
 * Plugin System 类型层（Proto §11.1 PluginRegistry / §11.2 PluginLifecycle）——纯 zod，无 Cloudflare 绑定。
 * gateway 经 @watt/core 消费此 schema（gateway 不得直接 import zod，toolchain-pitfalls §26）。
 *
 * 归属：M11 Plugin System。PluginManifest 是"实现了某接口的可注册部署单元"的注册元数据（§11.1）；
 *   endpoint 是 HTTPS base 或平台内 Worker 的 `binding:<name>` 引用（§11.1 L931-933，非 §0.1 资源 URI）。
 */

// ─── PluginManifest（§11.1 L927-939）─────────────────────────────────────
/** Plugin 类型：对应四个可扩展接口（§11.1 / Architecture M11）。 */
export const pluginKindSchema = z.enum([
  'context-provider',
  'tool-provider',
  'channel-adapter',
  'agent-harness',
]);
export type PluginKind = z.infer<typeof pluginKindSchema>;

/** auth：platform-token（平台自签 JWT，Plugin 经 jwksUrl 验签）或 bearer（manifest secretRef 静态密钥）。 */
export const pluginAuthSchema = z.union([
  z.object({ kind: z.literal('platform-token') }),
  z.object({ kind: z.literal('bearer'), secretRef: z.string() }),
]);
export type PluginAuth = z.infer<typeof pluginAuthSchema>;

/** requiredGrants：Plugin 回调平台所需权限（§11.1；resources=URI[]、actions=string[]）。 */
export const pluginGrantSchema = z.object({
  resources: z.array(z.string()),
  actions: z.array(z.string()),
});
export type PluginGrant = z.infer<typeof pluginGrantSchema>;

/**
 * PluginManifest（§11.1 L927-939）——PluginRegistry List/Get/Write/Update 的持久化面。
 * id 主键；kind 四类；interfaceVersion 如 "context-provider/v1"；endpoint = HTTPS base 或 "binding:<name>"；
 *   healthPath = 探活路径（§11.2 Health）；enabled 挂载开关。
 */
export const pluginManifestSchema = z.object({
  id: z.string(),
  kind: pluginKindSchema,
  interfaceVersion: z.string(),
  endpoint: z.string(),
  auth: pluginAuthSchema,
  requiredGrants: z.array(pluginGrantSchema),
  healthPath: z.string(),
  enabled: z.boolean(),
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

// ─── PluginRegistration（§11.2 L960-967 注册响应，规范性）──────────────────
/**
 * PluginRegistry.Write 成功的注册产物（Plugin 侧凭此完成双向对接）。extends PluginManifest +
 *   platformBaseUrl（回调入口）+ jwksUrl（验签 platform-token）+ pluginToken（回调 Bearer，scope=requiredGrants）。
 * pluginToken 是敏感凭据——仅 Write 响应回传一次，List/Get 不回显（与 ModelProvider.secretRef 同纪律）。
 */
export interface PluginRegistration extends PluginManifest {
  platformBaseUrl: string;
  jwksUrl: string;
  pluginToken: string;
}

// ─── PluginLifecycle（§11.2 L943-955）─────────────────────────────────────
/** Health() 结果（§11.2）——探活；healthy=false 时 detail 载原因。 */
export interface PluginHealth {
  healthy: boolean;
  detail?: string;
}
