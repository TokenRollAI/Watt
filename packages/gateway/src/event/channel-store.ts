/**
 * ChannelStore（Proto §2.2 ChannelRegistry）——渠道配置管理，D1 持久化。
 *
 * 库：watt-events（binding DB_EVENTS），表 channels（见 migrations-events/0001_event_gateway.sql）。
 * 接口（§2.2 四动词）：
 * - list(opts)：§0.2 ListOptions/Page；limit 默认 50 钳 200；非法 filter 键 → invalid_argument。
 * - get(channelId)：不存在 → not_found（WattError）。
 * - write(config)：幂等 upsert（相同 id 覆盖）。
 * - update(channelId, patch)：patch 已有；目标不存在 → not_found。patch 经
 *   channelConfigSchema.omit({id}).partial().strict() 校验：id 不可变、未知键 → invalid_argument
 *   （对齐 PolicyStore.update 的 patch 白名单语义）。
 *
 * settings 以 JSON 对象字符串存；enabled 以 0/1 存（SQLite 无 boolean）；defaultAgent 可空。
 */

import type { D1Database } from '@cloudflare/workers-types';
import { type ChannelConfig, channelConfigSchema } from '@watt/core';
import { type WattError, wattError } from '@watt/shared';

interface ChannelRow {
  id: string;
  adapter: string;
  enabled: number;
  settings: string;
  default_agent: string | null;
  created_at: string;
  updated_at: string;
}

function rowToConfig(row: ChannelRow): ChannelConfig {
  const config: ChannelConfig = {
    id: row.id,
    adapter: row.adapter,
    enabled: row.enabled !== 0,
    settings: JSON.parse(row.settings) as Record<string, unknown>,
  };
  if (row.default_agent !== null) {
    config.defaultAgent = row.default_agent;
  }
  return config;
}

/** Proto ListOptions（§0.2）。 */
export interface ListOptions {
  cursor?: string;
  limit?: number;
  filter?: Record<string, string>;
}

/** Proto Page<T>（§0.2）。cursor 分页延后（doc-gap #22）。 */
export interface Page<T> {
  items: T[];
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** ChannelRegistry.List 未声明专门 filter（§2.2）；保守拒一切未知键。 */
const ALLOWED_LIST_FILTER_KEYS = new Set<string>([]);

/** Update patch 校验：id 不可变、其余字段可选、拒未知键（strict）。 */
const channelPatchSchema = channelConfigSchema.omit({ id: true }).partial().strict();

export class ChannelStore {
  constructor(private readonly db: D1Database) {}

  /** List（§2.2 / §0.2）——返回 Page<ChannelConfig>，limit 默认 50 钳 200。 */
  async list(opts: ListOptions = {}): Promise<Page<ChannelConfig> | WattError> {
    const filter = opts.filter ?? {};
    for (const key of Object.keys(filter)) {
      if (!ALLOWED_LIST_FILTER_KEYS.has(key)) {
        return wattError('invalid_argument', `unknown filter key: ${key}`, false);
      }
    }
    const rawLimit = opts.limit ?? DEFAULT_LIST_LIMIT;
    // 下界钳到 1：负数直通 SQLite LIMIT -1 会拉全表，0 会拉空集，均非预期。
    const limit = Math.max(1, Math.min(rawLimit, MAX_LIST_LIMIT));
    const { results } = await this.db
      .prepare('SELECT * FROM channels ORDER BY created_at LIMIT ?')
      .bind(limit)
      .all<ChannelRow>();
    return { items: results.map(rowToConfig) };
  }

  /** Get（§2.2 / §0.4）——不存在 → not_found（WattError）。 */
  async get(channelId: string): Promise<ChannelConfig | WattError> {
    const row = await this.db
      .prepare('SELECT * FROM channels WHERE id = ?')
      .bind(channelId)
      .first<ChannelRow>();
    if (row === null) {
      return wattError('not_found', `channel not found: ${channelId}`, false);
    }
    return rowToConfig(row);
  }

  /** Write（§0.4）——幂等 upsert（相同 id 覆盖）。 */
  async write(
    config: ChannelConfig,
    now: string = new Date().toISOString(),
  ): Promise<ChannelConfig> {
    await this.db
      .prepare(
        `INSERT INTO channels (id, adapter, enabled, settings, default_agent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           adapter = excluded.adapter,
           enabled = excluded.enabled,
           settings = excluded.settings,
           default_agent = excluded.default_agent,
           updated_at = excluded.updated_at`,
      )
      .bind(
        config.id,
        config.adapter,
        config.enabled ? 1 : 0,
        JSON.stringify(config.settings),
        config.defaultAgent ?? null,
        now,
        now,
      )
      .run();
    return config;
  }

  /**
   * Update（§0.4）——patch 已有；目标不存在 → not_found。
   * patch 经 strict schema 校验：id 不可变、未知键 → invalid_argument。
   */
  async update(
    channelId: string,
    patch: Partial<Omit<ChannelConfig, 'id'>>,
    now: string = new Date().toISOString(),
  ): Promise<ChannelConfig | WattError> {
    const parsed = channelPatchSchema.safeParse(patch);
    if (!parsed.success) {
      return wattError('invalid_argument', `invalid channel patch: ${parsed.error.message}`, false);
    }
    const existing = await this.get(channelId);
    if ('code' in existing) {
      return existing; // not_found
    }
    const merged: ChannelConfig = { ...existing, ...parsed.data, id: channelId };
    await this.write(merged, now);
    return merged;
  }
}
