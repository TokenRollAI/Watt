/**
 * vector ContextProvider（Proto §4.1）——Vectorize + Workers AI embeddings。
 * bindings：VECTORIZE_CONTEXT（1024 维 bge-m3 cosine 索引）+ AI（Workers AI）。
 *
 * 依赖注入（关键测试策略，调研 §6 R1）：provider 构造收窄接口 Embedder + VectorIndex，
 *   而非直接依赖 ambient Ai/VectorizeIndex 全类型——本地 miniflare 对 Vectorize 只 WARNING 不
 *   执行真实召回（toolchain §10），故单测注入 fake，真实召回验证留部署冒烟。
 *
 * 动词映射：
 * - Write = embed(content) → upsert([{id:key, values, metadata:{content 截断+用户 metadata+meta 字段}}])。
 * - Search(query, opts) = embed(query) → query(values,{topK}) → 按 score 降序返回 Page<Meta>。
 * - Get(path) = getByIds([key]) 取回单条（无 content 时从 metadata.content 还原）。
 * - Update = 读现有 → applyPatch → 重新 embed + upsert（vector 无部分更新，整体替换）。
 * - List = **Vectorize 无原生 list**（实现自由）：返回 unavailable（记 doc-gap 候选）。
 *
 * version 语义（实现自由）：单调整数字符串，存于 vector metadata.version。
 * key 布局：Vectorize 向量 id = `<namespace>/<path>`（多 namespace 共享索引；namespace 亦存 metadata）。
 */

import {
  applyPatch,
  checkIfVersion,
  type ContextEntry,
  type ContextEntryInput,
  type ContextEntryMeta,
  type ContextPatch,
} from '@watt/core';
import { type WattError, wattError } from '@watt/shared';
import type { ListOptions, Page } from './provider.ts';

/** content 存 vector metadata 的截断上限（Vectorize metadata 有大小限制，截断避免超限）。 */
const CONTENT_SNIPPET_MAX = 2048;
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 100;

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
export interface VectorIndex {
  upsert(vectors: VectorRecord[]): Promise<unknown>;
  query(values: number[], opts: { topK: number }): Promise<{ matches: VectorMatch[] }>;
  getByIds(ids: string[]): Promise<VectorRecord[]>;
}

function contextUri(namespace: string, path: string): string {
  return `context://${namespace}/${path}`;
}

/** Vectorize metadata（全 string，对齐 VectorizeVectorMetadata 常用形态）→ ContextEntryMeta。 */
function metaToEntryMeta(namespace: string, path: string, md: Record<string, string>): ContextEntryMeta {
  let metadata: Record<string, string> = {};
  if (md.metadata !== undefined) {
    try {
      metadata = JSON.parse(md.metadata) as Record<string, string>;
    } catch {
      metadata = {};
    }
  }
  return {
    uri: contextUri(namespace, path),
    contentType: md.contentType ?? 'text/plain',
    version: md.version ?? '1',
    updatedAt: md.updatedAt ?? new Date(0).toISOString(),
    metadata,
  };
}

export class VectorContextProvider {
  readonly kind = 'vector';
  readonly capabilities = { search: true, delete: false };

  constructor(
    private readonly index: VectorIndex,
    private readonly embedder: Embedder,
    private readonly namespace: string,
  ) {}

  private id(path: string): string {
    return `${this.namespace}/${path}`;
  }

  /** content → vector metadata 记录（content 截断、附 namespace/path/version 等）。 */
  private buildMetadata(
    path: string,
    contentType: string,
    content: string,
    version: string,
    userMetadata: Record<string, string>,
  ): Record<string, string> {
    return {
      namespace: this.namespace,
      path,
      contentType,
      version,
      updatedAt: new Date().toISOString(),
      content: content.slice(0, CONTENT_SNIPPET_MAX),
      metadata: JSON.stringify(userMetadata),
    };
  }

  async write(path: string, input: ContextEntryInput): Promise<ContextEntryMeta | WattError> {
    const existing = await this.readOne(path);
    const currentVersion = existing?.metadata?.version;
    const conflict = checkIfVersion(currentVersion, input.ifVersion);
    if (conflict !== null) return conflict;
    const version = existing === null ? '1' : bumpVersion(currentVersion ?? '0');
    const content = typeof input.content === 'string' ? input.content : JSON.stringify(input.content);
    const values = await this.embedder.embed(content);
    const md = this.buildMetadata(path, input.contentType, content, version, input.metadata ?? {});
    await this.index.upsert([{ id: this.id(path), values, metadata: md }]);
    return metaToEntryMeta(this.namespace, path, md);
  }

  async get(path: string): Promise<ContextEntry | WattError> {
    const rec = await this.readOne(path);
    if (rec === null) {
      return wattError('not_found', `context entry not found: ${path}`, false);
    }
    const md = rec.metadata ?? {};
    return { ...metaToEntryMeta(this.namespace, path, md), content: md.content ?? '' };
  }

  async update(path: string, patch: ContextPatch): Promise<ContextEntryMeta | WattError> {
    const rec = await this.readOne(path);
    if (rec === null) {
      return wattError('not_found', `context entry not found: ${path}`, false);
    }
    const md = rec.metadata ?? {};
    const conflict = checkIfVersion(md.version, patch.ifVersion);
    if (conflict !== null) return conflict;
    const current: ContextEntry = {
      ...metaToEntryMeta(this.namespace, path, md),
      content: md.content ?? '',
    };
    const merged = applyPatch(current, patch);
    const version = bumpVersion(md.version ?? '0');
    const content = typeof merged.content === 'string' ? merged.content : JSON.stringify(merged.content);
    const values = await this.embedder.embed(content);
    const newMd = this.buildMetadata(path, merged.contentType, content, version, merged.metadata);
    await this.index.upsert([{ id: this.id(path), values, metadata: newMd }]);
    return metaToEntryMeta(this.namespace, path, newMd);
  }

  /**
   * Search（§4.1 可选能力，vector 必备）：embed(query) → query(topK) → 按 score 降序。
   * topK 取 opts.limit（默认 10 钳 100）。只返回本 namespace 的匹配（metadata.namespace 过滤）。
   */
  async search(query: string, opts: ListOptions = {}): Promise<Page<ContextEntryMeta> | WattError> {
    const rawTopK = opts.limit ?? DEFAULT_TOP_K;
    const topK = Math.max(1, Math.min(rawTopK, MAX_TOP_K));
    const values = await this.embedder.embed(query);
    const { matches } = await this.index.query(values, { topK });
    const sorted = [...matches].sort((a, b) => b.score - a.score);
    const items: ContextEntryMeta[] = [];
    for (const m of sorted) {
      const md = m.metadata ?? {};
      if (md.namespace !== undefined && md.namespace !== this.namespace) continue;
      const path = md.path ?? stripNamespace(m.id, this.namespace);
      items.push(metaToEntryMeta(this.namespace, path, md));
    }
    return { items };
  }

  /**
   * List：Vectorize 无原生前缀枚举能力（实现自由，调研 §6 记 doc-gap 候选）。
   * 返回 unavailable —— 调用方应改用 Search 做检索。
   */
  async list(_path: string, _opts?: ListOptions): Promise<Page<ContextEntryMeta> | WattError> {
    return wattError(
      'unavailable',
      'vector provider does not support List; use Search',
      false,
    );
  }

  private async readOne(path: string): Promise<VectorRecord | null> {
    const recs = await this.index.getByIds([this.id(path)]);
    return recs.length > 0 ? (recs[0] ?? null) : null;
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
