// Plugin System 纯逻辑（Proto §11.1 PluginRegistry / §11.2 PluginLifecycle）——无 Cloudflare 绑定。

// 类型层（§11.1 PluginManifest / §11.2 PluginRegistration + PluginHealth）
export {
  type PluginAuth,
  type PluginGrant,
  type PluginHealth,
  type PluginKind,
  type PluginManifest,
  type PluginRegistration,
  pluginAuthSchema,
  pluginGrantSchema,
  pluginKindSchema,
  pluginManifestSchema,
} from './types.ts';
