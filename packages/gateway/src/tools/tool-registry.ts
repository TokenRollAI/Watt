/**
 * ToolRegistry（Proto §5.2 工具源挂载管理）——ToolMount 管理面，D1 持久化。
 *
 * 库：watt-providers（binding DB_PROVIDERS），表 tool_mounts（见 migrations-providers/0001_tool_registry.sql）。
 * 接口（§5.2 四动词）：
 * - list(opts)：§0.2 ListOptions/Page；limit 默认 50 钳 200；非法 filter 键 → invalid_argument。
 * - get(mountPath)：不存在 → not_found（WattError）。
 * - write(mount)：幂等 upsert（相同 path 覆盖）。
 * - update(mountPath, patch)：patch 已有；目标不存在 → not_found。patch 经
 *   toolMountSchema.omit({path}).partial().strict() 校验：path 不可变、未知键 → invalid_argument
 *   （对齐 ChannelStore/PolicyStore.update 的 patch 白名单语义）。
 *
 * provider_config / virtualize 以 JSON 对象字符串存（可空）；enabled 以 0/1 存（SQLite 无 boolean）。
 * 凭证不落库明文：providerConfig 承载 secretRef 引用名，实际密钥走 Secrets（Reference §2 / M4）。
 */

import type { D1Database } from '@cloudflare/workers-types';
import { type ToolMount, type ToolVirtualize, toolMountSchema } from '@watt/core';
import { type WattError, wattError } from '@watt/shared';

interface ToolMountRow {
  path: string;
  provider: string;
  provider_config: string | null;
  virtualize: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function rowToMount(row: ToolMountRow): ToolMount {
  const mount: ToolMount = {
    path: row.path,
    provider: row.provider,
    enabled: row.enabled !== 0,
  };
  if (row.provider_config !== null) {
    mount.providerConfig = JSON.parse(row.provider_config) as Record<string, unknown>;
  }
  if (row.virtualize !== null) {
    mount.virtualize = JSON.parse(row.virtualize) as ToolVirtualize;
  }
  return mount;
}

/** Proto ListOptions（§0.2）。 */
export interface ListOptions {
  cursor?: string;
  limit?: number;
  filter?: Record<string, string>;
}

/** Proto Page<T>（§0.2）。cursor 分页延后（对齐 ChannelStore，doc-gap #22）。 */
export interface Page<T> {
  items: T[];
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** ToolRegistry.List 未声明专门 filter（§5.2）；保守拒一切未知键（对齐 ChannelStore）。 */
const ALLOWED_LIST_FILTER_KEYS = new Set<string>([]);

/** Update patch 校验：path 不可变、其余字段可选、拒未知键（strict）。 */
const toolMountPatchSchema = toolMountSchema.omit({ path: true }).partial().strict();

export class ToolRegistry {
  constructor(private readonly db: D1Database) {}

  /** List（§5.2 / §0.2）——返回 Page<ToolMount>，limit 默认 50 钳 200。 */
  async list(opts: ListOptions = {}): Promise<Page<ToolMount> | WattError> {
    const filter = opts.filter ?? {};
    for (const key of Object.keys(filter)) {
      if (!ALLOWED_LIST_FILTER_KEYS.has(key)) {
        return wattError('invalid_argument', `unknown filter key: ${key}`, false);
      }
    }
    const rawLimit = opts.limit ?? DEFAULT_LIST_LIMIT;
    // 下界钳到 1：负数直通 SQLite LIMIT -1 会拉全表，0 会拉空集，均非预期（对齐 ChannelStore）。
    const limit = Math.max(1, Math.min(rawLimit, MAX_LIST_LIMIT));
    const { results } = await this.db
      .prepare('SELECT * FROM tool_mounts ORDER BY created_at LIMIT ?')
      .bind(limit)
      .all<ToolMountRow>();
    return { items: results.map(rowToMount) };
  }

  /** Get（§5.2 / §0.4）——不存在 → not_found（WattError）。 */
  async get(mountPath: string): Promise<ToolMount | WattError> {
    const row = await this.db
      .prepare('SELECT * FROM tool_mounts WHERE path = ?')
      .bind(mountPath)
      .first<ToolMountRow>();
    if (row === null) {
      return wattError('not_found', `tool mount not found: ${mountPath}`, false);
    }
    return rowToMount(row);
  }

  /** Write（§0.4）——幂等 upsert（相同 path 覆盖）。 */
  async write(mount: ToolMount, now: string = new Date().toISOString()): Promise<ToolMount> {
    await this.db
      .prepare(
        `INSERT INTO tool_mounts (path, provider, provider_config, virtualize, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           provider = excluded.provider,
           provider_config = excluded.provider_config,
           virtualize = excluded.virtualize,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .bind(
        mount.path,
        mount.provider,
        mount.providerConfig === undefined ? null : JSON.stringify(mount.providerConfig),
        mount.virtualize === undefined ? null : JSON.stringify(mount.virtualize),
        mount.enabled ? 1 : 0,
        now,
        now,
      )
      .run();
    return mount;
  }

  /**
   * Update（§0.4）——patch 已有；目标不存在 → not_found。
   * patch 经 strict schema 校验：path 不可变、未知键 → invalid_argument。
   */
  async update(
    mountPath: string,
    patch: Partial<Omit<ToolMount, 'path'>>,
    now: string = new Date().toISOString(),
  ): Promise<ToolMount | WattError> {
    const parsed = toolMountPatchSchema.safeParse(patch);
    if (!parsed.success) {
      return wattError(
        'invalid_argument',
        `invalid tool mount patch: ${parsed.error.message}`,
        false,
      );
    }
    const existing = await this.get(mountPath);
    if ('code' in existing) {
      return existing; // not_found
    }
    const merged: ToolMount = { ...existing, ...parsed.data, path: mountPath };
    await this.write(merged, now);
    return merged;
  }
}
