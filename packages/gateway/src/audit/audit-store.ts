/**
 * AuditStore（Proto §10 AuditLog / AuditRecord）——D1 持久化，库 watt-audit（binding DB_AUDIT）。
 * 表 audit_records（migrations-audit/0001）。R23 Observability 地基。
 *
 * 写入方：**Authorizer.check 单点收口**（每个 Check 判定点 allow/deny 都写一条，PEP 横切）——
 *   见 authz/authorizer.ts。写失败 best-effort（审计不阻塞业务，调用方 console.error 后继续）。
 *
 * 读取方：AuditLog.List（filter principal/agent/resource/decision，§10）+ Get(id)。
 * List 分页对齐 §0.2 Page<T> 形状 `{items}`（当前无 cursor 分页，与 TaskStore/EventStore 一致）；
 *   limit 默认 50 上限 200（对齐 §6.2 风格 / TaskStore）。
 *
 * 手写 SQL（对齐 TaskStore/EventStore）：D1 无 ORM，prepare+bind。
 */

import type { D1Database } from '@cloudflare/workers-types';
import { type CallContext, callContextSchema } from '@watt/core';
import { type WattError, wattError } from '@watt/shared';

/** AuditRecord（Proto §10 L902-910）。context = 完整 CallContext 派生链。 */
export interface AuditRecord {
  id: string;
  at: string;
  context: CallContext;
  resource: string;
  action: string;
  decision: 'allow' | 'deny';
  detail?: unknown;
}

/** 写入入参（Authorizer 传入；id/at 由 store 生成）。 */
export interface AuditWrite {
  context: CallContext;
  resource: string;
  action: string;
  decision: 'allow' | 'deny';
  detail?: unknown;
}

/** Proto ListOptions（§0.2）——filter=principal/agent/resource/decision（§10 List 语义）。 */
export interface ListOptions {
  cursor?: string;
  limit?: number;
  filter?: Record<string, string>;
}
export interface Page<T> {
  items: T[];
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** §10 List 合法 filter 键：principal/agent/resource/decision（未声明键 → invalid_argument，§0.2）。 */
const ALLOWED_FILTER_KEYS = new Set(['principal', 'agent', 'resource', 'decision']);

interface AuditRow {
  id: string;
  at: string;
  context: string;
  principal: string;
  agent_inst: string | null;
  resource: string;
  action: string;
  decision: string;
  detail: string | null;
}

function rowToRecord(row: AuditRow): AuditRecord {
  const context = callContextSchema.parse(JSON.parse(row.context));
  const record: AuditRecord = {
    id: row.id,
    at: row.at,
    context,
    resource: row.resource,
    action: row.action,
    decision: row.decision as 'allow' | 'deny',
  };
  if (row.detail !== null) record.detail = JSON.parse(row.detail) as unknown;
  return record;
}

export class AuditStore {
  constructor(private readonly db: D1Database) {}

  /**
   * 写一条 AuditRecord（Authorizer.check 每个判定点调）。
   * principal/agent_inst 从 context 冗余提列存储便于 filter。
   */
  async write(w: AuditWrite): Promise<AuditRecord> {
    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    const agentInst = w.context.agent?.instanceId ?? null;
    const detailJson = w.detail === undefined ? null : JSON.stringify(w.detail);
    await this.db
      .prepare(
        `INSERT INTO audit_records
           (id, at, context, principal, agent_inst, resource, action, decision, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        at,
        JSON.stringify(w.context),
        w.context.principal,
        agentInst,
        w.resource,
        w.action,
        w.decision,
        detailJson,
      )
      .run();
    return {
      id,
      at,
      context: w.context,
      resource: w.resource,
      action: w.action,
      decision: w.decision,
      ...(w.detail === undefined ? {} : { detail: w.detail }),
    };
  }

  /** Get(id)——不存在 → not_found（§10）。 */
  async get(id: string): Promise<AuditRecord | WattError> {
    const row = await this.db
      .prepare('SELECT * FROM audit_records WHERE id = ?')
      .bind(id)
      .first<AuditRow>();
    if (row === null) return wattError('not_found', `audit record not found: ${id}`, false);
    return rowToRecord(row);
  }

  /**
   * List（§10）——filter principal/agent/resource/decision（前缀匹配 resource，精确匹配其余）。
   * limit 默认 50 上限 200；按 at 倒序（最新在前）。未声明 filter 键 → invalid_argument
   * （§0.2；对齐 PolicyStore.list——静默忽略会让调用方误以为条件已收窄）。
   */
  async list(opts: ListOptions = {}): Promise<Page<AuditRecord> | WattError> {
    const filter = opts.filter ?? {};
    const where: string[] = [];
    const binds: string[] = [];
    for (const [key, value] of Object.entries(filter)) {
      if (!ALLOWED_FILTER_KEYS.has(key)) {
        return wattError('invalid_argument', `unknown filter key: ${key}`, false);
      }
      if (key === 'agent') {
        where.push('agent_inst = ?');
        binds.push(value);
      } else if (key === 'resource') {
        // resource 前缀匹配（对齐 Policy 前缀语义：List by resource 树段）。
        where.push('resource LIKE ?');
        binds.push(`${value}%`);
      } else {
        where.push(`${key} = ?`);
        binds.push(value);
      }
    }
    const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await this.db
      .prepare(`SELECT * FROM audit_records ${whereClause} ORDER BY at DESC LIMIT ?`)
      .bind(...binds, limit)
      .all<AuditRow>();
    return { items: (rows.results ?? []).map(rowToRecord) };
  }
}
