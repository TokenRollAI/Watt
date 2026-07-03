/**
 * AgentInstance —— Agent Runtime 的实例宿主（Proto §3.2 AgentInstanceInfo / §3.3 AgentEndpoint /
 * §3.4 结果回传）。
 *
 * 落地 = Cloudflare Agents SDK 的 `Agent<Env, State>` 基类（LOOP 纪律 4 成熟框架表：
 * "Agent 实例/状态/调度 → Agents SDK，不手写 DO 状态机"）。每个 Agent 实例是一个 Agents SDK DO；
 * 实例键（§3.2 幂等键）= DO 名（getAgentByName(env.AGENT_INSTANCE, instanceKey) 恒路由同实例）。
 *
 * state（Agents SDK setState 持久化，内嵌 SQLite）承载 AgentInstanceInfo 可变部分 + spawn input +
 * 父子派生关系（§3.2）。
 *
 * onEvent 是 §3.3 AgentEndpoint.OnEvent 的实现：平台经 DO RPC 投递事件（consumer agent sink /
 * Runtime.Send），harness（echo/llm）产出 HarnessOutcome → publish agent.result/agent.failed 回
 * QUEUE_EVENTS（带 correlationId → §3.4 定向回送）。
 *
 * 执行语义（2026-07-03 修正）：本实现**同步跑完 harness 才返回 {accepted}**——即 onEvent 返回前
 *   结果事件已 publish（EventStore.put + QUEUE_EVENTS.send）。规范 §3.3/§11.4e 允许「返回 accepted
 *   后异步经 agent.result 回传」，但此处不用 ctx.waitUntil 真异步：① DO RPC 返回后实例可能被回收，
 *   waitUntil 中未跑完的 harness 有结果丢失风险；② 测试直接断言 onEvent 返回后结果已产出（可观测）。
 *   长活模型调用的上界由 anthropic-caller 的 AbortSignal.timeout 兜住（不会无限挂），故同步阻塞可控。
 *   Phase 5+ 引入 agentic loop（多轮工具调用）时若需真异步，改由成熟框架的 schedule/queue 承接。
 *
 * 注：不使用 @callable（那是 WebSocket 客户端 RPC 面，需 TS 标准装饰器）——平台侧全部经服务端
 * DO RPC（普通 public 方法 via stub）驱动，见 agent-runtime.ts。
 */

import type { Event } from '@watt/core';
import { Agent } from 'agents';
import type { Bindings } from '../env.ts';
import { createAnthropicCaller, DEFAULT_ANTHROPIC_BASE_URL } from './harness/anthropic-caller.ts';
import { echoHarness } from './harness/echo.ts';
import { llmHarness } from './harness/llm.ts';
import type { HarnessOutcome, ModelCaller } from './harness/types.ts';

/** 实例状态（§3.2 AgentInstanceInfo 的可变面 + spawn 上下文 + 派生关系）。 */
export interface AgentInstanceState {
  /** AgentDefinition.name（§3.2）。 */
  definition: string;
  /** §3.2 state 四态。 */
  status: 'idle' | 'running' | 'waiting' | 'terminated';
  /** Spawn 输入（§3.2 SpawnRequest.input）。 */
  input?: unknown;
  /** harness 名（echo | llm）——Describe 用（§3.3）+ onEvent 分发。 */
  harness: string;
  /** 模型名（llm harness 用；ModelProvider 解析或 env 缺省）。 */
  model?: string;
  /** 父实例 id（派生自，§3.2 parent）。 */
  parent?: string;
  /** 子实例 id 列表（§3.2 children）。 */
  children: string[];
  createdAt: string;
  lastActiveAt: string;
}

const INITIAL_STATE: AgentInstanceState = {
  definition: '',
  status: 'idle',
  harness: 'echo',
  children: [],
  createdAt: '',
  lastActiveAt: '',
};

/** OnEvent 返回（§3.3：{accepted}）。 */
export interface OnEventResult {
  accepted: boolean;
}

/** onEvent 的调用参数（correlationId 存在时结果定向回送 §3.4）。 */
export interface DeliverArgs {
  event: Event;
  /** 结果回送关联键（§3.4）；缺省则不产结果事件（无 expect 的即发即忘 Send）。 */
  correlationId?: string;
  /** ExpectSpec.schema（JSON Schema）——llm harness 校验重试用。 */
  schema?: unknown;
  /** 最大重试次数（实现声明缺省 3）。 */
  maxAttempts?: number;
}

