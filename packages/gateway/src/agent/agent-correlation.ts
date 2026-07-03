/**
 * AgentCorrelation Durable Object —— correlation 等待表宿主（Proto §3.4 结果回传协议）。
 *
 * core CorrelationTable（packages/core/src/agent/correlation.ts）是纯状态机接口；此 DO 以
 * ctx.storage.sql 实现同语义的**持久化**版本，是六条路由规则的判定数据源：
 *   register  → 登记等待方（waiter）+ 产出方实例 + 超时时刻 + traceId；
 *   hasPending→ 是否有记录（区分规则 5「从未登记」与规则 6「已 settled」）；
 *   resolve   → 首次返回 waiter 并 settle，再次 null（规则 6 去重 / 规则 3 超时后晚到丢弃）；
 *   expire    → alarm 到期扫描：对未 settled 且到期的 correlation 代发 agent.failed(reason='timeout')
 *               **直投等待方**（规则 3），投递成功后才置 settled（幂等：真实结果晚到 → resolve 返 null → 丢弃）；
 *   failWaiter→ 某等待方被 Terminate（规则 4）：其名下未 settled correlation 代发
 *               agent.failed(reason='terminated') 直投，并置 settled——等待方不悬挂。
 *
 * 代发投递路径（2026-07-03 修正，BLOCKER）：代发的 agent.failed **不能**绕道 QUEUE_EVENTS 回
 *   consumer.routeResult——那条路径会 hasPending=true（记录尚在）+ resolve=null（已 settled）→
 *   被判 drop-duplicate 丢弃，等待方永远收不到超时/终止通知。故本 DO **先读 waiter、直投其实例
 *   onEvent（AGENT_INSTANCE stub），投递成功后才 settle**（timeout 投递失败不 settle，留下次
 *   alarm 重试；terminated 投递失败仍 settle 但留痕审计——无 alarm 复扫，尽力交付防僵尸）。
 *   同时经 EventStore.put 留痕（对齐 publishOutcome，§2.4）。task waiter 走 Phase 5 Workflows
 *   waitForEvent（此处占位记 console 并 settle）。
 *
 * 用原生 DurableObject + ctx.storage.sql（非 Agents SDK）：correlation 表是纯路由协调，
 * 无 Agent 的 state 广播/WS/schedule 语义——与 EventRouter 同源选型（调研报告问题 2）。
 * 单例：调用方固定 idFromName('correlation')（correlation 全局唯一表；量级扩展点见 EventRouter）。
 *
 * alarm：register 时以最早未 settled 的 timeout_at_ms 设 alarm；alarm 触发 → expire → 代发 →
 * 重排下一个 alarm。DO alarm 单调，用 storage.setAlarm（幂等取最小时刻）。
 * alarm 顺带 sweep 已 terminated 超过 TERMINATED_TTL_MS 的实例索引行（惰性清理，防无限增长）。
 */

import { DurableObject } from 'cloudflare:workers';
import type { Event } from '@watt/core';
import { getAgentByName } from 'agents';
import type { Bindings } from '../env.ts';
import type { AgentInstance, AgentInstanceRpc } from './agent-instance.ts';

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

/**
 * DO env 中 correlation 代发所需的绑定：
 * - AGENT_INSTANCE：直投等待方实例 onEvent（agent waiter，规则 1/2 定向回送，BLOCKER 修正）；
 * - DB_EVENTS：EventStore.put 留痕（§2.4，对齐 publishOutcome）。
 */
type CorrelationEnv = Pick<Bindings, 'AGENT_INSTANCE' | 'DB_EVENTS'>;

const AGENT_FAILED_TYPE = 'agent.failed';

