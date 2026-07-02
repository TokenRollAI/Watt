/**
 * PolicyStore（Proto §6.2）——D1 持久化。
 *
 * 库：watt-policies（binding DB_POLICIES），表 policies（见 migrations/0001_auth_core.sql）。
 * 接口：List / Get / Write(upsert 幂等) / Update(patch, not_found) / Delete（+ 判定供数查询）。
 *
 * Proto 四动词语义（§0.4）：
 * - Write：幂等 upsert（相同 id 覆盖），无 id 则由调用方指定或生成。
 * - Update：patch 已有记录；目标不存在 → not_found（WattError）。
 * - Delete：Proto 的 PolicyStore 未列 Delete；`watt policy rm` 需要一个下线动作（doc-gap #7）。
 *   本实现以物理 D1 DELETE 落地 rm，作为实现层扩展（已在 PROGRESS/reflection 声明）。
 *
 * KV 判定缓存本轮**跳过**（调研报告标注实现自由；先正确后快）。判定直接查 D1：
 * ResolveCandidatePolicies 按 subject IN (sub, role:*, agent:*, agent-instance:*, '*') 一次拉全，
 * authorize() 在内存做 resource 前缀 + action 匹配 + deny 优先。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { Policy, TokenClaims } from '@watt/core';
import { type WattError, wattError } from '@watt/shared';

interface PolicyRow {
  id: string;
  subject: string;
  resource: string;
  actions: string; // JSON array string
  effect: string;
  condition: string | null; // JSON object string
  created_at: string;
  updated_at: string;
}

function rowToPolicy(row: PolicyRow): Policy {
  const policy: Policy = {
    id: row.id,
    subject: row.subject,
    resource: row.resource,
    actions: JSON.parse(row.actions) as string[],
    effect: row.effect as Policy['effect'],
  };
  if (row.condition) {
    policy.condition = JSON.parse(row.condition) as Record<string, string>;
  }
  return policy;
}

/**
 * Proto ListOptions（§0.2）——List 的整体入参对象（不平铺）。
 * filter 键集合由各接口声明；PolicyStore.List 只认 subject（§6.2）。
 */
export interface ListOptions {
  cursor?: string;
  limit?: number;
  filter?: Record<string, string>;
}

/** Proto Page<T>（§0.2）。Phase 1 不做 cursor 分页，省略 cursor 字段（留后续 Phase）。 */
export interface Page<T> {
  items: T[];
  // cursor?: string  // Phase 1 未实现游标分页；接入分页时补齐（Proto §0.2）。
}

/** List 的默认页大小与上限（Proto §0.2 规范默认）。 */
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** PolicyStore.List 声明的合法 filter 键集合（§6.2 只按 subject 过滤）。 */
const ALLOWED_LIST_FILTER_KEYS = new Set(['subject']);

export class PolicyStore {
  constructor(private readonly db: D1Database) {}

  /**
   * List（§6.2 / §0.2）——接受 Proto ListOptions（filter.subject），返回 Page<Policy>。
   * limit 默认 50、上限 200（超限静默钳制）；未声明的 filter 键 → invalid_argument。
   * 按调用者权限裁剪由上层 Authorizer 负责；此处返回全量/按 subject 过滤。
   */
  async list(opts: ListOptions = {}): Promise<Page<Policy> | WattError> {
    const filter = opts.filter ?? {};
    for (const key of Object.keys(filter)) {
      if (!ALLOWED_LIST_FILTER_KEYS.has(key)) {
        return wattError('invalid_argument', `unknown filter key: ${key}`, false);
      }
    }
    const rawLimit = opts.limit ?? DEFAULT_LIST_LIMIT;
    const limit = Math.min(rawLimit, MAX_LIST_LIMIT);
    const subject = filter.subject;

    let stmt: ReturnType<D1Database['prepare']>;
    if (subject !== undefined) {
      stmt = this.db
        .prepare('SELECT * FROM policies WHERE subject = ? ORDER BY created_at LIMIT ?')
        .bind(subject, limit);
    } else {
      stmt = this.db.prepare('SELECT * FROM policies ORDER BY created_at LIMIT ?').bind(limit);
    }
    const { results } = await stmt.all<PolicyRow>();
    return { items: results.map(rowToPolicy) };
  }

