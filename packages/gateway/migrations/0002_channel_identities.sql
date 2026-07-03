-- Migration 0002: 渠道身份映射（Proto §6.3 IdentityMapper.Resolve）。
-- 库：watt-policies（binding DB_POLICIES，与 identity_mappings 同库）。
--
-- channel_identities：渠道原始用户 → 平台 principal。Resolve(channel, channelUserId) 查此表，
-- 命中 → principal（roles 再经 identity_mappings.ResolvePrincipal 实时解析）；未命中 → anonymous。
-- 复合主键 (channel, channel_user_id) 唯一：一个渠道用户映射到唯一 principal（R24）。
CREATE TABLE IF NOT EXISTS channel_identities (
  channel         TEXT NOT NULL,   -- "feishu" | "slack" | ...
  channel_user_id TEXT NOT NULL,   -- 飞书 open_id 等
  principal       TEXT NOT NULL,   -- "user:alice" 等（roles 走 identity_mappings 解析）
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (channel, channel_user_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_identities_principal ON channel_identities(principal);
