-- Migration 0001: Context Layer structured provider 存储（Proto §4.1 ContextProvider）。
-- 库：watt-context（binding DB_CONTEXT）。附B 未列 M3 structured 专库 → 新建独立库
--   （不复用 watt-events：ownership 混淆 + 保留期语义冲突；doc-gap 候选，见结论）。
--
-- entries：structured provider 的四动词（List/Get/Write/Update）持久化面。
--   一行 = 一个 context 条目；(namespace, path) 复合主键（多 namespace 共享此库单表，
--   provider_config 不参与——ContextRegistry 挂载时把 namespace 传给 provider）。
--   content 存 TEXT（文本或 JSON 序列化串）；metadata 存 JSON object 串；
--   version 单调递增整数字符串（provider I/O 层生成，见 structured.ts 注释）。

CREATE TABLE IF NOT EXISTS entries (
  namespace    TEXT NOT NULL,          -- 挂载点 namespace（"feedback/bugs"）
  path         TEXT NOT NULL,          -- namespace 内相对路径（条目 id）
  content      TEXT NOT NULL,          -- 文本或 JSON 序列化串
  content_type TEXT NOT NULL,          -- "text/markdown" | "application/json" | ...
  metadata     TEXT NOT NULL,          -- JSON object 串（Record<string,string>）
  version      TEXT NOT NULL,          -- 乐观并发版本（单调递增整数字符串）
  updated_at   TEXT NOT NULL,          -- ISO8601 Timestamp
  PRIMARY KEY (namespace, path)
);

-- List 走 (namespace, path 前缀) 查询；复合主键已覆盖该查询模式（前导列 namespace）。
