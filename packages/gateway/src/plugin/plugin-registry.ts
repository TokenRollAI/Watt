/**
 * PluginRegistry（Proto §11.1 Plugin 注册表）+ PluginLifecycle.Health（§11.2）——D1 持久化 + 探活。
 *
 * 库：watt-providers（binding DB_PROVIDERS），表 plugin_registrations（migrations-providers/0004）。
 * 接口（§11.1 四动词）：
 * - list(opts)：§0.2 ListOptions/Page；limit 默认 50 钳 200；filter 支持 kind（§11.2 listDefaults）。
 * - get(id)：不存在 → not_found（WattError）。
 * - write(manifest)：幂等 upsert（相同 id 覆盖）；pluginManifestSchema 校验在路由层。
 *   返回 PluginRegistration（+ platformBaseUrl/jwksUrl/pluginToken，§11.2 注册响应）——路由层组装凭据。
 * - update(id, patch)：目标不存在 → not_found；patch 校验在路由层。
 *
 * Health（§11.2）：built_in（内置 webhook/feishu adapter 种子）直接返回 ok（无外部探活端点，能力在平台内）；
 *   外部 plugin（endpoint 为 HTTPS base）→ GET endpoint+healthPath 探活，2xx → healthy。
 *
 * auth/requiredGrants 以 JSON 字符串存（复杂结构）。pluginToken 不落库（路由层签发，仅 Write 响应回传）。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { PluginAuth, PluginGrant, PluginHealth, PluginKind, PluginManifest } from '@watt/core';
import { type WattError, wattError } from '@watt/shared';

interface PluginRow {
  id: string;
  kind: string;
  interface_version: string;
  endpoint: string;
  auth_json: string;
  required_grants_json: string;
  health_path: string;
  enabled: number;
  built_in: number;
  created_at: string;
  updated_at: string;
}

/** 存储层读投影：manifest + built_in 标记（Health 判定用；对外投影不含 built_in）。 */
export interface StoredPlugin extends PluginManifest {
  builtIn: boolean;
}

function rowToStored(row: PluginRow): StoredPlugin {
  return {
    id: row.id,
    kind: row.kind as PluginKind,
    interfaceVersion: row.interface_version,
    endpoint: row.endpoint,
    auth: JSON.parse(row.auth_json) as PluginAuth,
    requiredGrants: JSON.parse(row.required_grants_json) as PluginGrant[],
    healthPath: row.health_path,
    enabled: row.enabled === 1,
    builtIn: row.built_in === 1,
  };
}

/** 对外 manifest 投影（去掉 built_in 存储细节，§11.1 PluginManifest 形状）。 */
export function toManifest(p: StoredPlugin): PluginManifest {
  const { builtIn: _builtIn, ...manifest } = p;
  return manifest;
}

/** Proto ListOptions（§0.2）。 */
export interface ListOptions {
  cursor?: string;
  limit?: number;
  filter?: Record<string, string>;
}
/** Proto Page<T>（§0.2）。cursor 分页延后（对齐其他 registry，doc-gap #22）。 */
export interface Page<T> {
  items: T[];
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** §11.2 listDefaults：List 合法 filter 键 = kind（其余键 → invalid_argument）。 */
const ALLOWED_LIST_FILTER_KEYS = new Set(['kind']);

export class PluginRegistry {
  constructor(private readonly db: D1Database) {}

