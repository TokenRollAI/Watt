-- Migration 0004: PluginRegistry 注册表（Proto §11.1 PluginRegistry / §11.2 PluginLifecycle）。
-- 库：watt-providers（binding DB_PROVIDERS），与 0001~0003（tool/agent/model registry）同库、以表名隔离。
--
-- 归属说明（实现自由决策，注释声明理由，对齐 0002_agent_registry.sql）：
--   PluginRegistry（M11）与 ToolRegistry（M4）、AgentRegistry（M2）、ModelProviderRegistry（M8）同属
--   "平台可挂载/注册的能力提供方"语义簇——Plugin 就是"实现了某接口的可注册部署单元"（Architecture M11）。
--   复用 watt-providers 库而非为单表新增 D1 库（多库拆分决策见 memory/decisions/resource-naming-and-provision.md）。
--   四张表以表名隔离（tool_mounts / agent_definitions / model_providers / plugin_registrations），互不干扰。
--
-- plugin_registrations：PluginRegistry 四动词 List/Get/Write/Update 的持久化面（§11.1 L919-925）。
--   主键 id（PluginManifest.id，唯一，如 "feishu-main"）；kind 四类（channel-adapter 等）；
--   auth/required_grants 以 JSON 字符串存（复杂结构，SQLite 无原生 JSON 列语义）。
--   built_in：内置 adapter（webhook/feishu）标记——种子注册，enabled 状态可被 Update 改，但不可 List 之外删除
--     （本轮无 Delete 动词，§11.1 只 List/Get/Write/Update）。Health 对 built_in 直接返回 ok（无外部探活端点）。
--   pluginToken 不落库（敏感凭据仅 Write 响应回传一次，与 model_providers.secretRef 同脱敏纪律）。

CREATE TABLE IF NOT EXISTS plugin_registrations (
  id                 TEXT PRIMARY KEY,     -- PluginManifest.id（唯一）
  kind               TEXT NOT NULL,        -- context-provider | tool-provider | channel-adapter | agent-harness
  interface_version  TEXT NOT NULL,        -- 实现的接口版本（如 "channel-adapter/v1"）
  endpoint           TEXT NOT NULL,        -- HTTPS base 或 "binding:<name>"（§11.1 L931-933）
  auth_json          TEXT NOT NULL,        -- PluginAuth JSON（platform-token | bearer{secretRef}）
  required_grants_json TEXT NOT NULL,      -- requiredGrants[] JSON
  health_path        TEXT NOT NULL,        -- 探活路径（§11.2 Health）
  enabled            INTEGER NOT NULL,     -- 0|1 挂载开关
  built_in           INTEGER NOT NULL DEFAULT 0,  -- 1=内置 adapter 种子（Health 直接 ok，无外部探活）
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plugin_kind ON plugin_registrations(kind);