/**
 * AgentInstance 的 DO RPC 面（平台侧调用契约）——getAgentByName 返回的 stub 经 RPC 包装后
 * 判别式方法收窄成 never（Cloudflare RPC types 对 Agents SDK Agent 子类的已知摩擦，
 * toolchain-pitfalls §31）；调用侧以此显式接口 cast，避免 never 收窄。caller override
 * 不进 RPC 面（函数不可跨 DO 边界序列化）——测试用 runInDurableObject 拿 instance 直接调 onEvent。
 */
export interface AgentInstanceRpc {
  initInstance(args: {
    definition: string;
    harness: string;
    model?: string;
    input?: unknown;
    parent?: string;
    nowIso: string;
  }): Promise<AgentInstanceState>;
  getInfo(): Promise<AgentInstanceState>;
  addChild(childId: string): Promise<void>;
  markTerminated(nowIso: string): Promise<void>;
  onEvent(args: DeliverArgs): Promise<OnEventResult>;
  describe(): Promise<{
    name: string;
    harness: string;
    capabilities: string[];
    healthy: boolean;
  }>;
}

const AGENT_RESULT_TYPE = 'agent.result';
const AGENT_FAILED_TYPE = 'agent.failed';

export class AgentInstance extends Agent<Cloudflare.Env, AgentInstanceState> {
  override initialState: AgentInstanceState = INITIAL_STATE;

  /** 初始化实例元数据（Spawn 时调）——definition/harness/model/input/parent 落 state（§3.2）。
   *  命名 initInstance（非 init）以不覆盖 Agents SDK 基类的 init 钩子。
   *  幂等（2026-07-03 修正）：**只在首次初始化**（createdAt 为 INITIAL_STATE 的空串时）落全套 state；
   *   已初始化的实例重复 Spawn（同 instanceKey）不重置 children/status/input——否则派生子树/运行态会
   *   被后续 Spawn 抹掉（Spawn 幂等语义 §3.2「同键返回同实例」要求状态稳定）。返回当前 state。 */
  async initInstance(args: {
    definition: string;
    harness: string;
    model?: string;
    input?: unknown;
    parent?: string;
    nowIso: string;
  }): Promise<AgentInstanceState> {
    // 已初始化（非 INITIAL_STATE）：幂等返回现有 state，不重置。
    if (this.state.createdAt !== '') {
      return this.state;
    }
    const next: AgentInstanceState = {
      definition: args.definition,
      status: 'idle',
      harness: args.harness,
      model: args.model,
      input: args.input,
      parent: args.parent,
      children: [],
      createdAt: args.nowIso,
      lastActiveAt: args.nowIso,
    };
    this.setState(next);
    return next;
  }

  /** 读实例状态（Status / ListInstances 用）。 */
  async getInfo(): Promise<AgentInstanceState> {
    return this.state;
  }

  /** 登记一个子实例 id（派生时父实例调，§3.2 children）。 */
  async addChild(childId: string): Promise<void> {
    if (this.state.children.includes(childId)) return;
    this.setState({ ...this.state, children: [...this.state.children, childId] });
  }

  /** 标记 terminated（Terminate 时调，§3.2）——不物理删 DO（storage 惰性回收）。 */
  async markTerminated(nowIso: string): Promise<void> {
    this.setState({ ...this.state, status: 'terminated', lastActiveAt: nowIso });
  }

  /** §3.3 Describe——能力/状态/健康。 */
  async describe(): Promise<{
    name: string;
    harness: string;
    capabilities: string[];
    healthy: boolean;
  }> {
    return {
      name: this.state.definition,
      harness: this.state.harness,
      capabilities: this.state.harness === 'llm' ? ['schema-validation'] : [],
      healthy: this.state.status !== 'terminated',
    };
  }

  /**
   * §3.3 OnEvent —— 平台投递事件；harness 产出 → publish agent.result/agent.failed（§3.4）。
   * correlationId 存在 → 结果定向回送（consumer routeAgentEvent 查表投给等待方）。
   * caller 注入（测试用 fake 不触网络，toolchain-pitfalls §35）；缺省从 env 构造真实 Anthropic caller。
   * 返回 {accepted}（§3.3）；结果经 QUEUE_EVENTS 异步回传。
   */
  async onEvent(args: DeliverArgs, caller?: ModelCaller): Promise<OnEventResult> {
    const nowIso = new Date().toISOString();
    if (this.state.status === 'terminated') {
      return { accepted: false }; // 已终止实例拒收（§3.4 规则 4 语义边界）。
    }
    this.setState({ ...this.state, status: 'running', lastActiveAt: nowIso });

    const outcome = await this.runHarness(args, caller);

    this.setState({ ...this.state, status: 'idle', lastActiveAt: new Date().toISOString() });

    // 无 correlationId：即发即忘（无 expect），不产结果事件（§3.2 Send without expect）。
    if (args.correlationId !== undefined) {
      await this.publishOutcome(args.correlationId, outcome);
    }
    return { accepted: true };
  }

