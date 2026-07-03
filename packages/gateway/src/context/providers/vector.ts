/**
 * vector ContextProvider（Proto §4.1）——D1 sidecar 权威存储 + Vectorize 语义检索。
 * bindings：DB_CONTEXT（权威全文/metadata/version）+ VECTORIZE_CONTEXT（1024 维 bge-m3 cosine
 *   索引，只存 embedding + {namespace,path} 引用）+ AI（Workers AI embeddings）。
 *
 * 架构（P3 关门重构，取代原"Vectorize metadata 兼任权威存储"方案）：
 * - **权威数据存 D1**（与 structured provider 同表 entries，namespace 天然隔离——mounts 唯一键
 *   保证 vector mount 与 structured mount 的 namespace 不重名）：content 全文、metadata、version、
 *   updatedAt、contentType 全部在 D1，Get/Update/List 一律从 D1 读全文——无 2048 截断丢数据、
 *   无 List unavailable 违约、无 Vectorize 异步最终一致导致的 read-after-write/ifVersion 不可靠。
 * - **Vectorize 只存向量 + 引用**：embedding values + metadata {namespace,path}（可留 snippet 供
 *   未来 rerank，但读全文永远走 D1）。Search 用 Vectorize 召回 {namespace,path} → 回 D1 批量取 meta。
 *
 * 动词映射：
 * - Write = D1 读版本 → checkIfVersion → embed 全文 → Vectorize upsert → D1 条件写（并发安全，
 *   见 writeRow）。
 * - Update = D1 读现有 → checkIfVersion → applyPatch；content 变则重 embed + Vectorize upsert，
 *   **content 未变（metadata-only patch）时跳过 embed**（不再用截断文本重算 embedding）→ D1 条件写。
 * - Get / List = 直接走 D1（sidecar 权威），Vectorize 完全不参与。
 * - Search = embed(query) → Vectorize query(filter namespace) → 拿 {namespace,path} → D1 批量读 meta。
 *
 * 依赖注入（测试策略，调研 §6 R1）：provider 构造收窄接口 Embedder + VectorIndex（含 filter/delete），
 *   而非直接依赖 ambient Ai/VectorizeIndex——本地 miniflare 对 Vectorize 只 WARNING（toolchain §10），
 *   单测注入 fake，真实召回验证留部署冒烟。D1 侧走真实 DB_CONTEXT binding（同 structured 单测）。
 *
 * version 语义（实现自由，与 structured 一致）：单调整数字符串，存 D1 entries.version。
 */

import type { D1Database } from '@cloudflare/workers-types';
import {
  applyPatch,
  type ContextEntry,
  type ContextEntryInput,
  type ContextEntryMeta,
  type ContextPatch,
  checkIfVersion,
  requireExisting,
} from '@watt/core';
import { type WattError, wattError } from '@watt/shared';
import type { ListOptions, Page } from '../provider.ts';

/** content snippet 留存 Vectorize metadata 的上限（仅供未来 rerank；权威全文在 D1）。 */
const CONTENT_SNIPPET_MAX = 2048;
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 100;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
/** Vectorize deleteByIds 分批上限（清理 TTL 过期 namespace 用）。 */
const VECTOR_DELETE_BATCH = 500;

/** vector provider List 合法 filter 键：仅 path 前缀（§4.1 List(path) 语义）。空白名单。 */
const ALLOWED_LIST_FILTER_KEYS = new Set<string>([]);

/** 收窄的 Workers AI embedding 接口（注入 fake 便于测试）。 */
export interface Embedder {
  /** 返回单条文本的 1024 维向量（bge-m3）。 */
  embed(text: string): Promise<number[]>;
}

