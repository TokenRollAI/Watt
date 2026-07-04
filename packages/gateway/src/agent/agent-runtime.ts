/**
 * AgentRuntime 服务层（Proto §3.2 实例生命周期 / §3.4 结果回传协议接线）。
 *
 * 编排 Agents SDK AgentInstance DO（每实例一 DO，getAgentByName 恒路由同名实例）+ AgentCorrelation
 * DO（correlation 等待表 + 实例索引，单例 idFromName('correlation')）+ AgentRegistry（读 definition
 * 决定 harness/model）。
 *
 * 动词（§3.2）：
 * - spawn(req)：instanceKey 幂等（缺省 resolveInstanceKey 从 definition+session 推）→ getAgentByName
 *   → init + registerInstance；expect 存在 → correlation register + 返 correlationId（子实例结果
 *   自动回父：§3.4 规则 2，correlation waiter = 父实例）。派生（parent 传入）→ 父 addChild。
 * - send(id, event, expect?)：getAgentByName → onEvent；expect 存在 → correlation register + 返
 *   correlationId（结果定向回送 Send 调用者：§3.4 规则 1）。
 * - status(id)：读实例索引 + DO state。
 * - terminate(id, {cascade?})：级联终止子树 → 每个实例 markTerminated + setInstanceState；
 *   correlation.failWaiter(实例 id) 代发 agent.failed(reason='terminated')（§3.4 规则 4）。
 * - listInstances(opts&{tree?})：tree=<id> 返子树；否则全列（§3.2）。
 *
 * correlationId 校验（§3.4 L444）：expect.correlationId 显式给时经 core validateCorrelationId；
 *   缺省经 core genCorrelationId 生成（保证合法）。
 */

import {
  type AgentEntry,
  type Event,
  genCorrelationId,
  resolveInstanceKey,
  type SpawnRequest,
  type TokenClaims,
  validateCorrelationId,
} from '@watt/core';
import { type WattError, wattError } from '@watt/shared';
import { getAgentByName } from 'agents';
import type { Bindings } from '../env.ts';
import type { AgentCorrelation, Waiter } from './agent-correlation.ts';
import type { AgentInstance, AgentInstanceRpc, AgentInstanceState } from './agent-instance.ts';
import { AgentRegistry } from './agent-registry.ts';

/** Spawn 返回（§3.2）。 */
export interface SpawnResult {
  instance: AgentInstanceInfo;
  correlationId?: string;
}

/** Send 返回（§3.2）。 */
export interface SendResult {
  accepted: boolean;
  correlationId?: string;
}

/** AgentInstanceInfo（§3.2 L384-392）——对外投影。 */
export interface AgentInstanceInfo {
  instanceId: string;
  definition: string;
  state: AgentInstanceState['status'];
  parent?: string;
  children: string[];
  createdAt: string;
  lastActiveAt: string;
}

/** ExpectSpec（§3.2）——runtime 层入参。 */
export interface ExpectSpec {
  correlationId?: string;
  timeoutMs?: number;
  schema?: unknown;
}

/** 默认 expect 超时（实现声明；未给 timeoutMs 时用；单位 ms）。 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** AgentRuntime 依赖（DO 绑定 + 时钟/genId 注入以便测试）。 */
export interface RuntimeDeps {
  env: Bindings;
  genId: () => string;
  now: () => string;
  nowMs: () => number;
}

/** 生产依赖：真实绑定 + crypto/Date 时钟。 */
export function defaultRuntimeDeps(env: Bindings): RuntimeDeps {
  return {
    env,
    genId: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  };
}

/** 单例 correlation DO stub（correlation 等待表 + 实例索引）。 */
function correlationStub(env: Bindings): DurableObjectStub<AgentCorrelation> {
  return env.AGENT_CORRELATION.get(env.AGENT_CORRELATION.idFromName('correlation'));
}

/** 取 AgentInstance stub（getAgentByName：同名恒路由同实例，§3.2 幂等宿主）。
 *  返回显式 AgentInstanceRpc 接口（RPC 包装的判别式方法会收窄成 never，toolchain-pitfalls §31）。 */
async function instanceStub(env: Bindings, instanceKey: string): Promise<AgentInstanceRpc> {
  const stub = await getAgentByName<Cloudflare.Env, AgentInstance>(env.AGENT_INSTANCE, instanceKey);
  return stub as unknown as AgentInstanceRpc;
}

/** DO state → 对外 AgentInstanceInfo。 */
function toInfo(instanceId: string, s: AgentInstanceState): AgentInstanceInfo {
  return {
    instanceId,
    definition: s.definition,
    state: s.status,
    parent: s.parent,
    children: s.children,
    createdAt: s.createdAt,
    lastActiveAt: s.lastActiveAt,
  };
}

export class AgentRuntime {
  private readonly registry: AgentRegistry;
  constructor(private readonly deps: RuntimeDeps) {
    this.registry = new AgentRegistry(deps.env.DB_PROVIDERS);
  }