  /** List（§11.1 / §0.2）——Page<StoredPlugin>，filter kind，limit 默认 50 钳 200。 */
  async list(opts: ListOptions = {}): Promise<Page<StoredPlugin> | WattError> {
    const filter = opts.filter ?? {};
    for (const key of Object.keys(filter)) {
      if (!ALLOWED_LIST_FILTER_KEYS.has(key)) {
        return wattError('invalid_argument', `unknown filter key: ${key}`, false);
      }
    }
    const rawLimit = opts.limit ?? DEFAULT_LIST_LIMIT;
    const limit = Math.max(1, Math.min(rawLimit, MAX_LIST_LIMIT));
    const where: string[] = [];
    const binds: (string | number)[] = [];
    if (typeof filter.kind === 'string') {
      where.push('kind = ?');
      binds.push(filter.kind);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const { results } = await this.db
      .prepare(`SELECT * FROM plugin_registrations ${whereClause} ORDER BY created_at LIMIT ?`)
      .bind(...binds, limit)
      .all<PluginRow>();
    return { items: results.map(rowToStored) };
  }

  /** Get（§11.1 / §0.4）——不存在 → not_found（WattError）。 */
  async get(id: string): Promise<StoredPlugin | WattError> {
    const row = await this.db
      .prepare('SELECT * FROM plugin_registrations WHERE id = ?')
      .bind(id)
      .first<PluginRow>();
    if (row === null) return wattError('not_found', `plugin not found: ${id}`, false);
    return rowToStored(row);
  }

  /**
   * Write（§0.4 / §11.1）——幂等 upsert（相同 id 覆盖）。
   * builtIn 缺省 false（外部注册）；内置种子经 builtIn:true 调用。
   */
  async write(
    manifest: PluginManifest,
    builtIn = false,
    now: string = new Date().toISOString(),
  ): Promise<StoredPlugin> {
    await this.db
      .prepare(
        `INSERT INTO plugin_registrations
           (id, kind, interface_version, endpoint, auth_json, required_grants_json,
            health_path, enabled, built_in, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           interface_version = excluded.interface_version,
           endpoint = excluded.endpoint,
           auth_json = excluded.auth_json,
           required_grants_json = excluded.required_grants_json,
           health_path = excluded.health_path,
           enabled = excluded.enabled,
           built_in = excluded.built_in,
           updated_at = excluded.updated_at`,
      )
      .bind(
        manifest.id,
        manifest.kind,
        manifest.interfaceVersion,
        manifest.endpoint,
        JSON.stringify(manifest.auth),
        JSON.stringify(manifest.requiredGrants),
        manifest.healthPath,
        manifest.enabled ? 1 : 0,
        builtIn ? 1 : 0,
        now,
        now,
      )
      .run();
    return { ...manifest, builtIn };
  }

  /**
   * Update（§0.4）——patch 已有；目标不存在 → not_found。patch 已经路由层 schema 校验。
   * builtIn 保留（内置 adapter 改 enabled 后仍是内置，Health 语义不变）。
   */
  async update(
    id: string,
    patch: Partial<Omit<PluginManifest, 'id'>>,
    now: string = new Date().toISOString(),
  ): Promise<StoredPlugin | WattError> {
    const existing = await this.get(id);
    if ('code' in existing) return existing; // not_found
    const merged: StoredPlugin = { ...existing, ...patch, id };
    await this.write(toManifest(merged), merged.builtIn, now);
    return merged;
  }
}

/**
 * PluginLifecycle.Health（§11.2）——内置 adapter 直接 ok；外部 plugin 探活 GET endpoint+healthPath。
 * fetchImpl 注入便于测试（默认 globalThis.fetch）。探活超时 §11.4e 默认 30s（此处 5s 保守，探活轻）。
 */
export async function pluginHealth(
  plugin: StoredPlugin,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<PluginHealth> {
  if (plugin.builtIn) {
    // 内置 webhook/feishu adapter：能力在平台内（binding:<name>），无外部探活端点 → 恒 healthy。
    return { healthy: true, detail: `built-in ${plugin.kind} (enabled=${plugin.enabled})` };
  }
  // 外部 plugin：endpoint 为 HTTPS base；binding:<name> 引用无从 HTTP 探活 → 视为 healthy（平台内 Worker）。
  if (plugin.endpoint.startsWith('binding:')) {
    return { healthy: true, detail: `in-platform worker (${plugin.endpoint})` };
  }
  const url = `${plugin.endpoint.replace(/\/+$/, '')}${plugin.healthPath}`;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { healthy: false, detail: `health probe returned HTTP ${res.status}` };
    }
    return { healthy: true };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { healthy: false, detail: `health probe failed: ${detail}` };
  }
}

/**
 * 注册时契约校验（Proto §11.1「平台验证契约（探活 + ~help）后挂载」的探活面）——Write 落库前调用。
 * 复用 pluginHealth 语义：外部 HTTPS endpoint GET healthPath 探活；`binding:` 前缀（平台内能力）
 *   无从 HTTP 探活，跳过（恒 healthy）。~help/~describe 契约校验延后（依赖 Help DSL 校验生态，
 *   声明见 doc-gaps #30）——探活失败即拒绝注册（不落库、不签 pluginToken）。
 * fetch 经模块级测试钩子覆盖（vitest-pool-workers 0.18 无 fetchMock 导出，对齐 *ForTests 习惯）。
 */
export async function probeRegistrationHealth(
  manifest: PluginManifest,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<PluginHealth> {
  return pluginHealth({ ...manifest, builtIn: false }, probeFetchOverride ?? fetchImpl);
}

let probeFetchOverride: typeof globalThis.fetch | undefined;

/** 测试专用：覆盖注册探活的 fetch（传 undefined 复原）。 */
export function setRegistrationProbeFetchForTests(f?: typeof globalThis.fetch): void {
  probeFetchOverride = f;
}