  /** 按 state.harness 分发 harness（echo 无模型；llm 经 caller）。 */
  private async runHarness(args: DeliverArgs, caller?: ModelCaller): Promise<HarnessOutcome> {
    if (this.state.harness === 'llm') {
      const modelCaller = caller ?? this.buildDefaultCaller();
      const model = this.state.model ?? 'glm-5.2';
      const usages: { inputTokens: number; outputTokens: number }[] = [];
      const outcome = await llmHarness(
        {
          input: this.state.input ?? args.event.payload,
          schema: args.schema,
          model,
          maxAttempts: args.maxAttempts,
        },
        modelCaller,
        // Metrics 打点（§10）：每次模型调用产一条 usage，收集后统一写（重试多次则多行）。
        (usage) => usages.push(usage),
      );
      // usage 写在 onEvent 主路径内（onEvent 同步跑完才返回，见文件头执行语义）——await 保落库。
      for (const usage of usages) await this.recordUsage(model, usage);
      return outcome;
    }
    // echo（缺省）：回显 input（缺省事件 payload）。
    return echoHarness(this.state.input ?? args.event.payload);
  }

  /** 写一行 usage（D1 usage 表）+ AE 并行打点。best-effort：失败不阻塞 harness。 */
  private async recordUsage(
    model: string,
    usage: { inputTokens: number; outputTokens: number },
  ): Promise<void> {
    const env = this.env as Bindings;
    const record = {
      // 中转直连为 Anthropic Messages 格式，provider 记 'anthropic'（未接 ModelRouter 前的实现声明）。
      provider: 'anthropic',
      model,
      agentDef: this.state.definition,
      instance: this.name,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
    try {
      const { UsageStore, writeUsageDataPoint } = await import('../metrics/usage-store.ts');
      writeUsageDataPoint(env.AE_METRICS, record);
      await new UsageStore(env.DB_AUDIT).write(record);
    } catch (err) {
      console.error('agent instance: usage record failed', { err: String(err) });
    }
  }

  /** 从 env 构造真实 Anthropic caller（ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL）。 */
  private buildDefaultCaller(): ModelCaller {
    const env = this.env as Bindings;
    const apiKey = env.ANTHROPIC_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      // 无 key：产 error outcome（buildDefaultCaller 只在无注入 caller 时走，@llm tag 才有 key）。
      return {
        async call() {
          throw new Error('ANTHROPIC_API_KEY is not configured');
        },
      };
    }
    return createAnthropicCaller({
      apiKey,
      baseUrl: env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE_URL,
    });
  }

  /** 把 HarnessOutcome 转 agent.result/agent.failed 事件 publish 回 QUEUE_EVENTS（§3.4）。 */
  private async publishOutcome(correlationId: string, outcome: HarnessOutcome): Promise<void> {
    const env = this.env as Bindings;
    const instanceId = this.name;
    const base = {
      id: crypto.randomUUID(),
      source: { kind: 'agent' as const, ref: instanceId },
      occurredAt: new Date().toISOString(),
      traceId: crypto.randomUUID(),
    };
    let event: Event;
    if (outcome.kind === 'result') {
      event = {
        ...base,
        type: AGENT_RESULT_TYPE,
        payload: { correlationId, instanceId, output: outcome.output },
      };
    } else {
      event = {
        ...base,
        type: AGENT_FAILED_TYPE,
        payload: {
          correlationId,
          instanceId,
          reason: outcome.reason,
          ...(outcome.errorMessage !== undefined
            ? { error: { code: 'internal', message: outcome.errorMessage, retryable: false } }
            : {}),
        },
      };
    }
    // 留痕 + 入队（§2.4/§3.4）：此路径不经 event-bus publish（系统内部产出，无 dedupe/出站鉴权需求），
    // 必须自行 EventStore.put——否则 agent.result/failed 只进队列被定向路由消费，留痕面查不到
    // （consumer 注释假设"publish 时已留痕"，2026-07-03 线上冒烟实测修正）。put 失败不阻塞投递。
    try {
      const { EventStore } = await import('../event/event-store.ts');
      await new EventStore(env.DB_EVENTS).put(event);
    } catch (err) {
      console.error('agent instance: result event store put failed', {
        eventId: event.id,
        err: String(err),
      });
    }
    await env.QUEUE_EVENTS.send(event);
  }
}
