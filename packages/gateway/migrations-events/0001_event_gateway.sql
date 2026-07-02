-- Migration 0001: Event Gateway 存储层（Proto §2.4 EventStore + §2.2 ChannelRegistry）。
-- 库：watt-events（binding DB_EVENTS）。
--
-- events：EventStore 留痕（§2.4 L294-298）。完整信封存 envelope（JSON），常查字段拆列建索引。
--   filter 四维 type/channel/session/时间范围 + dedupeKey 幂等查（§2.3）各建索引。
-- channels：ChannelRegistry 渠道配置落库（§2.2 L242-249）。settings 以 JSON 字符串存。

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,       -- Event.id 平台生成，全局唯一
  type        TEXT NOT NULL,          -- 点分命名，前缀 LIKE 查询
  source_kind TEXT NOT NULL,          -- im/webhook/email/cron/agent/system
  channel     TEXT,                   -- source.channel（可空）
  session     TEXT,                   -- 会话粘性键（可空）
  principal   TEXT,                   -- 平台补齐（可空）
  dedupe_key  TEXT,                   -- 去重键（可空）
  trace_id    TEXT NOT NULL,
  occurred_at TEXT NOT NULL,          -- ISO8601 Timestamp
  envelope    TEXT NOT NULL           -- 完整 Event JSON（Get 返回整信封）
);

CREATE INDEX IF NOT EXISTS idx_events_type     ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_channel  ON events(channel);
CREATE INDEX IF NOT EXISTS idx_events_session  ON events(session);
CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_dedupe   ON events(dedupe_key);

-- ChannelRegistry（§2.2）：渠道配置四动词 List/Get/Write/Update 的持久化面。
-- settings 以 JSON 对象字符串存；default_agent 可空（渠道生命周期事件自动订阅绑定，§2.3 规则 2）。
CREATE TABLE IF NOT EXISTS channels (
  id            TEXT PRIMARY KEY,
  adapter       TEXT NOT NULL,        -- plugin id
  enabled       INTEGER NOT NULL,     -- 0/1（SQLite 无 boolean）
  settings      TEXT NOT NULL,        -- JSON object string
  default_agent TEXT,                 -- AgentDefinition 名（可空）
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
