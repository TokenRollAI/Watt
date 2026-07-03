/**
 * ModelProviderRegistry（Proto §9 最小版）——模型渠道管理面，D1 持久化。
 *
 * 库：watt-providers（binding DB_PROVIDERS），表 model_providers（migrations-providers/0003）。
 * 接口（§9 四动词 + set-default）：
 * - list/get：返回**脱敏投影**（不含 secretRef，§9「永不回显」）。
 * - write：幂等 upsert；default=true 时先清其余 default（全局默认唯一，§9 L861 由实现保证）。
 * - update：patch 已有；不存在 → not_found；含 default=true 同样清其余。
 * - setDefault(id)：把某渠道设为唯一默认（Case 5「切默认」）。
 *
 * secretRef 存引用名（永不回显明文）；llm harness 经 resolveDefault/resolve 取渠道 base/model
 *   （缺省 env 直连——Phase 4 最小版，AI Gateway custom provider 留 M8 规范路径）。
 */

import type { D1Database } from '@cloudflare/workers-types';
import { type ModelProvider, type ModelProviderPublic, modelProviderSchema } from '@watt/core';
import { type WattError, wattError } from '@watt/shared';

// ModelProvider / modelProviderSchema 从 @watt/core 消费（gateway 不直接 import zod，坑 §26）。

interface ModelProviderRow {
  id: string;
  vendor: string;
  models_json: string;
  priority: number;
  is_default: number;
  secret_ref: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function rowToPublic(row: ModelProviderRow): ModelProviderPublic {
  return {
    id: row.id,
    vendor: row.vendor,
    models: JSON.parse(row.models_json) as string[],
    priority: row.priority,
    default: row.is_default !== 0,
    enabled: row.enabled !== 0,
  };
}

/** Proto ListOptions（§0.2）。 */
export interface ListOptions {
  cursor?: string;
  limit?: number;
  filter?: Record<string, string>;
}

/** Proto Page<T>（§0.2）。 */
export interface Page<T> {
  items: T[];
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const ALLOWED_LIST_FILTER_KEYS = new Set<string>([]);

/** Update patch 校验：id 不可变、其余可选、拒未知键（strict）。 */
const modelProviderPatchSchema = modelProviderSchema.omit({ id: true }).partial().strict();

export class ModelProviderRegistry {
  constructor(private readonly db: D1Database) {}

  /** List（§9 / §0.2）——脱敏投影，limit 默认 50 钳 200。 */
  async list(opts: ListOptions = {}): Promise<Page<ModelProviderPublic> | WattError> {
    const filter = opts.filter ?? {};
    for (const key of Object.keys(filter)) {
      if (!ALLOWED_LIST_FILTER_KEYS.has(key)) {
        return wattError('invalid_argument', `unknown filter key: ${key}`, false);
      }
    }
    const rawLimit = opts.limit ?? DEFAULT_LIST_LIMIT;
    const limit = Math.max(1, Math.min(rawLimit, MAX_LIST_LIMIT));
    const { results } = await this.db
      .prepare('SELECT * FROM model_providers ORDER BY priority, created_at LIMIT ?')
      .bind(limit)
      .all<ModelProviderRow>();
    return { items: results.map(rowToPublic) };
  }

  /** Get（§9 / §0.4）——脱敏投影；不存在 → not_found。 */
  async get(providerId: string): Promise<ModelProviderPublic | WattError> {
    const row = await this.getRow(providerId);
    if (row === null)
      return wattError('not_found', `model provider not found: ${providerId}`, false);
    return rowToPublic(row);
  }

  /** Write（§0.4）——幂等 upsert；default=true → 先清其余 default（全局唯一）。 */
  async write(
    provider: ModelProvider,
    now: string = new Date().toISOString(),
  ): Promise<ModelProviderPublic> {
    if (provider.default) await this.clearDefaults(provider.id);
    await this.db
      .prepare(
        `INSERT INTO model_providers
           (id, vendor, models_json, priority, is_default, secret_ref, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           vendor = excluded.vendor, models_json = excluded.models_json,
           priority = excluded.priority, is_default = excluded.is_default,
           secret_ref = excluded.secret_ref, enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .bind(
        provider.id,
        provider.vendor,
        JSON.stringify(provider.models),
        provider.priority,
        provider.default ? 1 : 0,
        provider.secretRef,
        provider.enabled ? 1 : 0,
        now,
        now,
      )
      .run();
    return rowToPublic((await this.getRow(provider.id)) as ModelProviderRow);
  }

  /** Update（§0.4）——patch 已有；不存在 → not_found；default=true 清其余。 */
  async update(
    providerId: string,
    patch: Partial<Omit<ModelProvider, 'id'>>,
    now: string = new Date().toISOString(),
  ): Promise<ModelProviderPublic | WattError> {
    const parsed = modelProviderPatchSchema.safeParse(patch);
    if (!parsed.success) {
      return wattError(
        'invalid_argument',
        `invalid provider patch: ${parsed.error.message}`,
        false,
      );
    }
    const row = await this.getRow(providerId);
    if (row === null)
      return wattError('not_found', `model provider not found: ${providerId}`, false);
    const current: ModelProvider = { ...rowToPublic(row), secretRef: row.secret_ref };
    const merged: ModelProvider = { ...current, ...parsed.data, id: providerId };
    return this.write(merged, now);
  }

  /** setDefault（Case 5 切默认）——把某渠道设唯一默认；不存在 → not_found。 */
  async setDefault(
    providerId: string,
    now: string = new Date().toISOString(),
  ): Promise<ModelProviderPublic | WattError> {
    const row = await this.getRow(providerId);
    if (row === null)
      return wattError('not_found', `model provider not found: ${providerId}`, false);
    await this.clearDefaults(providerId);
    await this.db
      .prepare('UPDATE model_providers SET is_default = 1, updated_at = ? WHERE id = ?')
      .bind(now, providerId)
      .run();
    return rowToPublic((await this.getRow(providerId)) as ModelProviderRow);
  }

  /**
   * 解析当前默认渠道的路由信息（llm harness 用；secretRef 内部可见，不出接口）。
   * 无默认 → null（harness 回退 env 直连）。
   */
  async resolveDefault(): Promise<{ vendor: string; model: string; secretRef: string } | null> {
    const row = await this.db
      .prepare('SELECT * FROM model_providers WHERE is_default = 1 AND enabled = 1 LIMIT 1')
      .first<ModelProviderRow>();
    if (row === null) return null;
    const models = JSON.parse(row.models_json) as string[];
    return { vendor: row.vendor, model: models[0] ?? '', secretRef: row.secret_ref };
  }

  private async getRow(id: string): Promise<ModelProviderRow | null> {
    return this.db
      .prepare('SELECT * FROM model_providers WHERE id = ?')
      .bind(id)
      .first<ModelProviderRow>();
  }

  /** 清除除 exceptId 外所有渠道的 default 标记（全局默认唯一，§9 L861）。 */
  private async clearDefaults(exceptId: string): Promise<void> {
    await this.db
      .prepare('UPDATE model_providers SET is_default = 0 WHERE id != ? AND is_default = 1')
      .bind(exceptId)
      .run();
  }
}
