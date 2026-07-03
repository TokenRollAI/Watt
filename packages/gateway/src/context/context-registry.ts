/**
 * ContextRegistry Durable Object（Proto §4.2）——namespace 挂载注册表。
 *
 * 定位（Architecture.md M3 / 附B）：三大 Registry 之一，Registry DO（挂载表 SQLite）+ TTL 回收。
 * 落地照 event-router.ts 的原生 DurableObject + ctx.storage.sql 模式（不套 Agents SDK：挂载表
 *   是纯注册协调，无 Agent 的 state 广播/WS 语义）。单例 idFromName('registry')。
 *
 * mounts 表（构造器 IF NOT EXISTS 建）：
 *   namespace PK / provider / provider_config(JSON) / ttl(秒) / read_only(0|1) /
 *   mounted_at(ISO, TTL 起算点) / expires_at(mounted_at + ttl, 便于 alarm 扫描; nullable)。
 *
 * RPC（§0.4 Registry 四动词 + Delete + Resolve）：
 * - list(opts) → Page<NamespaceMount>（limit 默认 50 钳 200）。
 * - get(ns) → NamespaceMount | not_found。
 * - write(mount) → 挂载 upsert（重挂载刷新 mounted_at/expires_at）。
 * - update(ns, patch) → 部分更新（不存在 → not_found）。
 * - delete(ns) → 卸载（幂等 no-op）。
 * - resolve(uri) → { provider, path }（core resolveMount + 惰性 TTL：isExpired → 删行 + not_found）。
 *
 * TTL 回收（调研 §4 + P3 项 5）：主逻辑惰性判定（每次 resolve/get/list 访问时 isExpired → 删挂载行
 *   + 物理清理 provider 存储 + not_found）；物理 GC 用原生 ctx.storage.setAlarm 兜底（alarm 时扫
 *   expires_at 删过期挂载行 + 清理 provider 存储）。
 *   provider 数据物理清理（P3 项 5，修复"重挂同名 namespace 复活旧数据"）：过期回收对 provider 存储做
 *   真实清理——object:R2 分批 delete；structured/vector:D1 DELETE WHERE namespace；vector 的
 *   Vectorize 向量凭 D1 path 集合 deleteByIds。best-effort（单库失败 console.error 不阻塞挂载行删除）。
 *   注意：unmount（registry Delete）保持只卸载不清数据——§4.2 Delete=卸载，数据保留是实现声明
 *   （doc-gap 候选）；只有 TTL 过期回收才物理清理。
 *   provider 绑定来源：DO 的 env 携带全部资源绑定（DB_CONTEXT/R2_CONTEXT_OBJECTS/VECTORIZE_CONTEXT/AI），
 *   故清理在 DO 内完成，惰性与 alarm 两路径收敛（无需路由层参与，alarm 路径也覆盖）。
 */

import { DurableObject } from 'cloudflare:workers';
import { isExpired, type NamespaceMount, namespaceMountSchema, resolveMount } from '@watt/core';
import { type WattError, wattError } from '@watt/shared';
import type { Bindings } from '../env.ts';
import { ObjectContextProvider } from './providers/object.ts';
import { StructuredContextProvider } from './providers/structured.ts';
import { VectorContextProvider } from './providers/vector.ts';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** list 入参（§0.2 ListOptions 子集；cursor 分页延后 doc-gap #22）。 */
export interface ListMountsOptions {
  limit?: number;
}

/** Proto Page<T>（§0.2）。 */
export interface Page<T> {
  items: T[];
}

interface MountRow extends Record<string, SqlStorageValue> {
  namespace: string;
  provider: string;
  provider_config: string | null;
  ttl: number | null;
  read_only: number;
  mounted_at: string;
  expires_at: string | null;
}

function rowToMount(row: MountRow): NamespaceMount {
  const mount: NamespaceMount = {
    namespace: row.namespace,
    provider: row.provider,
  };
  if (row.provider_config !== null) {
    mount.providerConfig = JSON.parse(row.provider_config) as Record<string, unknown>;
  }
  if (row.ttl !== null) mount.ttl = row.ttl;
  if (row.read_only === 1) mount.readOnly = true;
  return mount;
}

/** mounted_at + ttl → ISO expires_at（ttl 缺省 → null，永不过期）。 */
function computeExpiresAt(mountedAt: string, ttl: number | undefined): string | null {
  if (ttl === undefined) return null;
  return new Date(Date.parse(mountedAt) + ttl * 1000).toISOString();
}