  /**
   * Spawn（§3.2）——创建/复用实例（instanceKey 幂等）。
   * definition 未注册 → not_found；instanceKey 缺省从 (definition, session/event/singleton) 推
   *   （但 SpawnRequest 无 subscription sink，故缺省用 singleton 键 agent:<def>#singleton）。
   * parent 存在 → 记父子关系（父 addChild）+ expect 时 correlation waiter=父实例（规则 2 自动回父）。
   * taskWaiter 存在 → expect 的 correlation waiter=该 Task（kind='task'，§3.4 规则 1）：子实例结果
   *   经 consumer.routeResult → correlation → env.WATT_TASK.get(taskWaiter).sendEvent 回 Workflow
   *   实例的 waitForEvent（M7 Task fan-in）。parent 与 taskWaiter 互斥（Task 派发的 agent 无父实例）。
   * expect 存在 → correlation register + 返 correlationId。
   */
  async spawn(
    req: SpawnRequest,
    opts: { parent?: string; taskWaiter?: string; claims?: TokenClaims } = {},
  ): Promise<SpawnResult | WattError> {
    const def = await this.registry.get(req.definition);
    if ('code' in def) return def; // not_found

    const instanceKey = req.instanceKey ?? this.deriveKey(req.definition);
    const harness = this.harnessOf(def.entry, def.model);
    const nowIso = this.deps.now();

    const stub = await instanceStub(this.deps.env, instanceKey);
    const state = await stub.initInstance({
      definition: req.definition,
      harness: harness.name,
      model: harness.model,
      input: req.input,
      parent: opts.parent,
      nowIso,
    });

    const corr = correlationStub(this.deps.env);
    await corr.registerInstance({
      instanceId: instanceKey,
      definition: req.definition,
      parentId: opts.parent,
      createdAt: nowIso,
    });

    // 派生：父实例登记子 id（§3.2 children）。
    if (opts.parent !== undefined) {
      const parentStub = await instanceStub(this.deps.env, opts.parent);
      await parentStub.addChild(instanceKey);
    }

    const result: SpawnResult = { instance: toInfo(instanceKey, state) };

    // expect：correlation register。waiter 优先级：taskWaiter（Task fan-in，规则 1）＞父实例
    //   （派生自动回父，规则 2）＞自身实例（无父的独立调用）。
    if (req.expect !== undefined) {
      const waiter: Waiter =
        opts.taskWaiter !== undefined
          ? { kind: 'task', id: opts.taskWaiter }
          : { kind: 'agent', id: opts.parent ?? instanceKey };
      const cid = await this.registerCorrelation(req.expect, waiter, instanceKey);
      if ('code' in cid) return cid;
      result.correlationId = cid.correlationId;
      // 子实例产结果时需带此 correlationId：Spawn 后立即 send 触发 harness（input 已在 state）。
      await stub.onEvent({
        event: this.syntheticEvent(nowIso),
        correlationId: cid.correlationId,
        schema: req.expect.schema,
        ...(opts.claims !== undefined ? { claims: opts.claims } : {}),
      });
    }
    return result;
  }

  /**
   * Send（§3.2）——向实例投递事件；expect 存在 → correlation register（waiter=Send 调用者，
   *   规则 1 定向回送）+ 返 correlationId。caller（Send 发起方实例 id）用于 correlation waiter。
   * 实例必须存在于索引（未 Spawn → not_found）：idFromName 对任意名字都会**隐式创建**一个
   *   INITIAL_STATE 的幽灵 DO（harness 缺省 echo、不入索引），直接投递会静默回显而非报错
   *   （R27 关门轮 DoD 复验实测：send 到拼错的 instanceId 得到 echo 输出，极难排查）。
   */
  async send(
    instanceId: string,
    event: Event,
    expect?: ExpectSpec,
    caller?: Waiter,
    claims?: TokenClaims,
  ): Promise<SendResult | WattError> {
    const corr = correlationStub(this.deps.env);
    const row = await corr.getInstance(instanceId);
    if (row === null) {
      return wattError('not_found', `agent instance not found: ${instanceId}`, false);
    }
    const stub = await instanceStub(this.deps.env, instanceId);
    let correlationId: string | undefined;
    if (expect !== undefined) {
      const cid = await this.registerCorrelation(
        expect,
        caller ?? { kind: 'agent', id: instanceId },
        instanceId,
      );
      if ('code' in cid) return cid;
      correlationId = cid.correlationId;
    }
    const res = await stub.onEvent({
      event,
      correlationId,
      schema: expect?.schema,
      ...(claims !== undefined ? { claims } : {}),
    });
    return { accepted: res.accepted, correlationId };
  }