  /** Get（§0.4）——不存在返回 null（调用方转 not_found）。 */
  async get(id: string): Promise<Policy | null> {
    const row = await this.db
      .prepare('SELECT * FROM policies WHERE id = ?')
      .bind(id)
      .first<PolicyRow>();
    return row ? rowToPolicy(row) : null;
  }

  /** Write（§0.4）——幂等 upsert（相同 id 覆盖）。 */
  async write(policy: Policy, now: string = new Date().toISOString()): Promise<Policy> {
    const actions = JSON.stringify(policy.actions);
    const condition = policy.condition ? JSON.stringify(policy.condition) : null;
    await this.db
      .prepare(
        `INSERT INTO policies (id, subject, resource, actions, effect, condition, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           subject = excluded.subject,
           resource = excluded.resource,
           actions = excluded.actions,
           effect = excluded.effect,
           condition = excluded.condition,
           updated_at = excluded.updated_at`,
      )
      .bind(policy.id, policy.subject, policy.resource, actions, policy.effect, condition, now, now)
      .run();
    return policy;
  }

  /**
   * Update（§0.4）——patch 已有；目标不存在 → not_found。
   * patch 允许改 subject/resource/actions/effect/condition；id 不可变。
   */
  async update(
    id: string,
    patch: Partial<Omit<Policy, 'id'>>,
    now: string = new Date().toISOString(),
  ): Promise<Policy | WattError> {
    const existing = await this.get(id);
    if (existing === null) {
      return wattError('not_found', `policy not found: ${id}`, false);
    }
    const merged: Policy = { ...existing, ...patch, id };
    const actions = JSON.stringify(merged.actions);
    const condition = merged.condition ? JSON.stringify(merged.condition) : null;
    await this.db
      .prepare(
        `UPDATE policies SET subject = ?, resource = ?, actions = ?, effect = ?, condition = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(merged.subject, merged.resource, actions, merged.effect, condition, now, id)
      .run();
    return merged;
  }

  /**
   * Delete——物理删除（实现层扩展，承载 `watt policy rm`；doc-gap #7）。
   * 目标不存在 → not_found（幂等语义可按需放宽，此处保守报 not_found）。
   */
  async delete(id: string): Promise<WattError | { deleted: true }> {
    const existing = await this.get(id);
    if (existing === null) {
      return wattError('not_found', `policy not found: ${id}`, false);
    }
    await this.db.prepare('DELETE FROM policies WHERE id = ?').bind(id).run();
    return { deleted: true };
  }

  /**
   * 判定供数（§6.4c 步骤 1）：按 claims 的 subject 候选集一次拉全部候选 Policy，
   * 避免逐 Policy 往返 D1。候选 subject = sub + role:<每个角色> + agent:<def> + agent-instance:<inst> + '*'。
   */
  async resolveCandidatePolicies(claims: TokenClaims): Promise<Policy[]> {
    const subjects = new Set<string>(['*', claims.sub]);
    for (const r of claims.roles) subjects.add(`role:${r}`);
    if (claims.agent_def) subjects.add(`agent:${claims.agent_def}`);
    if (claims.agent_inst) subjects.add(`agent-instance:${claims.agent_inst}`);
    const list = [...subjects];
    const placeholders = list.map(() => '?').join(', ');
    const { results } = await this.db
      .prepare(`SELECT * FROM policies WHERE subject IN (${placeholders})`)
      .bind(...list)
      .all<PolicyRow>();
    return results.map(rowToPolicy);
  }
}
