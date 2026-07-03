-- Migration 0002: Agent Registry 定义表（Proto §3.1 AgentRegistry）。
-- 库：watt-providers（binding DB_PROVIDERS），与 0001 tool_mounts 同库、以表名隔离。
--
-- 归属说明（对齐 0001_tool_registry.sql 的选择理由）：AgentRegistry（M2）与 ToolRegistry（M4）、
--   ModelProviderRegistry（M8）同属"平台可挂载/注册的能力提供方"语义簇；复用 watt-providers 库
--   而非为单表新增 D1 库（多库拆分决策见 memory/decisions/resource-naming-and-provision.md）。
--   三张表以表名隔离（tool_mounts / agent_definitions / model_providers），互不干扰。
--
-- agent_definitions：AgentRegistry 四动词 List/Get/Write/Update 的持久化面（§3.1 L311-339）。
--   主键 name（AgentDefinition.name，唯一，如 "triage"|"manage/cron"）；
--   runtime = light|heavy|external；entry/model/grants/context_namespaces/tool_scopes/subscriptions
--   以 JSON 字符串存（复杂结构，SQLite 无原生 JSON 列语义）。Write 时平台把 subscriptions[]
--   转 EventRouter.subscribe（§2.3 规则 1），订阅副作用在 gateway agent-registry.ts 侧编排（非本表）。

CREATE TABLE IF NOT EXISTS agent_definitions (
  name               TEXT PRIMARY KEY,     -- AgentDefinition.name（唯一）
  description        TEXT NOT NULL,
  runtime            TEXT NOT NULL,        -- light | heavy | external
  entry_json         TEXT NOT NULL,        -- AgentEntry（do-class|container|endpoint）JSON
  model_json         TEXT,                 -- { preferred, fallback? } JSON（可空）
  grants_json        TEXT NOT NULL,        -- grants[] JSON
  context_namespaces_json TEXT NOT NULL,   -- contextNamespaces[] JSON
  tool_scopes_json   TEXT NOT NULL,        -- toolScopes[] JSON
  subscriptions_json TEXT,                 -- subscriptions[] JSON（可空）
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