  /** Status（§3.2）——读实例 DO state（不存在索引 → not_found）。 */
  async status(instanceId: string): Promise<AgentInstanceInfo | WattError> {
    const corr = correlationStub(this.deps.env);
    const row = await corr.getInstance(instanceId);
    if (row === null)
      return wattError('not_found', `agent instance not found: ${instanceId}`, false);
    const stub = await instanceStub(this.deps.env, instanceId);
    const state = await stub.getInfo();
    return toInfo(instanceId, state);
  }

  /**
   * Terminate（§3.2）——{cascade?} 级联回收派生子树。
   * 每个实例：markTerminated + 索引 state='terminated'；correlation.failWaiter(实例 id) 代发
   *   agent.failed(reason='terminated')（§3.4 规则 4，等待方不悬挂）。
   */
  async terminate(instanceId: string, opts: { cascade?: boolean } = {}): Promise<void> {
    const corr = correlationStub(this.deps.env);
    const targets = opts.cascade
      ? (await corr.subtree(instanceId)).map((r) => r.instance_id)
      : [instanceId];
    const nowIso = this.deps.now();
    for (const id of targets) {
      const stub = await instanceStub(this.deps.env, id);
      await stub.markTerminated(nowIso);
      await corr.setInstanceState(id, 'terminated');
      // 规则 4：该实例作为产出方的未完成 correlation 代发 terminated failed。
      await corr.failProducer(id);
    }
  }

  /** ListInstances（§3.2）——tree=<id> 返子树；否则全列。 */
  async listInstances(
    opts: { limit?: number; tree?: string } = {},
  ): Promise<{ items: AgentInstanceInfo[] }> {
    const corr = correlationStub(this.deps.env);
    const rows =
      opts.tree !== undefined
        ? await corr.subtree(opts.tree)
        : await corr.listInstances(opts.limit ?? 200);
    // 索引行 → 轻量 info（children 从索引反查；state 用索引 state）。
    const items: AgentInstanceInfo[] = rows.map((r) => ({
      instanceId: r.instance_id,
      definition: r.definition,
      state: r.state as AgentInstanceState['status'],
      parent: r.parent_id ?? undefined,
      children: rows.filter((c) => c.parent_id === r.instance_id).map((c) => c.instance_id),
      createdAt: r.created_at,
      lastActiveAt: r.created_at,
    }));
    return { items };
  }

  // ─── 内部 ────────────────────────────────────────────────────────────────

  /** correlation register + correlationId 生成/校验（§3.4）。await register 保证后续查表可见。 */
  private async registerCorrelation(
    expect: ExpectSpec,
    waiter: Waiter,
    instanceId: string,
  ): Promise<{ correlationId: string } | WattError> {
    let correlationId: string;
    if (expect.correlationId !== undefined) {
      const err = validateCorrelationId(expect.correlationId);
      if (err !== null) return err;
      correlationId = expect.correlationId;
    } else {
      correlationId = genCorrelationId(this.deps.genId);
    }
    const timeoutAtMs = this.deps.nowMs() + (expect.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const corr = correlationStub(this.deps.env);
    await corr.register(correlationId, waiter, instanceId, timeoutAtMs, this.deps.genId());
    return { correlationId };
  }

  /** 缺省实例键：singleton 语义 agent:<def>#singleton（SpawnRequest 无 subscription sink）。 */
  private deriveKey(definition: string): string {
    const r = resolveInstanceKey(
      { kind: 'agent', definition, instanceBy: 'singleton' },
      // singleton 不需 session；传最小事件占位（resolveInstanceKey 对 singleton 忽略 event）。
      { id: '', source: { kind: 'system' }, type: '', occurredAt: '', traceId: '' } as Event,
    );
    return 'key' in r ? r.key : `agent:${definition}#singleton`;
  }

  /** entry/model → harness 选型（Phase 4 只有 light do-class；model 声明 → llm，否则 echo）。 */
  private harnessOf(
    _entry: AgentEntry,
    model?: { preferred: string },
  ): {
    name: string;
    model?: string;
  } {
    // entry.className 恒 "AgentInstance"，harness 语义走 model 声明——实现声明（doc-gap 候选）。
    // preferred='default' 是哨兵值（R28 B7 / Case 5）：llm harness 但不钉死模型——实例侧每次调用
    //   查 ModelProviderRegistry 的 default 渠道（set-default 切换后下一次调用即走新渠道）。
    if (model !== undefined) {
      if (model.preferred === 'default') return { name: 'llm' };
      return { name: 'llm', model: model.preferred };
    }
    return { name: 'echo' };
  }

  /** 合成一个触发事件（Spawn(expect) 立即触发 harness；payload 为 spawn input 的载体）。 */
  private syntheticEvent(nowIso: string): Event {
    return {
      id: this.deps.genId(),
      source: { kind: 'system' },
      type: 'agent.message',
      payload: {},
      occurredAt: nowIso,
      traceId: this.deps.genId(),
    };
  }
}
