/**
 * AgentCorrelation Durable Object —— correlation 等待表宿主（Proto §3.4 结果回传协议）。
 *
 * core CorrelationTable（packages/core/src/agent/correlation.ts）是纯状态机接口；此 DO 以
 * ctx.storage.sql 实现同语义的**持久化**版本，是六条路由规则的判定数据源：
 *   register  → 登记等待方（waiter）+ 产出方实例 + 超时时刻 + traceId；
 *   hasPending→ 是否有记录（区分规则 5「从未登记」与规则 6「已 settled」）；
 *   resolve   → 首次返回 waiter 并 settle，再次 null（规则 6 去重 / 规则 3 超时后晚到丢弃）；
 *   expire    → alarm 到期扫描：对未 settled 且到期的 correlation 代发 agent.failed(reason='timeout')
 *               回 QUEUE_EVENTS（规则 3），并置 settled（幂等：真实结果晚到 → resolve 返 null → 丢弃）；
 *   failWaiter→ 某等待方被 Terminate（规则 4）：其名下未 settled correlation 代发
 *               agent.failed(reason='terminated') 回 QUEUE_EVENTS，并置 settled——等待方不悬挂。
 *
 * 用原生 DurableObject + ctx.storage.sql（非 Agents SDK）：correlation 表是纯路由协调，
 * 无 Agent 的 state 广播/WS/schedule 语义——与 EventRouter 同源选型（调研报告问题 2）。
 * 单例：调用方固定 idFromName('correlation')（correlation 全局唯一表；量级扩展点见 EventRouter）。
 *
 * alarm：register 时以最早未 settled 的 timeout_at_ms 设 alarm；alarm 触发 → expire → 代发 →
 * 重排下一个 alarm。DO alarm 单调，用 storage.setAlarm（幂等取最小时刻）。
 */

import { DurableObject } from 'cloudflare:workers';
import type { Event } from '@watt/core';

// DurableObjectState / SqlStorageValue / Queue 用 @cloudflare/workers-types ambient global。

/** 等待方（§3.4 规则 1）：Send 调用者（agent 实例）或 Task 步骤。 */
export interface Waiter {
  kind: 'agent' | 'task';
  id: string;
}

interface CorrelationRow extends Record<string, SqlStorageValue> {
  correlation_id: string;
  waiter_kind: string;
  waiter_id: string;
  instance_id: string;
  trace_id: string;
  timeout_at_ms: number;
  settled: number;
}

/** 实例索引行（§3.2 ListInstances / tree）。 */
export interface InstanceRow extends Record<string, SqlStorageValue> {
  instance_id: string;
  definition: string;
  parent_id: string | null;
  state: string;
  created_at: string;
}

/** DO env 中 correlation 代发所需的绑定（QUEUE_EVENTS 用于 send timeout/terminated failed）。 */
interface CorrelationEnv {
  QUEUE_EVENTS: Queue;
}

const AGENT_FAILED_TYPE = 'agent.failed';

export class AgentCorrelation extends DurableObject {
  private readonly sql: DurableObjectState['storage']['sql'];
  private readonly storage: DurableObjectState['storage'];
  private readonly correlationEnv: CorrelationEnv;

