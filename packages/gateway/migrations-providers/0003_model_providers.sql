-- Migration 0003: ModelProviderRegistry 渠道表（Proto §9 最小版）。
-- 库：watt-providers（binding DB_PROVIDERS），与 0001 tool_mounts / 0002 agent_definitions 同库、表名隔离。
--
-- 归属：附B 明列 watt-providers 库归 M8（ModelProviderRegistry, Proto §9）——本表即 M8 的核心表，
--   归属无争议（与 tool_mounts/agent_definitions 的复用同库决策一致）。
--
-- model_providers：ModelProviderRegistry 四动词 + set-default 的持久化面（§9 L849-864）。
--   主键 id（"openrouter-main"）；vendor / models(JSON) / priority / is_default(0/1) / enabled(0/1)；
--   secret_ref 存密钥引用名（永不回显明文，实际密钥走 Secrets，§9 L862）。
--   全局默认唯一：Write/Update 设 default 时由 store 先清其余（应用层保证，SQLite 无部分唯一约束跨行）。

CREATE TABLE IF NOT EXISTS model_providers (
  id          TEXT PRIMARY KEY,     -- ModelProvider.id
  vendor      TEXT NOT NULL,        -- "anthropic" | "workers-ai" | "openrouter" | ...
  models_json TEXT NOT NULL,        -- models[] JSON
  priority    INTEGER NOT NULL,     -- 路由排序
  is_default  INTEGER NOT NULL,     -- 0/1 全局默认（同时只一个）
  secret_ref  TEXT NOT NULL,        -- 密钥引用名（永不回显）
  enabled     INTEGER NOT NULL,     -- 0/1
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
