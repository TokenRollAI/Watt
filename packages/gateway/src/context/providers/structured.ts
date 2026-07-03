/**
 * structured ContextProvider（Proto §4.1）——D1 持久化（binding DB_CONTEXT，库 watt-context）。
 *
 * 表 entries(namespace, path, content, content_type, metadata, version, updated_at)，
 * (namespace,path) 复合主键（见 migrations-context/0001）。构造时绑定单一 namespace，
 * 所有动词在该 namespace 内操作（ContextRegistry 挂载时注入 namespace）。
 *
 * 语义（复用 core verbs 纯逻辑判定）：
 * - Write = 幂等 upsert（§0.4）；ifVersion 携带时先读当前版本经 checkIfVersion 校验（不匹配 → conflict）。
 * - Update 不存在 → not_found（requireExisting）；metadata 浅合并、content 提供则替换（applyPatch）。
 * - List 按 path 前缀过滤，limit 默认 50 钳 200（对齐 event-store）。
 *
 * version 语义（实现自由）：单调递增整数字符串（"1"→"2"→…）。Write 新建置 "1"、覆盖时 +1；
 *   Update +1。选整数串而非 UUID：便于测试断言与人读，且 ifVersion 比对只需字符串相等（§4.1）。
 */

import type { D1Database } from '@cloudflare/workers-types';
import {
  applyPatch,
  checkIfVersion,
  type ContextEntry,
  type ContextEntryInput,
  type ContextEntryMeta,
  type ContextPatch,
  requireExisting,
} from '@watt/core';
import { type WattError, wattError } from '@watt/shared';
import type { ListOptions, Page } from './provider.ts';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** structured provider List 合法 filter 键：仅 path 前缀（§4.1 List(path) 语义）。空白名单。 */
const ALLOWED_LIST_FILTER_KEYS = new Set<string>([]);

interface EntryRow {
  namespace: string;
  path: string;
  content: string;
  content_type: string;
  metadata: string;
  version: string;
  updated_at: string;
}

function contextUri(namespace: string, path: string): string {
  return `context://${namespace}/${path}`;
}

function rowToMeta(row: EntryRow): ContextEntryMeta {
  return {
    uri: contextUri(row.namespace, row.path),
    contentType: row.content_type,
    size: row.content.length,
    version: row.version,
    updatedAt: row.updated_at,
    metadata: JSON.parse(row.metadata) as Record<string, string>,
  };
}

function rowToEntry(row: EntryRow): ContextEntry {
  return { ...rowToMeta(row), content: row.content };
}

/** content 归一为存储串：字符串直存，其余（JSON）序列化。 */
function serializeContent(content: string | unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

export class StructuredContextProvider {
  readonly kind = 'structured';
  readonly capabilities = { search: false, delete: true };

  constructor(
    private readonly db: D1Database,
    private readonly namespace: string,
  ) {}

  async list(path: string, opts: ListOptions = {}): Promise<Page<ContextEntryMeta> | WattError> {
    const filter = opts.filter ?? {};
    for (const key of Object.keys(filter)) {
      if (!ALLOWED_LIST_FILTER_KEYS.has(key)) {
        return wattError('invalid_argument', `unknown filter key: ${key}`, false);
      }
    }
    const rawLimit = opts.limit ?? DEFAULT_LIST_LIMIT;
    const limit = Math.max(1, Math.min(rawLimit, MAX_LIST_LIMIT));
    // path 作前缀过滤（空 path → 列全 namespace）。LIKE 转义 % / _ 避免通配注入。
    const prefix = path;
    const { results } = await this.db
      .prepare(
        `SELECT * FROM entries WHERE namespace = ? AND path LIKE ? ESCAPE '\\' ORDER BY path LIMIT ?`,
      )
      .bind(this.namespace, `${escapeLike(prefix)}%`, limit)
      .all<EntryRow>();
    return { items: results.map(rowToMeta) };
  }

  async get(path: string): Promise<ContextEntry | WattError> {
    const row = await this.readRow(path);
    if (row === null) {
      return wattError('not_found', `context entry not found: ${path}`, false);
    }
    return rowToEntry(row);
  }

  async write(path: string, input: ContextEntryInput): Promise<ContextEntryMeta | WattError> {
    const existing = await this.readRow(path);
    const conflict = checkIfVersion(existing?.version, input.ifVersion);
    if (conflict !== null) return conflict;
    // 新建 → "1"；覆盖 → 现版本 +1。
    const version = existing === null ? '1' : bumpVersion(existing.version);
    const updatedAt = new Date().toISOString();
    const content = serializeContent(input.content);
    const metadata = JSON.stringify(input.metadata ?? {});
    await this.db
      .prepare(
        `INSERT INTO entries (namespace, path, content, content_type, metadata, version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(namespace, path) DO UPDATE SET
           content = excluded.content,
           content_type = excluded.content_type,
           metadata = excluded.metadata,
           version = excluded.version,
           updated_at = excluded.updated_at`,
      )
      .bind(this.namespace, path, content, input.contentType, metadata, version, updatedAt)
      .run();
    return {
      uri: contextUri(this.namespace, path),
      contentType: input.contentType,
      size: content.length,
      version,
      updatedAt,
      metadata: JSON.parse(metadata) as Record<string, string>,
    };
  }

  async update(path: string, patch: ContextPatch): Promise<ContextEntryMeta | WattError> {
    const row = await this.readRow(path);
    const existing = requireExisting(row, path);
    if ('code' in existing) return existing;
    const conflict = checkIfVersion(existing.version, patch.ifVersion);
    if (conflict !== null) return conflict;
    // 施 patch（content 替换 / metadata 浅合并）经 core applyPatch 纯逻辑。
    const merged = applyPatch(rowToEntry(existing), patch);
    const version = bumpVersion(existing.version);
    const updatedAt = new Date().toISOString();
    const content = serializeContent(merged.content);
    const metadata = JSON.stringify(merged.metadata);
    await this.db
      .prepare(
        `UPDATE entries SET content = ?, metadata = ?, version = ?, updated_at = ?
         WHERE namespace = ? AND path = ?`,
      )
      .bind(content, metadata, version, updatedAt, this.namespace, path)
      .run();
    return {
      uri: contextUri(this.namespace, path),
      contentType: merged.contentType,
      size: content.length,
      version,
      updatedAt,
      metadata: merged.metadata,
    };
  }

  async delete_(path: string): Promise<void | WattError> {
    await this.db
      .prepare('DELETE FROM entries WHERE namespace = ? AND path = ?')
      .bind(this.namespace, path)
      .run();
  }

  private async readRow(path: string): Promise<EntryRow | null> {
    return await this.db
      .prepare('SELECT * FROM entries WHERE namespace = ? AND path = ?')
      .bind(this.namespace, path)
      .first<EntryRow>();
  }
}

/** version 递增（单调整数字符串；非数字兜底重置为 "1"，防脏数据卡死）。 */
function bumpVersion(current: string): string {
  const n = Number.parseInt(current, 10);
  return Number.isFinite(n) ? String(n + 1) : '1';
}

/** LIKE 前缀转义（% _ \ → 加 \ 前缀），配合 ESCAPE '\\'。 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
