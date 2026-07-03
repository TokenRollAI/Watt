-- Migration 0001: Tool Registry 挂载表（Proto §5.2 ToolRegistry）。
-- 库：watt-providers（binding DB_PROVIDERS）。
--
-- 归属说明（Architecture.md 附B）：watt-providers 库在附B 归 M8（ModelProviderRegistry, Proto §9）。
--   Tool Layer 的 ToolRegistry（M4）附B 未单列专库。选择复用 watt-providers 而非新建库的理由：
--   ① ToolMount 与 ModelProvider 同属"平台可挂载的外部能力提供方注册表"语义相近；
--   ② 避免为单张小表新增第 6 个 D1 库（多库拆分决策见 memory/decisions/resource-naming-and-provision.md）。
--   两张表在同库内以表名隔离（tool_mounts vs 后续 M8 的 model_providers），互不干扰。
--
-- tool_mounts：ToolRegistry 四动词 List/Get/Write/Update 的持久化面（§5.2 L594-599）。
--   主键 path（工具树位置，唯一）；provider = plugin id 或内置 mcp|http|builtin；
--   provider_config / virtualize 以 JSON 对象字符串存（可空）；enabled 以 0/1 存（SQLite 无 boolean）。

CREATE TABLE IF NOT EXISTS tool_mounts (
  path            TEXT PRIMARY KEY,     -- ToolMount.path 工具树位置，唯一（"observability/logs"）
  provider        TEXT NOT NULL,        -- plugin id 或内置 "mcp"|"http"|"builtin"
  provider_config TEXT,                 -- providerConfig JSON object string（可空，凭证走 Secrets 引用）
  virtualize      TEXT,                 -- virtualize JSON object string（可空）
  enabled         INTEGER NOT NULL,     -- 0/1（SQLite 无 boolean）
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