export class ContextRegistry extends DurableObject {
  private readonly sql: DurableObjectState['storage']['sql'];
  private readonly storage: DurableObjectState['storage'];
  private readonly bindings: Bindings;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx as never, env as never);
    this.storage = ctx.storage;
    this.sql = ctx.storage.sql;
    this.bindings = env as Bindings;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS mounts (
         namespace       TEXT PRIMARY KEY,
         provider        TEXT NOT NULL,
         provider_config TEXT,
         ttl             INTEGER,
         read_only       INTEGER NOT NULL DEFAULT 0,
         mounted_at      TEXT NOT NULL,
         expires_at      TEXT
       )`,
    );
  }

  /** list（§4.2）——返回 Page，limit 默认 50 钳 200。惰性 TTL：过期挂载不返回并顺手清理（含 provider 数据）。 */
  async list(opts: ListMountsOptions = {}): Promise<Page<NamespaceMount>> {
    const rawLimit = opts.limit ?? DEFAULT_LIST_LIMIT;
    const limit = Math.max(1, Math.min(rawLimit, MAX_LIST_LIMIT));
    const rows = this.sql
      .exec<MountRow>('SELECT * FROM mounts ORDER BY namespace LIMIT ?', limit)
      .toArray();
    const now = Date.now();
    const items: NamespaceMount[] = [];
    for (const row of rows) {
      if (isExpired(row.mounted_at, row.ttl ?? undefined, now)) {
        await this.reclaim(row);
        continue;
      }
      items.push(rowToMount(row));
    }
    return { items };
  }

  /** get（§4.2）——不存在或已过期 → not_found（过期时顺手清理挂载行 + provider 数据）。 */
  async get(namespace: string): Promise<NamespaceMount | WattError> {
    const row = this.readRow(namespace);
    if (row === null) {
      return wattError('not_found', `no mount for namespace: ${namespace}`, false);
    }
    if (isExpired(row.mounted_at, row.ttl ?? undefined, Date.now())) {
      await this.reclaim(row);
      return wattError('not_found', `no mount for namespace: ${namespace}`, false);
    }
    return rowToMount(row);
  }

  /**
   * write（§4.2）——挂载或整体替换（upsert）。重挂载刷新 mounted_at/expires_at（TTL 重新起算）。
   * 入参经 namespaceMountSchema 校验；非法 → invalid_argument。
   */
  async write(mount: NamespaceMount): Promise<NamespaceMount | WattError> {
    const parsed = namespaceMountSchema.safeParse(mount);
    if (!parsed.success) {
      return wattError('invalid_argument', `invalid mount: ${parsed.error.message}`, false);
    }
    const m = parsed.data;
    const mountedAt = new Date().toISOString();
    const expiresAt = computeExpiresAt(mountedAt, m.ttl);
    this.sql.exec(
      `INSERT INTO mounts (namespace, provider, provider_config, ttl, read_only, mounted_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(namespace) DO UPDATE SET
         provider = excluded.provider,
         provider_config = excluded.provider_config,
         ttl = excluded.ttl,
         read_only = excluded.read_only,
         mounted_at = excluded.mounted_at,
         expires_at = excluded.expires_at`,
      m.namespace,
      m.provider,
      m.providerConfig !== undefined ? JSON.stringify(m.providerConfig) : null,
      m.ttl ?? null,
      m.readOnly ? 1 : 0,
      mountedAt,
      expiresAt,
    );
    await this.scheduleGc(expiresAt);
    return m;
  }

  /**
   * update（§4.2）——部分更新挂载（不存在 → not_found）。patch 为 Partial<NamespaceMount>，
   * namespace 不可改（以 path 参数定位）。ttl 变更时重算 expires_at（mounted_at 保持不变）。
   */
  update(namespace: string, patch: Partial<NamespaceMount>): Promise<NamespaceMount | WattError> {
    return this.updateImpl(namespace, patch);
  }

  private async updateImpl(
    namespace: string,
    patch: Partial<NamespaceMount>,
  ): Promise<NamespaceMount | WattError> {
    const row = this.readRow(namespace);
    if (row === null) {
      return wattError('not_found', `no mount for namespace: ${namespace}`, false);
    }
    const current = rowToMount(row);
    const merged: NamespaceMount = {
      ...current,
      ...patch,
      namespace, // namespace 以定位参数为准，不被 patch 改。
    };
    const parsed = namespaceMountSchema.safeParse(merged);
    if (!parsed.success) {
      return wattError('invalid_argument', `invalid mount patch: ${parsed.error.message}`, false);
    }
    const m = parsed.data;
    // mounted_at 保持不变（update 非重挂载）；ttl 变更时基于原 mounted_at 重算 expires_at。
    const expiresAt = computeExpiresAt(row.mounted_at, m.ttl);
    this.sql.exec(
      `UPDATE mounts SET provider = ?, provider_config = ?, ttl = ?, read_only = ?, expires_at = ?
       WHERE namespace = ?`,
      m.provider,
      m.providerConfig !== undefined ? JSON.stringify(m.providerConfig) : null,
      m.ttl ?? null,
      m.readOnly ? 1 : 0,
      expiresAt,
      namespace,
    );
    await this.scheduleGc(expiresAt);
    return m;
  }

  /** delete（§4.2）——卸载（unmount）。不存在为幂等 no-op。 */
  delete(namespace: string): void {
    this.sql.exec('DELETE FROM mounts WHERE namespace = ?', namespace);
  }

  /**
   * resolve（§4.2）——uri → { provider, path }。全表挂载做 core resolveMount 最长前缀匹配，
   * 命中后惰性 TTL：isExpired → 删挂载行 + 清理 provider 数据 + not_found（"过期即不可达"语义）。
   */
  async resolve(uri: string): Promise<{ provider: string; path: string } | WattError> {
    const rows = this.sql.exec<MountRow>('SELECT * FROM mounts').toArray();
    const now = Date.now();
    const live: MountRow[] = [];
    for (const row of rows) {
      if (isExpired(row.mounted_at, row.ttl ?? undefined, now)) {
        await this.reclaim(row);
        continue;
      }
      live.push(row);
    }
    const resolved = resolveMount(uri, live.map(rowToMount));
    if ('code' in resolved) return resolved;
    return { provider: resolved.mount.provider, path: resolved.path };
  }

  /**
   * alarm 兜底 GC（物理清理过期挂载行 + provider 数据）——扫 expires_at <= now 的行，
   * 逐行清理 provider 存储后删挂载行。删后若仍有未来到期项，重设下一个 alarm。
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const expired = this.sql
      .exec<MountRow>(
        'SELECT * FROM mounts WHERE expires_at IS NOT NULL AND expires_at <= ?',
        nowIso,
      )
      .toArray();
    for (const row of expired) {
      await this.reclaim(row);
    }
    // 重设至下一个最近到期时刻（若有）。
    const next = this.sql
      .exec<{ expires_at: string }>(
        'SELECT expires_at FROM mounts WHERE expires_at IS NOT NULL ORDER BY expires_at ASC LIMIT 1',
      )
      .toArray();
    if (next.length > 0 && next[0] !== undefined) {
      await this.storage.setAlarm(Date.parse(next[0].expires_at));
    }
  }

  /**
   * 挂载有 TTL 时设置/前移 alarm 到最近到期时刻（兜底物理 GC）。
   * setAlarm 幂等覆盖：取现有 alarm 与新 expires_at 的较早者。
   */
  private async scheduleGc(expiresAt: string | null): Promise<void> {
    if (expiresAt === null) return;
    const at = Date.parse(expiresAt);
    const existing = await this.storage.getAlarm();
    if (existing === null || at < existing) {
      await this.storage.setAlarm(at);
    }
  }

  private readRow(namespace: string): MountRow | null {
    const rows = this.sql
      .exec<MountRow>('SELECT * FROM mounts WHERE namespace = ?', namespace)
      .toArray();
    return rows.length > 0 ? (rows[0] ?? null) : null;
  }

  /**
   * TTL 过期回收单行（P3 项 5）：先物理清理 provider 存储（best-effort），再删挂载行。
   * 清理失败仅 console.error，不阻塞挂载行删除（否则一个坏绑定会让过期挂载永不回收）。
   */
  private async reclaim(row: MountRow): Promise<void> {
    try {
      await this.purgeProviderData(row.provider, row.namespace);
    } catch (err) {
      console.error(
        `context TTL reclaim: purge provider data failed (namespace=${row.namespace}, provider=${row.provider})`,
        err,
      );
    }
    this.sql.exec('DELETE FROM mounts WHERE namespace = ?', row.namespace);
  }

  /**
   * 物理清理某 provider 某 namespace 的全部数据（内置 provider 走各自 purgeNamespace）。
   * plugin/未知 provider 无内置存储可清（数据在 plugin 侧）——记 doc-gap 候选，此处 no-op。
   * DO 的 env 携带 DB_CONTEXT/R2_CONTEXT_OBJECTS/VECTORIZE_CONTEXT，故清理在 DO 内完成。
   */
  private async purgeProviderData(provider: string, namespace: string): Promise<void> {
    const env = this.bindings;
    switch (provider) {
      case 'object':
        await new ObjectContextProvider(env.R2_CONTEXT_OBJECTS, namespace).purgeNamespace();
        return;
      case 'structured':
        await new StructuredContextProvider(env.DB_CONTEXT, namespace).purgeNamespace();
        return;
      case 'vector':
        // purge 不 embed（只 D1 DELETE + Vectorize deleteByIds）——注入 no-op embedder。
        await new VectorContextProvider(
          env.DB_CONTEXT,
          {
            upsert: async () => undefined,
            query: async () => ({ matches: [] }),
            deleteByIds: async (ids) => await env.VECTORIZE_CONTEXT.deleteByIds(ids),
          },
          { embed: async () => [] },
          namespace,
        ).purgeNamespace();
        return;
      default:
        return; // plugin provider：存储在 plugin 侧，DO 无从清理（doc-gap 候选）。
    }
  }
}