/** terminated 实例索引行的保留期（alarm sweep 清理阈值，实现声明）：7 天。 */
const TERMINATED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** subtree 逐层查的每批 IN(...) 参数上限（SQLite 变量数保守值，避免超参数限制）。 */
const SUBTREE_BATCH = 100;

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

  /** 列全部实例（§3.2 ListInstances；分页钳制 limit ≤ 200，§0.2 规范默认）。 */
  listInstances(limit = 200): InstanceRow[] {
    const bounded = Math.max(1, Math.min(limit, 200));
    return this.sql
      .exec<InstanceRow>('SELECT * FROM instances ORDER BY created_at LIMIT ?', bounded)
      .toArray();
  }

  /**
   * 取某实例的完整派生子树（§3.2 tree=<instanceId>）——含根，逐层 BFS 查 parent_id。
   * 不走 listInstances(200)：级联终止/子树可视化必须覆盖全部后代，200 全量硬上限会截断
   * 深/宽子树（2026-07-03 修正）。逐层 `WHERE parent_id IN (...)` 分批查（每批 ≤ SUBTREE_BATCH），
   * 用 visited 防环（parent_id 理论无环，防御坏数据不致死循环）。
   */
  subtree(rootId: string): InstanceRow[] {
    const root = this.getInstance(rootId);
    if (root === null) return [];
    const out: InstanceRow[] = [root];
    const visited = new Set<string>([rootId]);
    let frontier: string[] = [rootId];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (let i = 0; i < frontier.length; i += SUBTREE_BATCH) {
        const batch = frontier.slice(i, i + SUBTREE_BATCH);
        const placeholders = batch.map(() => '?').join(',');
        const children = this.sql
          .exec<InstanceRow>(
            `SELECT * FROM instances WHERE parent_id IN (${placeholders})`,
            ...batch,
          )
          .toArray();
        for (const child of children) {
          if (visited.has(child.instance_id)) continue;
          visited.add(child.instance_id);
          out.push(child);
          next.push(child.instance_id);
        }
      }
      frontier = next;
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

  /**
   * 解析：首次返回 waiter 并 settle；已 settled/delivering/不存在 → null（规则 6 去重 / 规则 5 无记录）。
   * 原子读+settle——用于内部判定路径（测试直接驱动）。投递路径请用 peekForDelivery+confirm/rollback。
   */
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
   * §3.4 定向回送投递的第一步（peek）：首次命中 pending correlation → 置中间态 'delivering'（settled=2）
   * 并返回 waiter；已 delivering/settled/不存在 → null（并发去重：DO 单线程保证 peek 原子占位）。
   * 投递成功后调 confirmDelivery（→ settled=1），失败调 rollbackDelivery（→ 回 pending，消息 retry 重放）。
   * 两步拆分修复「先 settle 后投递 + consumer 吞错 ack → 投递失败结果永久丢失」（2026-07-03 MAJOR）。
   */
  peekForDelivery(correlationId: string): Waiter | null {
    const rows = this.sql
      .exec<CorrelationRow>(
        'SELECT * FROM correlations WHERE correlation_id = ? AND settled = 0',
        correlationId,
      )
      .toArray();
    const row = rows[0];
    if (row === undefined) return null;
    this.sql.exec('UPDATE correlations SET settled = 2 WHERE correlation_id = ?', correlationId);
    return { kind: row.waiter_kind as Waiter['kind'], id: row.waiter_id };
  }

  /** 投递成功 → 置终态 settled（仅当前为 delivering 时生效）。 */
  confirmDelivery(correlationId: string): void {
    this.sql.exec(
      'UPDATE correlations SET settled = 1 WHERE correlation_id = ? AND settled = 2',
      correlationId,
    );
  }

  /** 投递失败 → 回滚到 pending（仅当前为 delivering 时生效），供消息 retry 重放。 */
  rollbackDelivery(correlationId: string): void {
    this.sql.exec(
      'UPDATE correlations SET settled = 0 WHERE correlation_id = ? AND settled = 2',
      correlationId,
    );
  }

  /**
   * 规则 4 终止即失败：产出方实例（correlation 的 instance_id）被 Terminate（含级联）→ 其名下
   * 未 settled correlation 代发 agent.failed(reason='terminated') **直投等待方**，并 settle——
   * 等待方不悬挂。返回代发的 correlationId。genId/nowIso 注入以保持可测。
   * 注：匹配 instance_id（被终止的产出方）而非 waiter_id——终止的是即将产结果的子/目标实例。
   * 同时清理被终止实例**作为 waiter** 的未 settled correlation（MINOR 2026-07-03）：防 alarm/结果
   *   继续向已终止的等待方代发/投递（该实例 onEvent 已拒收，投递纯属浪费且记误导审计）——直接 settle，
   *   不代发（等待方自己已消失，规则 5「等待方先消失」语义）。
   * terminated 投递失败仍 settle（无 alarm 复扫，尽力交付防僵尸；EventStore 留痕供审计）。
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
      await this.emitFailed(row, 'terminated', genId, nowIso);
      // terminated 无 alarm 复扫，无论投递成败都 settle（尽力交付；失败已 EventStore 留痕）。
      this.sql.exec(
        'UPDATE correlations SET settled = 1 WHERE correlation_id = ?',
        row.correlation_id,
      );
      ids.push(row.correlation_id);
    }
    // 该实例作为 waiter 的未 settled correlation：等待方已消失（规则 5）→ 直接 settle 不代发。
    this.sql.exec(
      "UPDATE correlations SET settled = 1 WHERE waiter_id = ? AND waiter_kind = 'agent' AND settled = 0",
      instanceId,
    );
    return ids;
  }

  /**
   * alarm 处理：扫描到期未 settled correlation → 代发 agent.failed(reason='timeout')（规则 3），
   * 直投成功后置 settled（幂等：真实结果晚到 → resolve 返 null → drop-duplicate），再重排下一 alarm。
   * 顺带 sweep 已 terminated 超过 TERMINATED_TTL_MS 的实例索引行（惰性清理）。
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    await this.expireNow(now);
    this.sweepTerminated(now);
    await this.rescheduleAlarm();
  }

  /**
   * 到期扫描并直投代发（可注入 nowMs / genId / nowIso 便于测试直接驱动，不依赖真实 alarm 时钟）。
   * timeout 投递成功才 settle；投递失败保持未 settled，留下次 alarm 复扫重试（等待方不悬挂）。
   * 返回本次成功 settle 的 correlationId 列表。
   */
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
      const delivered = await this.emitFailed(row, 'timeout', genId, nowIso);
      if (!delivered) continue; // 投递失败：不 settle，下次 alarm 重试。
      this.sql.exec(
        'UPDATE correlations SET settled = 1 WHERE correlation_id = ?',
        row.correlation_id,
      );
      ids.push(row.correlation_id);
    }
    return ids;
  }

  /** 删除 terminated 超过 TERMINATED_TTL_MS 的实例索引行（created_at 为 ISO；无 created_at 视为不清）。 */
  private sweepTerminated(nowMs: number): void {
    const cutoffIso = new Date(nowMs - TERMINATED_TTL_MS).toISOString();
    this.sql.exec(
      "DELETE FROM instances WHERE state = 'terminated' AND created_at <> '' AND created_at <= ?",
      cutoffIso,
    );
  }

  /**
   * 构造一个 agent.failed 事件并**直投等待方**（source.kind='system'，平台代发）。返回是否投递成功。
   * agent waiter → AGENT_INSTANCE stub.onEvent({event})（绕开 QUEUE→routeResult→resolve 的自吞路径）；
   * task waiter → Phase 5 Workflows waitForEvent（占位记 console，视为已投递）。
   * 无论投递成败均先 EventStore.put 留痕（§2.4，对齐 publishOutcome；put 失败不阻塞投递）。
   */
  private async emitFailed(
    row: CorrelationRow,
    reason: 'timeout' | 'terminated',
    genId: () => string,
    nowIso: () => string,
  ): Promise<boolean> {
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
    // 留痕（§2.4）：代发 failed 直投不经 event-bus，须自行 EventStore.put，否则留痕面查不到。
    try {
      const { EventStore } = await import('../event/event-store.ts');
      await new EventStore(this.correlationEnv.DB_EVENTS).put(event);
    } catch (err) {
      console.error('correlation: emitFailed event store put failed', {
        correlationId: row.correlation_id,
        err: String(err),
      });
    }
    if (row.waiter_kind === 'task') {
      // Task 等待方 → Phase 5 Workflows waitForEvent（占位）；视为已投递（不阻塞 settle）。
      console.log('correlation: task waiter failed delivery deferred to Phase 5', {
        correlationId: row.correlation_id,
        waiter: row.waiter_id,
        reason,
      });
      return true;
    }
    // agent 等待方 → 直投其实例 onEvent（规则 1/2 定向回送，绕开 QUEUE 自吞）。
    try {
      const stub = await getAgentByName<Cloudflare.Env, AgentInstance>(
        this.correlationEnv.AGENT_INSTANCE,
        row.waiter_id,
      );
      const rpc = stub as unknown as AgentInstanceRpc;
      await rpc.onEvent({ event });
      return true;
    } catch (err) {
      console.error('correlation: emitFailed direct delivery to waiter failed', {
        correlationId: row.correlation_id,
        waiter: row.waiter_id,
        reason,
        err: String(err),
      });
      return false;
    }
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
