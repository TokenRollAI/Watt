/**
 * object ContextProvider（Proto §4.1）——R2 持久化（binding R2_CONTEXT_OBJECTS，桶 watt-context-objects）。
 *
 * 布局（实现自由）：多 namespace 共享单桶，R2 object key = `<namespace>/<path>`。
 *   构造时绑定单一 namespace，四动词在 `<namespace>/` 前缀下操作（ContextRegistry 挂载注入）。
 * entry 存储：R2 object body = content（字符串）；customMetadata 承载
 *   { contentType, version, metadata(JSON 串) }——R2 自带 version 是内容哈希，这里用自管
 *   单调整数版本（ifVersion 语义要求可比对，见 version 语义）。
 *
 * version 语义（实现自由，与 structured 一致）：单调递增整数字符串（"1"→"2"…）。
 *   Write 新建置 "1"、覆盖 +1；Update +1。存于 customMetadata.version（不用 R2 原生 etag/version：
 *   那是内容哈希，无法体现"第 N 次写"的乐观并发语义）。
 *
 * List 用 R2 list({prefix, limit}) 浅列（delimiter 留空 → 递归列，符合"前缀枚举"语义）；
 *   limit 默认 50 钳 200（对齐 event-store）。cursor 分页延后（doc-gap #22）。
 */

import type { R2Bucket, R2Object } from '@cloudflare/workers-types';
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

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

const ALLOWED_LIST_FILTER_KEYS = new Set<string>([]);

interface ObjectMeta {
  contentType: string;
  version: string;
  metadata: Record<string, string>;
}

function contextUri(namespace: string, path: string): string {
  return `context://${namespace}/${path}`;
}

export class ObjectContextProvider {
  readonly kind = 'object';
  readonly capabilities = { search: false, delete: true };

  constructor(
    private readonly bucket: R2Bucket,
    private readonly namespace: string,
  ) {}

  /** R2 object key = `<namespace>/<path>`（多 namespace 共享桶）。 */
  private key(path: string): string {
    return `${this.namespace}/${path}`;
  }

  /** customMetadata → 结构化 meta（缺字段兜底）。 */
  private readMeta(obj: R2Object): ObjectMeta {
    const cm = obj.customMetadata ?? {};
    let metadata: Record<string, string> = {};
    if (cm.metadata !== undefined) {
      try {
        metadata = JSON.parse(cm.metadata) as Record<string, string>;
      } catch {
        metadata = {};
      }
    }
    return {
      contentType: cm.contentType ?? 'application/octet-stream',
      version: cm.version ?? '1',
      metadata,
    };
  }

  private objToMeta(path: string, obj: R2Object): ContextEntryMeta {
    const m = this.readMeta(obj);
    return {
      uri: contextUri(this.namespace, path),
      contentType: m.contentType,
      size: obj.size,
      version: m.version,
      updatedAt: obj.uploaded.toISOString(),
      metadata: m.metadata,
    };
  }

  async list(path: string, opts: ListOptions = {}): Promise<Page<ContextEntryMeta> | WattError> {
    const filter = opts.filter ?? {};
    for (const key of Object.keys(filter)) {
      if (!ALLOWED_LIST_FILTER_KEYS.has(key)) {
        return wattError('invalid_argument', `unknown filter key: ${key}`, false);
      }
    }
    const rawLimit = opts.limit ?? DEFAULT_LIST_LIMIT;
    const limit = Math.max(1, Math.min(rawLimit, MAX_LIST_LIMIT));
    const listed = await this.bucket.list({ prefix: this.key(path), limit });
    const nsPrefix = `${this.namespace}/`;
    return {
      items: listed.objects.map((obj) => {
        // 去掉 `<namespace>/` 前缀还原为 namespace 内相对 path。
        const relative = obj.key.startsWith(nsPrefix) ? obj.key.slice(nsPrefix.length) : obj.key;
        return this.objToMeta(relative, obj);
      }),
    };
  }

  async get(path: string): Promise<ContextEntry | WattError> {
    const obj = await this.bucket.get(this.key(path));
    if (obj === null) {
      return wattError('not_found', `context entry not found: ${path}`, false);
    }
    const content = await obj.text();
    return { ...this.objToMeta(path, obj), content };
  }

  async write(path: string, input: ContextEntryInput): Promise<ContextEntryMeta | WattError> {
    const existing = await this.bucket.head(this.key(path));
    const currentVersion = existing === null ? undefined : this.readMeta(existing).version;
    const conflict = checkIfVersion(currentVersion, input.ifVersion);
    if (conflict !== null) return conflict;
    const version = existing === null ? '1' : bumpVersion(currentVersion ?? '0');
    const content =
      typeof input.content === 'string' ? input.content : JSON.stringify(input.content);
    const metadata = input.metadata ?? {};
    const obj = await this.bucket.put(this.key(path), content, {
      customMetadata: {
        contentType: input.contentType,
        version,
        metadata: JSON.stringify(metadata),
      },
    });
    return {
      uri: contextUri(this.namespace, path),
      contentType: input.contentType,
      size: obj.size,
      version,
      updatedAt: obj.uploaded.toISOString(),
      metadata,
    };
  }

  async update(path: string, patch: ContextPatch): Promise<ContextEntryMeta | WattError> {
    const obj = await this.bucket.get(this.key(path));
    const existing = requireExisting(obj, path);
    if ('code' in existing) return existing;
    const meta = this.readMeta(existing);
    const conflict = checkIfVersion(meta.version, patch.ifVersion);
    if (conflict !== null) return conflict;
    const content = await existing.text();
    const current: ContextEntry = { ...this.objToMeta(path, existing), content };
    const merged = applyPatch(current, patch);
    const version = bumpVersion(meta.version);
    const mergedContent =
      typeof merged.content === 'string' ? merged.content : JSON.stringify(merged.content);
    const written = await this.bucket.put(this.key(path), mergedContent, {
      customMetadata: {
        contentType: merged.contentType,
        version,
        metadata: JSON.stringify(merged.metadata),
      },
    });
    return {
      uri: contextUri(this.namespace, path),
      contentType: merged.contentType,
      size: written.size,
      version,
      updatedAt: written.uploaded.toISOString(),
      metadata: merged.metadata,
    };
  }

  async delete_(path: string): Promise<void | WattError> {
    await this.bucket.delete(this.key(path));
  }
}

function bumpVersion(current: string): string {
  const n = Number.parseInt(current, 10);
  return Number.isFinite(n) ? String(n + 1) : '1';
}