/** 收窄的 Vectorize 索引接口（注入 fake；对齐 workers-types Vectorize 子集）。 */
export interface VectorRecord {
  id: string;
  values: number[];
  metadata?: Record<string, string>;
}
export interface VectorMatch {
  id: string;
  score: number;
  metadata?: Record<string, string>;
}
/** query 选项：topK + 可选 metadata filter（$eq namespace 收窄召回，见项 3）。 */
export interface VectorQueryOptions {
  topK: number;
  filter?: Record<string, { $eq: string }>;
}
export interface VectorIndex {
  upsert(vectors: VectorRecord[]): Promise<unknown>;
  query(values: number[], opts: VectorQueryOptions): Promise<{ matches: VectorMatch[] }>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

/** D1 entries 行（与 structured 同表；此处只读需要的列）。 */
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

function serializeContent(content: string | unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

export class VectorContextProvider {
  readonly kind = 'vector';
  readonly capabilities = { search: true, delete: false };

  constructor(
    private readonly db: D1Database,
    private readonly index: VectorIndex,
    private readonly embedder: Embedder,
    private readonly namespace: string,
  ) {}

  /** Vectorize 向量 id = `<namespace>/<path>`（多 namespace 共享索引；namespace 存 metadata 供 filter）。 */
  private id(path: string): string {
    return `${this.namespace}/${path}`;
  }

  /** Vectorize 引用 metadata：只存 {namespace, path} + content snippet（权威全文在 D1）。 */
  private buildVectorMetadata(path: string, content: string): Record<string, string> {
    return {
      namespace: this.namespace,
      path,
      content: content.slice(0, CONTENT_SNIPPET_MAX),
    };
  }

  async write(path: string, input: ContextEntryInput): Promise<ContextEntryMeta | WattError> {
    const existing = await this.readRow(path);
    const conflict = checkIfVersion(existing?.version, input.ifVersion);
    if (conflict !== null) return conflict;
    const version = existing === null ? '1' : bumpVersion(existing.version);
    const content = serializeContent(input.content);
    // embed 全文（不截断）→ Vectorize upsert（引用向量）；再条件写 D1（权威）。
    const values = await this.embedder.embed(content);
    await this.index.upsert([
      { id: this.id(path), values, metadata: this.buildVectorMetadata(path, content) },
    ]);
    return await this.writeRow(path, input.contentType, content, input.metadata ?? {}, version, {
      isNew: existing === null,
      expectVersion: existing?.version,
    });
  }

  async get(path: string): Promise<ContextEntry | WattError> {
    const row = await this.readRow(path);
    if (row === null) {
      return wattError('not_found', `context entry not found: ${path}`, false);
    }
    return rowToEntry(row);
  }

  async update(path: string, patch: ContextPatch): Promise<ContextEntryMeta | WattError> {
    const row = await this.readRow(path);
    const existing = requireExisting(row, path);
    if ('code' in existing) return existing;
    const conflict = checkIfVersion(existing.version, patch.ifVersion);
    if (conflict !== null) return conflict;
    const merged = applyPatch(rowToEntry(existing), patch);
    const version = bumpVersion(existing.version);
    const content = serializeContent(merged.content);
    // content 未变（metadata-only patch）→ 跳过 embed + Vectorize upsert（不用旧文本重算 embedding）。
    const contentChanged = content !== existing.content;
    if (contentChanged) {
      const values = await this.embedder.embed(content);
      await this.index.upsert([
        { id: this.id(path), values, metadata: this.buildVectorMetadata(path, content) },
      ]);
    }
    return await this.writeRow(path, merged.contentType, content, merged.metadata, version, {
      isNew: false,
      expectVersion: existing.version,
    });
  }

  /**
   * Search（§4.1 可选能力，vector 必备）：embed(query) → Vectorize query（namespace filter 收窄
   * 召回，见项 3）→ 拿命中的 {namespace,path} → D1 批量读 meta（权威全文/metadata）。
   * topK 取 opts.limit（默认 10 钳 100）。metadata.namespace 本地过滤作双保险。
   */
  async search(query: string, opts: ListOptions = {}): Promise<Page<ContextEntryMeta> | WattError> {
    const rawTopK = opts.limit ?? DEFAULT_TOP_K;
    const topK = Math.max(1, Math.min(rawTopK, MAX_TOP_K));
    const values = await this.embedder.embed(query);
    const { matches } = await this.index.query(values, {
      topK,
      filter: { namespace: { $eq: this.namespace } },
    });
    const sorted = [...matches].sort((a, b) => b.score - a.score);
    // 收集命中 path（本地 namespace 过滤双保险：metadata 缺 namespace 字段亦按前缀还原判定）。
    const paths: string[] = [];
    for (const m of sorted) {
      const md = m.metadata ?? {};
      if (md.namespace !== undefined && md.namespace !== this.namespace) continue;
      const path = md.path ?? stripNamespace(m.id, this.namespace);
      // metadata 缺 namespace 字段时，靠 id 前缀判定是否属本 namespace。
      if (md.namespace === undefined && !m.id.startsWith(`${this.namespace}/`)) continue;
      paths.push(path);
    }
    // D1 批量读 meta，保持 Vectorize 的 score 降序。
    const rows = await this.readRows(paths);
    const byPath = new Map(rows.map((r) => [r.path, r]));
    const items: ContextEntryMeta[] = [];
    for (const p of paths) {
      const row = byPath.get(p);
      if (row !== undefined) items.push(rowToMeta(row));
    }
    return { items };
  }

  /** List（§4.1）——走 D1 sidecar 前缀枚举（不再 unavailable）。limit 默认 50 钳 200。 */
  async list(path: string, opts: ListOptions = {}): Promise<Page<ContextEntryMeta> | WattError> {
    const filter = opts.filter ?? {};
    for (const key of Object.keys(filter)) {
      if (!ALLOWED_LIST_FILTER_KEYS.has(key)) {
        return wattError('invalid_argument', `unknown filter key: ${key}`, false);
      }
    }
    const rawLimit = opts.limit ?? DEFAULT_LIST_LIMIT;
    const limit = Math.max(1, Math.min(rawLimit, MAX_LIST_LIMIT));
    const { results } = await this.db
      .prepare(
        `SELECT * FROM entries WHERE namespace = ? AND path LIKE ? ESCAPE '\\' ORDER BY path LIMIT ?`,
      )
      .bind(this.namespace, `${escapeLike(path)}%`, limit)
      .all<EntryRow>();
    return { items: results.map(rowToMeta) };
  }

  private async readRow(path: string): Promise<EntryRow | null> {
    return await this.db
      .prepare('SELECT * FROM entries WHERE namespace = ? AND path = ?')
      .bind(this.namespace, path)
      .first<EntryRow>();
  }

  private async readRows(paths: string[]): Promise<EntryRow[]> {
    if (paths.length === 0) return [];
    const placeholders = paths.map(() => '?').join(', ');
    const { results } = await this.db
      .prepare(`SELECT * FROM entries WHERE namespace = ? AND path IN (${placeholders})`)
      .bind(this.namespace, ...paths)
      .all<EntryRow>();
    return results;
  }

  /**
   * 条件写 D1（原子读-改-写，防并发绕过 ifVersion，见项 2）：
   * - 新建：INSERT ... ON CONFLICT DO NOTHING；changes=0 → 并发插入 → conflict。
   * - 覆盖：UPDATE ... WHERE version=expectVersion；changes=0 → 并发已改版本 → conflict。
   */
  private async writeRow(
    path: string,
    contentType: string,
    content: string,
    metadata: Record<string, string>,
    version: string,
    opts: { isNew: boolean; expectVersion: string | undefined },
  ): Promise<ContextEntryMeta | WattError> {
    const updatedAt = new Date().toISOString();
    const metadataJson = JSON.stringify(metadata);
    if (opts.isNew) {
      const res = await this.db
        .prepare(
          `INSERT INTO entries (namespace, path, content, content_type, metadata, version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(namespace, path) DO NOTHING`,
        )
        .bind(this.namespace, path, content, contentType, metadataJson, version, updatedAt)
        .run();
      if (res.meta.changes === 0) {
        return wattError('conflict', `concurrent write on ${path}`, false);
      }
    } else {
      const res = await this.db
        .prepare(
          `UPDATE entries SET content = ?, content_type = ?, metadata = ?, version = ?, updated_at = ?
           WHERE namespace = ? AND path = ? AND version = ?`,
        )
        .bind(
          content,
          contentType,
          metadataJson,
          version,
          updatedAt,
          this.namespace,
          path,
          opts.expectVersion ?? '',
        )
        .run();
      if (res.meta.changes === 0) {
        return wattError('conflict', `concurrent write on ${path}`, false);
      }
    }
    return {
      uri: contextUri(this.namespace, path),
      contentType,
      size: content.length,
      version,
      updatedAt,
      metadata,
    };
  }

  /**
   * TTL 过期回收（§4.2）——物理清理本 namespace 的全部 vector 数据：
   * D1 sidecar 行 DELETE + 凭 D1 path 集合 Vectorize deleteByIds（分批）。best-effort。
   * 单库失败抛出由调用方（context-routes GC）捕获降级，不阻塞挂载行删除。
   */
  async purgeNamespace(): Promise<void> {
    // 先从 D1 收集本 namespace 全部 path（作为 Vectorize 向量 id 依据）。
    const { results } = await this.db
      .prepare('SELECT path FROM entries WHERE namespace = ?')
      .bind(this.namespace)
      .all<{ path: string }>();
    const ids = results.map((r) => this.id(r.path));
    for (let i = 0; i < ids.length; i += VECTOR_DELETE_BATCH) {
      await this.index.deleteByIds(ids.slice(i, i + VECTOR_DELETE_BATCH));
    }
    await this.db.prepare('DELETE FROM entries WHERE namespace = ?').bind(this.namespace).run();
  }
}

function bumpVersion(current: string): string {
  const n = Number.parseInt(current, 10);
  return Number.isFinite(n) ? String(n + 1) : '1';
}

function stripNamespace(id: string, namespace: string): string {
  const prefix = `${namespace}/`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/** LIKE 前缀转义（% _ \ → 加 \ 前缀），配合 ESCAPE '\\'。 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
