/**
 * EventRouter Durable Object（Proto §2.3 / Architecture M1 Event Bus + Session Mapper）。
 *
 * 定位（Architecture.md M1）：EventBus 分发的订阅表 + Session Mapper（渠道会话↔实例映射）。
 * 落地 = 原生 DurableObject 基类 + ctx.storage.sql（不套 Agents SDK：订阅表/session 粘性是纯
 * 路由协调，无 Agent 的 state 广播/WS/schedule 语义；调研报告问题 2 已定）。
 *
 * 两张表（构造器内 IF NOT EXISTS 建）：
 * - subscriptions(id PK, match_json, sink_json)——订阅规则。id 平台生成（crypto.randomUUID）。
 * - session_instances(instance_key PK, definition, session, created_at)——Session Mapper 语义：
 *   同一 session 恒定映射到同一 Agent 实例键。Phase 2 只存取（为 Phase 4 真实 spawn 铺垫）。
 *
 * matchSubscriptions 用 core matchesSubscription 过滤：Phase 2 订阅量级很小，拉全表在内存过滤
 * 即可（订阅规模化时改为按 type 前缀预筛的扩展点）。
 *
 * 单例路由：调用方固定 idFromName('router')，全局单一 router（量级扩展点——订阅分片时按
 * channel/tenant 派生多 router）。
 */

import { DurableObject } from 'cloudflare:workers';
import {
  type Event,
  matchesSubscription,
  resolveInstanceKey,
  type Subscription,
  type SubscriptionMatch,
  type SubscriptionSink,
  subscriptionSchema,
} from '@watt/core';

// DurableObjectState / SqlStorageValue 用 @cloudflare/workers-types ambient global（tsconfig types）。

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** listSubscriptions 入参（§0.2 ListOptions 子集；cursor 分页延后，doc-gap #22）。 */
export interface ListSubscriptionsOptions {
  limit?: number;
}

/** Proto Page<T>（§0.2）。 */
export interface Page<T> {
  items: T[];
}

interface SubscriptionRow extends Record<string, SqlStorageValue> {
  id: string;
  match_json: string;
  sink_json: string;
}

function rowToSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    match: JSON.parse(row.match_json) as SubscriptionMatch,
    sink: JSON.parse(row.sink_json) as SubscriptionSink,
  };
}

export class EventRouter extends DurableObject {
  private readonly sql: DurableObjectState['storage']['sql'];

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx as never, env as never);
    this.sql = ctx.storage.sql;
    // 建表（幂等）。DO storage SQLite 就地持久化，无需 D1 migrations。
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS subscriptions (
         id         TEXT PRIMARY KEY,
         match_json TEXT NOT NULL,
         sink_json  TEXT NOT NULL
       )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS session_instances (
         instance_key TEXT PRIMARY KEY,
         definition   TEXT NOT NULL,
         session      TEXT,
         created_at   TEXT NOT NULL
       )`,
    );
  }

  /**
   * subscribe（§2.3）——登记订阅，id 由平台生成（crypto.randomUUID）。
   * 入参经 subscriptionSchema 校验；返回生成的 subscriptionId。
   */
  subscribe(sub: Subscription): { subscriptionId: string } {
    const parsed = subscriptionSchema.parse(sub);
    const id = parsed.id ?? crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO subscriptions (id, match_json, sink_json) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET match_json = excluded.match_json, sink_json = excluded.sink_json`,
      id,
      JSON.stringify(parsed.match),
      JSON.stringify(parsed.sink),
    );
    return { subscriptionId: id };
  }

  /** unsubscribe（§2.3）——按 id 删除；不存在为幂等 no-op。 */
  unsubscribe(id: string): void {
    this.sql.exec('DELETE FROM subscriptions WHERE id = ?', id);
  }

  /** listSubscriptions（§2.3 / §0.2）——返回 Page，limit 默认 50 钳 200。 */
  listSubscriptions(opts: ListSubscriptionsOptions = {}): Page<Subscription> {
    const rawLimit = opts.limit ?? DEFAULT_LIST_LIMIT;
    const limit = Math.min(rawLimit, MAX_LIST_LIMIT);
    const rows = this.sql
      .exec<SubscriptionRow>('SELECT id, match_json, sink_json FROM subscriptions LIMIT ?', limit)
      .toArray();
    return { items: rows.map(rowToSubscription) };
  }

  /**
   * matchSubscriptions（§2.3）——返回命中给定事件的订阅。
   * 拉全表用 core matchesSubscription 过滤（Phase 2 订阅量级很小；规模化时按 type 前缀预筛）。
   */
  matchSubscriptions(event: Event): Subscription[] {
    const rows = this.sql
      .exec<SubscriptionRow>('SELECT id, match_json, sink_json FROM subscriptions')
      .toArray();
    return rows.map(rowToSubscription).filter((sub) => matchesSubscription(event, sub.match));
  }

  /**
   * resolveSessionInstance（§2.3 / §3.1 Session Mapper）——对 agent sink 用 core
   * resolveInstanceKey 求实例键并 upsert session_instances（为 Phase 4 真实 spawn 铺垫）。
   * - 非 agent sink 或 session 缺失 → core 返回 error，此处透传 { error }，不落库。
   * - 成功 → 落 { instanceKey, definition, session } 并返回 { instanceKey }。
   */
  resolveSessionInstance(
    sink: SubscriptionSink,
    event: Event,
  ): { instanceKey: string } | { error: string } {
    const result = resolveInstanceKey(sink, event);
    if ('error' in result) {
      return { error: result.error.message };
    }
    // 仅 agent sink 能走到这里（resolveInstanceKey 对非 agent 返回 error）。
    const definition = sink.kind === 'agent' ? sink.definition : '';
    this.sql.exec(
      `INSERT INTO session_instances (instance_key, definition, session, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(instance_key) DO NOTHING`,
      result.key,
      definition,
      event.session ?? null,
      new Date().toISOString(),
    );
    return { instanceKey: result.key };
  }
}
