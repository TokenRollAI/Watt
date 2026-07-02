-- Migration 0001: Auth 内核（Proto §6.2 PolicyStore + §6.3 IdentityMapper）。
-- 库：watt-policies（binding DB_POLICIES）。
--
-- policies：PolicyStore 的持久化（§6.2 L651–658）。actions/condition 以 JSON 字符串存。
-- identity_mappings：IdentityMapper 的 principal→roles 面（ResolvePrincipal，§6.3）。

CREATE TABLE IF NOT EXISTS policies (
  id         TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  resource   TEXT NOT NULL,
  actions    TEXT NOT NULL,   -- JSON array string, e.g. '["*"]'
  effect     TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  condition  TEXT,            -- JSON object string, nullable
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_policies_subject ON policies(subject);

-- IdentityMapper 最小面：principal → roles（§6.3 ResolvePrincipal）。
-- roles 以 JSON array 字符串存。种子引导写入 WATT_ADMIN_PRINCIPAL → ["admin"]。
CREATE TABLE IF NOT EXISTS identity_mappings (
  principal  TEXT PRIMARY KEY,
  roles      TEXT NOT NULL,   -- JSON array string
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
