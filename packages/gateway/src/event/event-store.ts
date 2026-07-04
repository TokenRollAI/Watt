/**
 * EventStore（Proto §2.4）——留痕查询，D1 持久化。
 *
 * 库：watt-events（binding DB_EVENTS），表 events（见 migrations-events/0001_event_gateway.sql）。
 * 接口：
 * - list(opts)：§2.4 filter=type/channel/session/时间范围（since/until），§0.2 ListOptions/Page。
 *   limit 默认 50 钳 200；非法 filter 键 → invalid_argument（对齐 PolicyStore.list）。
 *   按 occurred_at 倒序（tail 语义：最新在前）。cursor 分页延后（doc-gap #22）。
 * - get(eventId)：不存在 → not_found（WattError）。
 * - put(event)：幂等 upsert（相同 id 覆盖），写完整信封 + 拆出的索引列。
 * - findByDedupeKey(key, now, windowMs?)：§2.3 Publish 幂等——返回窗内既存 eventId 或 null。
 *   记录时刻取事件的 occurred_at；窗默认对齐 core DEFAULT_DEDUPE_WINDOW_MS（24h）。
 */

import type { D1Database } from '@cloudflare/workers-types';
import { DEFAULT_DEDUPE_WINDOW_MS, type Event, eventSchema } from '@watt/core';
import { type WattError, wattError } from '@watt/shared';

interface EventRow {
  id: string;
  type: string;
  source_kind: string;
  channel: string | null;
  session: string | null;
  principal: string | null;
  dedupe_key: string | null;
  trace_id: string;
  occurred_at: string;
  envelope: string;
}

function rowToEvent(row: EventRow): Event {
  // envelope 存整信封；解析后经 schema 校验保证读出形状与 Event 契约一致。
  return eventSchema.parse(JSON.parse(row.envelope));
}

/** Proto ListOptions（§0.2）——List 的整体入参对象（不平铺）。 */
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

/** EventStore.List 合法 filter 键集合（§2.4：type/channel/session/correlationId/时间范围）。 */
const ALLOWED_LIST_FILTER_KEYS = new Set([
  'type',
  'channel',
  'session',
  'correlationId',
  'since',
  'until',
]);

export class EventStore {
  constructor(private readonly db: D1Database) {}

  /**
   * List（§2.4 / §0.2）——filter=type/channel/session/correlationId/since/until，返回 Page<Event>。
   * limit 默认 50、上限 200（超限静默钳制）；未声明的 filter 键 → invalid_argument。
   * since 含端（>=）、until 不含端（<），按 occurred_at 倒序。
   * correlationId 匹配 payload.correlationId（agent.result/agent.failed 的定向回送载荷）——
   * 非索引列走 json_extract 全扫，配合 type/since 收窄使用（留痕库 30 天量级可接受）。
   */
  async list(opts: ListOptions = {}): Promise<Page<Event> | WattError> {
    const filter = opts.filter ?? {};
    for (const key of Object.keys(filter)) {
      if (!ALLOWED_LIST_FILTER_KEYS.has(key)) {
        return wattError('invalid_argument', `unknown filter key: ${key}`, false);
      }
    }
    const rawLimit = opts.limit ?? DEFAULT_LIST_LIMIT;
    // 下界 1、上界 200：负数/0 若直通 SQLite LIMIT（-1 = 无限）会拉全表，故先钳到 [1, 200]。
    const limit = Math.max(1, Math.min(rawLimit, MAX_LIST_LIMIT));

    const clauses: string[] = [];
    const binds: string[] = [];
    if (filter.type !== undefined) {
      clauses.push('type = ?');
      binds.push(filter.type);
    }
    if (filter.channel !== undefined) {
      clauses.push('channel = ?');
      binds.push(filter.channel);
    }
    if (filter.session !== undefined) {
      clauses.push('session = ?');
      binds.push(filter.session);
    }
    if (filter.correlationId !== undefined) {
      clauses.push(`json_extract(envelope, '$.payload.correlationId') = ?`);
      binds.push(filter.correlationId);
    }
    if (filter.since !== undefined) {
      clauses.push('occurred_at >= ?');
      binds.push(filter.since);
    }
    if (filter.until !== undefined) {
      clauses.push('occurred_at < ?');
      binds.push(filter.until);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const { results } = await this.db
      .prepare(`SELECT * FROM events${where} ORDER BY occurred_at DESC LIMIT ?`)
      .bind(...binds, limit)
      .all<EventRow>();
    return { items: results.map(rowToEvent) };
  }

  /** Get（§2.4）——不存在 → not_found（WattError）。 */
  async get(eventId: string): Promise<Event | WattError> {
    const row = await this.db
      .prepare('SELECT * FROM events WHERE id = ?')
      .bind(eventId)
      .first<EventRow>();
    if (row === null) {
      return wattError('not_found', `event not found: ${eventId}`, false);
    }
    return rowToEvent(row);
  }

  /** Put——幂等 upsert（相同 id 覆盖），写完整信封 + 拆出的索引列。 */
  async put(event: Event): Promise<Event> {
    await this.db
      .prepare(
        `INSERT INTO events (id, type, source_kind, channel, session, principal, dedupe_key, trace_id, occurred_at, envelope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type,
           source_kind = excluded.source_kind,
           channel = excluded.channel,
           session = excluded.session,
           principal = excluded.principal,
           dedupe_key = excluded.dedupe_key,
           trace_id = excluded.trace_id,
           occurred_at = excluded.occurred_at,
           envelope = excluded.envelope`,
      )
      .bind(
        event.id,
        event.type,
        event.source.kind,
        event.source.channel ?? null,
        event.session ?? null,
        event.principal ?? null,
        event.dedupeKey ?? null,
        event.traceId,
        event.occurredAt,
        JSON.stringify(event),
      )
      .run();
    return event;
  }

  /**
   * Delete——按 id 删除留痕（best-effort 补偿用）。§2.3 Publish 在 queue.send 失败后调用，
   * 抹掉已 put 的记录使同 dedupeKey 重投不被幂等短路。不存在 → 无操作（DELETE 幂等）。
   */
  async delete(eventId: string): Promise<void> {
    await this.db.prepare('DELETE FROM events WHERE id = ?').bind(eventId).run();
  }

  /**
   * findByDedupeKey（§2.3 Publish 幂等）——返回同 dedupeKey 最新一条事件的 eventId，
   * 仅当其 occurred_at 落在 [now - windowMs, now] 窗内；否则（无记录或过窗）返回 null。
   * windowMs 缺省对齐 core DEFAULT_DEDUPE_WINDOW_MS（24h）。now 为 epoch ms（可注入以便测试）。
   */
  async findByDedupeKey(
    dedupeKey: string,
    now: number,
    windowMs: number = DEFAULT_DEDUPE_WINDOW_MS,
  ): Promise<string | null> {
    const row = await this.db
      .prepare(
        'SELECT id, occurred_at FROM events WHERE dedupe_key = ? ORDER BY occurred_at DESC LIMIT 1',
      )
      .bind(dedupeKey)
      .first<{ id: string; occurred_at: string }>();
    if (row === null) return null;
    const storedAt = Date.parse(row.occurred_at);
    if (now - storedAt <= windowMs) return row.id;
    return null;
  }
}
