-- Migration 0001: AuditLog 数据面（Proto §10 AuditLog / AuditRecord）+ Metrics usage 聚合表（§10 Metrics）。
-- 库：watt-audit（binding DB_AUDIT）。R23 Observability 地基。
--
-- 归属说明（实现自由决策，注释声明理由）：
--   ① audit_records 表——AuditRecord 的规范持久化面（附B 资源清单 watt-audit 库正是 "AuditLog, Proto §10"）。
--      每个 Authorizer.Check 判定点（allow/deny 都写）在 PEP 单点收口写一条（横切在 Authorizer wrapper，
--      不在 17 个调用方逐个加）。context 存整条 CallContext JSON（§6.4a claims→AuditRecord.context 完整派生链）；
--      principal/agent_inst 冗余提列便于 List filter（避免每次解 JSON）。
--   ② usage 表——token/cost 用量明细放本库（而非 watt-providers）。理由：watt-providers 是"可挂载能力
--      提供方"静态定义簇（tool/agent/model registry）；usage 是运行时可观测数据面，与 AuditLog 同为
--      Observability 采集面（Architecture M9：AE 时序 + D1 审计明细），语义同簇，故与 audit 共库。
--      每次真实模型调用（llm harness）写一行；Metrics.Query metric=tokens 走本表 GROUP BY。
--      AE writeDataPoint 并行打点（高基数时序），本表是本地可测的聚合真源。

CREATE TABLE IF NOT EXISTS audit_records (
  id          TEXT PRIMARY KEY,   -- crypto.randomUUID()
  at          TEXT NOT NULL,      -- ISO8601 UTC（判定时刻）
  context     TEXT NOT NULL,      -- CallContext JSON（principal/roles/agent 链/traceId 完整派生链）
  principal   TEXT NOT NULL,      -- CallContext.principal 冗余提列（filter）
  agent_inst  TEXT,               -- CallContext.agent.instanceId 冗余提列（filter，user token 为 NULL）
  resource    TEXT NOT NULL,      -- URI（platform://... / tool://... / task://... 等）
  action      TEXT NOT NULL,      -- read | manage | signal | ...
  decision    TEXT NOT NULL,      -- 'allow' | 'deny'
  detail      TEXT                -- AuditRecord.detail JSON（可空；当前存 decision.reason/obligations）
);

CREATE INDEX IF NOT EXISTS idx_audit_at         ON audit_records(at);
CREATE INDEX IF NOT EXISTS idx_audit_principal  ON audit_records(principal);
CREATE INDEX IF NOT EXISTS idx_audit_agent      ON audit_records(agent_inst);
CREATE INDEX IF NOT EXISTS idx_audit_resource   ON audit_records(resource);
CREATE INDEX IF NOT EXISTS idx_audit_decision   ON audit_records(decision);

-- usage：每次真实模型调用一行（Metrics metric=tokens/cost 的 D1 聚合真源）。
--   provider/model：ModelProvider 解析的渠道 + 模型名；agent_def/instance：调用发起的 Agent 定义/实例。
--   cost 可空（中转直连无计费回传时留空；Metrics metric=cost 对无 cost 行按 0 计或空 series）。
CREATE TABLE IF NOT EXISTS usage (
  id            TEXT PRIMARY KEY,   -- crypto.randomUUID()
  at            TEXT NOT NULL,      -- ISO8601 UTC
  provider      TEXT NOT NULL,      -- 渠道 vendor（缺省 'anthropic'；中转直连即 anthropic 格式）
  model         TEXT NOT NULL,      -- 模型名
  agent_def     TEXT,               -- AgentDefinition 名（可空）
  instance      TEXT,               -- AgentInstance id（可空）
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost          REAL                -- 计费（可空）
);

CREATE INDEX IF NOT EXISTS idx_usage_at       ON usage(at);
CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage(provider);
CREATE INDEX IF NOT EXISTS idx_usage_model    ON usage(model);
CREATE INDEX IF NOT EXISTS idx_usage_agent    ON usage(agent_def);