  constructor(ctx: DurableObjectState, env: CorrelationEnv) {
    super(ctx as never, env as never);
    this.sql = ctx.storage.sql;
    this.storage = ctx.storage;
    this.correlationEnv = env;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS correlations (
         correlation_id TEXT PRIMARY KEY,
         waiter_kind    TEXT NOT NULL,
         waiter_id      TEXT NOT NULL,
         instance_id    TEXT NOT NULL,
         trace_id       TEXT NOT NULL,
         timeout_at_ms  INTEGER NOT NULL,
         settled        INTEGER NOT NULL DEFAULT 0
       )`,
    );
    // 实例索引（§3.2 ListInstances / tree 派生子树可视化）——Agents SDK 不提供"列所有实例"，
    // 故此单例协调 DO 维护一张实例登记表（instanceId, definition, parent, createdAt, state）。
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS instances (
         instance_id  TEXT PRIMARY KEY,
         definition   TEXT NOT NULL,
         parent_id    TEXT,
         state        TEXT NOT NULL,
         created_at   TEXT NOT NULL
       )`,
    );
  }

  /**
   * 登记一个等待中的 correlation（幂等 upsert）。instanceId = 产出方实例（超时/终止代发时作
   * AgentFailedPayload.instanceId）；traceId 链路透传。登记后重排 alarm 到最早未 settled 时刻。
   */
  async register(
    correlationId: string,
    waiter: Waiter,
    instanceId: string,
    timeoutAtMs: number,
    traceId: string,
  ): Promise<void> {
    this.sql.exec(
      `INSERT INTO correlations (correlation_id, waiter_kind, waiter_id, instance_id, trace_id, timeout_at_ms, settled)
       VALUES (?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(correlation_id) DO UPDATE SET
         waiter_kind = excluded.waiter_kind, waiter_id = excluded.waiter_id,
         instance_id = excluded.instance_id, trace_id = excluded.trace_id,
         timeout_at_ms = excluded.timeout_at_ms, settled = 0`,
      correlationId,
      waiter.kind,
      waiter.id,
      instanceId,
      traceId,
      timeoutAtMs,
    );
    await this.rescheduleAlarm();
  }

  // ─── 实例索引（§3.2 ListInstances / tree）────────────────────────────────

  /** 登记一个实例（Spawn 时调）——幂等 upsert（同 instanceId 覆盖 definition/parent，保留 created_at）。 */
  registerInstance(args: {
    instanceId: string;
    definition: string;
    parentId?: string;
    createdAt: string;
  }): void {
    this.sql.exec(
      `INSERT INTO instances (instance_id, definition, parent_id, state, created_at)
       VALUES (?, ?, ?, 'idle', ?)
       ON CONFLICT(instance_id) DO UPDATE SET
         definition = excluded.definition, parent_id = excluded.parent_id`,
      args.instanceId,
      args.definition,
      args.parentId ?? null,
      args.createdAt,
    );
  }

  /** 更新实例 state（idle/running/waiting/terminated）——Status/Terminate 索引同步。 */
  setInstanceState(instanceId: string, state: string): void {
    this.sql.exec('UPDATE instances SET state = ? WHERE instance_id = ?', state, instanceId);
  }

  /** 取单个实例索引行（不存在 → null）。 */
  getInstance(instanceId: string): InstanceRow | null {
    const rows = this.sql
      .exec<InstanceRow>('SELECT * FROM instances WHERE instance_id = ?', instanceId)
      .toArray();
    return rows[0] ?? null;
  }

  /** 列全部实例（§3.2 ListInstances；limit 钳 200）。 */
  listInstances(limit = 200): InstanceRow[] {
    const bounded = Math.max(1, Math.min(limit, 200));
    return this.sql
      .exec<InstanceRow>('SELECT * FROM instances ORDER BY created_at LIMIT ?', bounded)
      .toArray();
  }

  /** 取某实例的完整派生子树（§3.2 tree=<instanceId>）——含根，BFS 展开 parent_id 关系。 */
  subtree(rootId: string): InstanceRow[] {
    const root = this.getInstance(rootId);
    if (root === null) return [];
    const all = this.listInstances(200);
    const byParent = new Map<string, InstanceRow[]>();
    for (const row of all) {
      const key = row.parent_id ?? '';
      const list = byParent.get(key) ?? [];
      list.push(row);
      byParent.set(key, list);
    }
    const out: InstanceRow[] = [root];
    const queue = [rootId];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      for (const child of byParent.get(id) ?? []) {
        out.push(child);
        queue.push(child.instance_id);
      }
    }
    return out;
  }

  /** 取某实例的直接子实例 id 列表（Terminate cascade 递归用）。 */
  childrenOf(instanceId: string): string[] {
    return this.sql
      .exec<InstanceRow>('SELECT instance_id FROM instances WHERE parent_id = ?', instanceId)
      .toArray()
      .map((r) => r.instance_id);
  }

  /** 是否存在记录（无论 settled）——区分「从未登记」（规则 5）与「已 settled」（规则 6）。 */
  hasPending(correlationId: string): boolean {
    const rows = this.sql
      .exec<CorrelationRow>(
        'SELECT correlation_id FROM correlations WHERE correlation_id = ?',
        correlationId,
      )
      .toArray();
    return rows.length > 0;
  }

  /** 解析：首次返回 waiter 并 settle；已 settled / 不存在 → null（规则 6 去重 / 规则 5 无记录）。 */
  resolve(correlationId: string): Waiter | null {
    const rows = this.sql
      .exec<CorrelationRow>(
        'SELECT * FROM correlations WHERE correlation_id = ? AND settled = 0',
        correlationId,
      )
      .toArray();
    const row = rows[0];
    if (row === undefined) return null;
    this.sql.exec('UPDATE correlations SET settled = 1 WHERE correlation_id = ?', correlationId);
    return { kind: row.waiter_kind as Waiter['kind'], id: row.waiter_id };
  }

  /**
   * 规则 4 终止即失败：产出方实例（correlation 的 instance_id）被 Terminate（含级联）→ 其名下
   * 未 settled correlation 代发 agent.failed(reason='terminated') 回队列，并 settle——等待方不悬挂。
   * 返回代发的 correlationId。genId/nowIso 注入以保持可测（缺省用 crypto/Date）。
   * 注：匹配 instance_id（被终止的产出方）而非 waiter_id——终止的是即将产结果的子/目标实例。
   */
  async failProducer(
    instanceId: string,
    genId: () => string = () => crypto.randomUUID(),
    nowIso: () => string = () => new Date().toISOString(),
  ): Promise<string[]> {
    const rows = this.sql
      .exec<CorrelationRow>(
        'SELECT * FROM correlations WHERE instance_id = ? AND settled = 0',
        instanceId,
      )
      .toArray();
    const ids: string[] = [];
    for (const row of rows) {
      this.sql.exec(
        'UPDATE correlations SET settled = 1 WHERE correlation_id = ?',
        row.correlation_id,
      );
      await this.emitFailed(row, 'terminated', genId, nowIso);
      ids.push(row.correlation_id);
    }
    return ids;
  }

  /**
   * alarm 处理：扫描到期未 settled correlation → 代发 agent.failed(reason='timeout')（规则 3），
   * 置 settled（幂等：真实结果晚到 → resolve 返 null → drop-duplicate），再重排下一 alarm。
   */
  override async alarm(): Promise<void> {
    await this.expireNow(Date.now());
    await this.rescheduleAlarm();
  }

  /** 到期扫描并代发（可注入 nowMs / genId / nowIso 便于测试直接驱动，不依赖真实 alarm 时钟）。 */
  async expireNow(
    nowMs: number,
    genId: () => string = () => crypto.randomUUID(),
    nowIso: () => string = () => new Date().toISOString(),
  ): Promise<string[]> {
    const rows = this.sql
      .exec<CorrelationRow>(
        'SELECT * FROM correlations WHERE settled = 0 AND timeout_at_ms <= ?',
        nowMs,
      )
      .toArray();
    const ids: string[] = [];
    for (const row of rows) {
      this.sql.exec(
        'UPDATE correlations SET settled = 1 WHERE correlation_id = ?',
        row.correlation_id,
      );
      await this.emitFailed(row, 'timeout', genId, nowIso);
      ids.push(row.correlation_id);
    }
    return ids;
  }

  /** 构造并发送一个 agent.failed 事件回 QUEUE_EVENTS（source.kind='system'，平台代发）。 */
  private async emitFailed(
    row: CorrelationRow,
    reason: 'timeout' | 'terminated',
    genId: () => string,
    nowIso: () => string,
  ): Promise<void> {
    const event: Event = {
      id: genId(),
      source: { kind: 'system' },
      type: AGENT_FAILED_TYPE,
      payload: {
        correlationId: row.correlation_id,
        instanceId: row.instance_id,
        reason,
      },
      occurredAt: nowIso(),
      traceId: row.trace_id,
    };
    await this.correlationEnv.QUEUE_EVENTS.send(event);
  }

  /** 重排 alarm 到最早未 settled 的 timeout_at_ms（无未 settled → 清 alarm）。 */
  private async rescheduleAlarm(): Promise<void> {
    const rows = this.sql
      .exec<{ next: number | null }>(
        'SELECT MIN(timeout_at_ms) AS next FROM correlations WHERE settled = 0',
      )
      .toArray();
    const next = rows[0]?.next ?? null;
    if (next === null) {
      await this.storage.deleteAlarm();
    } else {
      await this.storage.setAlarm(next);
    }
  }
}
