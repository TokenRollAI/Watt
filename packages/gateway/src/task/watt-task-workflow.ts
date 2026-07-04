/**
 * WattTaskWorkflow（Proto §8 TaskManager 引擎 / M7）——Cloudflare Workflows WorkflowEntrypoint。
 *
 * 单一 WorkflowEntrypoint 子类，按 params.definition 分派已部署模板（deep-research / auto-delivery-lite）。
 * Workflows 实例 id = taskId（TaskManager.Write 时 env.WATT_TASK.create({id: taskId})），Signal/Cancel
 * 经 env.WATT_TASK.get(taskId) 直接取实例——免 taskId↔instanceId 映射表（实现声明）。
 *
 * 状态落库（§8 引擎驱动状态 L800）：每步经 TaskStore（env.DB_EVENTS）写 state/steps/checkpoint/
 * artifacts；进 waiting_human 时 Publish task.checkpoint（§1.1，consumer 转确认卡片）。恢复经
 * step.waitForEvent（Signal → env.WATT_TASK.get(taskId).sendEvent(taskSignalEventName(checkpoint))）。
 *
 * §3.4 Workflows 适配纪律：
 *  - waitForEvent 事件 type 经 core 净化（禁 '.'、≤100 字符）：human=taskSignalEventName(checkpoint)、
 *    agent 结果=agentResultEventName(correlationId)（result/failed 归并，payload.status 分支）；
 *  - waitForEvent **必须显式设短超时**（默认 24h/上限 365 天会挂起，§3.4）——本模板 human 10min、
 *    agent 5min（实现声明的 checkpoint 超时值，收口 doc-gap #11）；超时按平台代发 failed 语义处理。
 *  - agent 派发 = AgentRuntime.spawn(expect{correlationId})，waiter.kind='task'、waiter.id=taskId：
 *    子实例结果经 consumer.routeResult → correlation → env.WATT_TASK.get(taskId).sendEvent 回本实例。
 *
 * 决定论（Workflows 重放语义）：所有副作用（DB 写、事件发布、agent 派发、genId/now）包在 step.do 内，
 * 保证重放时读缓存不重复执行副作用。step.do 外只做纯控制流。
 */

import { WorkflowEntrypoint, type WorkflowStep } from 'cloudflare:workers';
import {
  agentResultEventName,
  genCorrelationId,
  type SpawnRequest,
  taskSignalEventName,
} from '@watt/core';
import { AgentRuntime, defaultRuntimeDeps } from '../agent/agent-runtime.ts';
import type { Bindings } from '../env.ts';
import { publishTaskCheckpoint } from './task-events.ts';
import { TaskStore } from './task-store.ts';

// WorkflowEvent 用 cloudflare:workers 的运行时导出；params 类型见下。

/** Workflows 实例入参（env.WATT_TASK.create({ id: taskId, params }) 的 params）。 */
export interface TaskWorkflowParams {
  taskId: string;
  /** 不透明引用（§8 L797）——当前解析为已部署模板名。 */
  definition: string;
  input?: unknown;
  /** 审计 principal（§8 TaskInfo.createdBy）。 */
  createdBy: string;
}

/** 已部署模板名单（§8 ListDefinitions kind='deployed'，checkpoints 由模板代码声明）。 */
export interface DeployedTemplate {
  name: string;
  description: string;
  checkpoints: string[];
}
export const DEPLOYED_TEMPLATES: DeployedTemplate[] = [
  {
    name: 'deep-research',
    description: '并发多 agent 调研 + 方案确认 checkpoint（E2E-2）',
    checkpoints: ['confirm-plan'],
  },
  {
    name: 'auto-delivery-lite',
    description: 'bug 登记 → agent 定位 → 上线确认 checkpoint（E2E-1 精简）',
    checkpoints: ['confirm-release'],
  },
];

/** checkpoint waitForEvent 超时（实现声明，§3.4；human 检查点给 10 分钟短超时避免挂起）。 */
const HUMAN_CHECKPOINT_TIMEOUT = '10 minutes';
/** agent 结果 waitForEvent 超时（实现声明，§3.4；5 分钟）。 */
const AGENT_RESULT_TIMEOUT = '5 minutes';
/** deep-research 并发子 agent 数（N=2，最小 fan-in 面）。 */
const RESEARCH_FANOUT = 2;

/** taskSignal/agentResult 事件名求值：core 返回 string | WattError，非法即抛（净化后应恒合法）。 */
function eventNameOrThrow(v: string | { message: string }): string {
  if (typeof v === 'string') return v;
  throw new Error(`invalid workflows event name: ${v.message}`);
}

/**
 * checkpoint 通知目标解析（R29 B4）：input.notify {channel,target} 存在则用之（E2E-1/2 发飞书群
 *   `{channel:'feishu-main', target:<chat_id>}`）；缺省回落 CLI/createdBy（原行为，零回归）。
 */
function notifyFromInput(
  input: unknown,
  createdBy: string,
): {
  channel: string;
  target: string;
} {
  if (typeof input === 'object' && input !== null && 'notify' in input) {
    const n = (input as { notify?: { channel?: unknown; target?: unknown } }).notify;
    if (n !== undefined && typeof n.channel === 'string' && typeof n.target === 'string') {
      return { channel: n.channel, target: n.target };
    }
  }
  return { channel: 'cli', target: createdBy };
}

/** 从 input 取 bug 标题（{title:string} 形状）；不符 → undefined（调用方回落缺省标题）。 */
function extractTitle(input: unknown): string | undefined {
  if (typeof input === 'object' && input !== null && 'title' in input) {
    const t = (input as { title?: unknown }).title;
    if (typeof t === 'string' && t.length > 0) return t;
  }
  return undefined;
}

/** waitForEvent<T>/step.do<T> 要求 T extends Rpc.Serializable<T>：bare unknown 不满足、递归 JSON 触发
 *  深实例化（TS2589）。故事件 payload 用一层深的可序列化 record（primitive 值），够本模板顶层判定用；
 *  嵌套结构的完整投影不在 Workflow 侧读（存 TaskStore 的 steps output 用 unknown 承载全量）。 */
type Primitive = string | number | boolean | null;
type FlatRecord = { [k: string]: Primitive };
/** 人类确认信号 payload（TaskManager.Signal 发的 { decision, payload? } 形状）。 */
type SignalEventPayload = { decision: string; payload?: Primitive | FlatRecord };
/** agent 结果归并 payload（§3.4：result/failed 归并，status 分支）。
 *  reason：failed 时的 AgentFailedPayload.reason 五态（string，Primitive，不破一层深约束）。 */
type AgentResultEventPayload = {
  status: string;
  output?: Primitive | FlatRecord;
  error?: Primitive | FlatRecord;
  reason?: string;
};

export class WattTaskWorkflow extends WorkflowEntrypoint<Bindings, TaskWorkflowParams> {
  override async run(
    event: Readonly<{ payload: TaskWorkflowParams }>,
    step: WorkflowStep,
  ): Promise<unknown> {
    const params = event.payload;
    const store = new TaskStore(this.env.DB_EVENTS);

    // 登记：置 running（Write 时已建 pending 行，此处引擎接管）。
    await step.do('register', async () => {
      await store.setState(params.taskId, 'running', new Date().toISOString(), 'register');
      return { taskId: params.taskId, definition: params.definition };
    });

    switch (params.definition) {
      case 'deep-research':
        return await this.runDeepResearch(params, step, store);
      case 'auto-delivery-lite':
        return await this.runAutoDeliveryLite(params, step, store);
      default:
        // 未知模板：置 failed（Write 侧已校验存在，此处防御重放/篡改）。
        await step.do('reject-unknown-definition', async () => {
          await store.setState(params.taskId, 'failed', new Date().toISOString());
        });
        throw new Error(`unknown task definition: ${params.definition}`);
    }
  }

  /**
   * deep-research（E2E-2）：确认方案 checkpoint → 并发 N agent → fan-in 汇总 → 完成。
   * fan-in 按 correlationId 收齐；超时者由平台代发 failed（§3.4 规则 3，此处 waitForEvent timeout
   * 落到 catch → 记 failed step，不阻塞其余 correlation）。
   */
  private async runDeepResearch(
    params: TaskWorkflowParams,
    step: WorkflowStep,
    store: TaskStore,
  ): Promise<unknown> {
    const checkpoint = 'confirm-plan';
    // 1) 进 waiting_human：登记 pendingCheckpoint + Publish task.checkpoint（§1.1）。
    await step.do('request-plan-confirmation', async () => {
      const now = new Date().toISOString();
      await store.setCheckpoint(
        params.taskId,
        { checkpoint, prompt: '请确认调研方案后继续', requestedAt: now },
        now,
      );
      await publishTaskCheckpoint(this.env, {
        taskId: params.taskId,
        checkpoint,
        prompt: '请确认调研方案后继续',
        options: ['approve', 'reject'],
        notify: { channel: 'cli', target: params.createdBy },
      });
    });

    // 2) 等人类确认（显式短超时，§3.4）。超时 → catch 落 failed + clearCheckpoint（§3.4 checkpoint
    //    超时语义：不放任实例 errored 而卡 waiting_human），return 失败结果使实例干净 complete。
    let signal: { payload: SignalEventPayload };
    try {
      signal = await step.waitForEvent<SignalEventPayload>('await-plan-confirmation', {
        type: eventNameOrThrow(taskSignalEventName(checkpoint)),
        timeout: HUMAN_CHECKPOINT_TIMEOUT,
      });
    } catch (_err) {
      await step.do('checkpoint-timeout-plan', async () => {
        const now = new Date().toISOString();
        await store.clearCheckpoint(params.taskId, now);
        await store.setState(params.taskId, 'failed', now, 'checkpoint-timeout');
        return { timedOut: true };
      });
      return { timedOut: true, checkpoint };
    }
    // 恢复：清 checkpoint → running。reject → 直接中止为 cancelled（决策语义由模板解释，§signal.ts）。
    const decision = signal.payload.decision;
    await step.do('resume-after-confirmation', async () => {
      await store.clearCheckpoint(params.taskId, new Date().toISOString());
    });
    if (decision === 'reject') {
      await step.do('mark-rejected', async () => {
        await store.setState(params.taskId, 'cancelled', new Date().toISOString());
      });
      return { rejected: true };
    }

    // 3) 并发派发 N 个 agent（AgentRuntime.spawn(expect)，waiter=task→结果回本 Workflow 实例）。
    const correlationIds = await step.do('dispatch-research-agents', async () => {
      const runtime = new AgentRuntime(defaultRuntimeDeps(this.env));
      const cids: string[] = [];
      for (let i = 0; i < RESEARCH_FANOUT; i++) {
        const cid = genCorrelationId(() => crypto.randomUUID());
        const req: SpawnRequest = {
          definition: 'echo',
          instanceKey: `task:${params.taskId}#research-${i}`,
          input: { taskId: params.taskId, index: i, input: params.input },
          expect: { correlationId: cid, timeoutMs: 5 * 60_000 },
        };
        const res = await runtime.spawn(req, { taskWaiter: params.taskId });
        if ('code' in res) throw new Error(`spawn research agent ${i} failed: ${res.message}`);
        cids.push(cid);
      }
      return cids;
    });

    // 4) fan-in：逐 correlationId 等结果（agentResultEventName 归并 result/failed，payload.status 分支）。
    //    单个 correlation 超时 → catch 记 failed step（appendStep state:'failed'）继续收其余，不中断整体
    //    （§3.4 规则 3 平台代发 failed 语义；超时与结果二选一，故 record-research-<i> 步名不冲突）。
    const outputs: (Primitive | FlatRecord)[] = [];
    for (let i = 0; i < correlationIds.length; i++) {
      const cid = correlationIds[i];
      if (cid === undefined) continue;
      let result: { payload: AgentResultEventPayload };
      try {
        result = await step.waitForEvent<AgentResultEventPayload>(`await-research-${i}`, {
          type: eventNameOrThrow(agentResultEventName(cid)),
          timeout: AGENT_RESULT_TIMEOUT,
        });
      } catch (_err) {
        await step.do(`record-research-${i}`, async () => {
          const now = new Date().toISOString();
          await store.appendStep(
            params.taskId,
            {
              name: `research-${i}`,
              state: 'failed',
              startedAt: now,
              output: { reason: 'timeout' },
            },
            now,
          );
          return { recorded: true, timedOut: true };
        });
        continue;
      }
      await step.do(`record-research-${i}`, async () => {
        const now = new Date().toISOString();
        const state = result.payload.status === 'result' ? 'done' : 'failed';
        await store.appendStep(
          params.taskId,
          { name: `research-${i}`, state, startedAt: now, output: result.payload.output },
          now,
        );
        return { recorded: true };
      });
      if (result.payload.status === 'result') outputs.push(result.payload.output ?? null);
    }

    // 5) 汇总 + 完成。
    return await step.do('summarize', async () => {
      const now = new Date().toISOString();
      await store.appendStep(
        params.taskId,
        { name: 'summarize', state: 'done', startedAt: now },
        now,
      );
      await store.setState(params.taskId, 'done', now, 'summarize');
      return { summary: outputs, count: outputs.length };
    });
  }

  /**
   * auto-delivery-lite（E2E-1）：登记 bug（**真实写 context://feedback/bugs**，status:open）→ agent
   * 定位（echo，**expect fan-in——接力链 agent.result 留痕**）→ 上线确认 checkpoint（notify 可参数化
   * 发飞书群）→ approve 后 bug 置 fixed → 完成。R29 B2/B4 真实化（原桩注释声明的收口）。
   *
   * feedback/bugs namespace：惰性挂载（不存在则 mount structured）——E2E 免手工前置；结构化条目
   * {title, status: open→fixed, taskId}，路径 = taskId（每任务一条，重放幂等：write 是 upsert）。
   */
  private async runAutoDeliveryLite(
    params: TaskWorkflowParams,
    step: WorkflowStep,
    store: TaskStore,
  ): Promise<unknown> {
    const checkpoint = 'confirm-release';
    const bugPath = params.taskId;

    // 1) 登记 bug：真实写 context://feedback/bugs/<taskId>（status:open，判据①前半）。
    await step.do('register-bug', async () => {
      const now = new Date().toISOString();
      await this.writeBugEntry(bugPath, {
        title: extractTitle(params.input) ?? `bug via task ${params.taskId}`,
        status: 'open',
        taskId: params.taskId,
        reportedAt: now,
      });
      await store.appendStep(
        params.taskId,
        { name: 'register-bug', state: 'done', startedAt: now, output: params.input },
        now,
      );
    });

    // 2) agent 定位（echo + expect fan-in）：接力链上这一跳产真实 agent.result 留痕（判据②）。
    const locateCid = await step.do('locate', async () => {
      const runtime = new AgentRuntime(defaultRuntimeDeps(this.env));
      const cid = genCorrelationId(() => crypto.randomUUID());
      const spawn = await runtime.spawn(
        {
          definition: 'echo',
          instanceKey: `task:${params.taskId}#locate`,
          input: { taskId: params.taskId, phase: 'locate' },
          expect: { correlationId: cid, timeoutMs: 5 * 60_000 },
        },
        { taskWaiter: params.taskId },
      );
      if ('code' in spawn) throw new Error(`locate agent spawn failed: ${spawn.message}`);
      return cid;
    });
    try {
      const located = await step.waitForEvent<AgentResultEventPayload>('await-locate', {
        type: eventNameOrThrow(agentResultEventName(locateCid)),
        timeout: AGENT_RESULT_TIMEOUT,
      });
      await step.do('record-locate', async () => {
        const now = new Date().toISOString();
        const state = located.payload.status === 'result' ? 'done' : 'failed';
        await store.appendStep(
          params.taskId,
          { name: 'locate', state, startedAt: now, output: located.payload.output },
          now,
        );
      });
    } catch (_err) {
      // 定位超时：记 failed step，流程继续（人确认时可拒绝）——不因单跳失败卡死任务。
      await step.do('record-locate', async () => {
        const now = new Date().toISOString();
        await store.appendStep(
          params.taskId,
          { name: 'locate', state: 'failed', startedAt: now, output: { reason: 'timeout' } },
          now,
        );
      });
    }

    // 3) 上线确认 checkpoint（§1.1）。notify 可由 input.notify 参数化（发飞书群，B4）。
    await step.do('request-release-confirmation', async () => {
      const now = new Date().toISOString();
      await store.setCheckpoint(
        params.taskId,
        { checkpoint, prompt: '确认上线修复？', requestedAt: now },
        now,
      );
      await publishTaskCheckpoint(this.env, {
        taskId: params.taskId,
        checkpoint,
        prompt: '确认上线修复？',
        options: ['approve', 'reject'],
        notify: notifyFromInput(params.input, params.createdBy),
      });
    });

    // 4) 等人类确认。超时 → catch 落 failed + clearCheckpoint（§3.4 checkpoint 超时语义），
    //    return 失败结果使实例干净 complete（不放任 errored 而卡 waiting_human）。
    let signal: { payload: SignalEventPayload };
    try {
      signal = await step.waitForEvent<SignalEventPayload>('await-release-confirmation', {
        type: eventNameOrThrow(taskSignalEventName(checkpoint)),
        timeout: HUMAN_CHECKPOINT_TIMEOUT,
      });
    } catch (_err) {
      await step.do('checkpoint-timeout-release', async () => {
        const now = new Date().toISOString();
        await store.clearCheckpoint(params.taskId, now);
        await store.setState(params.taskId, 'failed', now, 'checkpoint-timeout');
        return { timedOut: true };
      });
      return { timedOut: true, checkpoint };
    }
    await step.do('resume-after-release', async () => {
      await store.clearCheckpoint(params.taskId, new Date().toISOString());
    });
    if (signal.payload.decision === 'reject') {
      await step.do('mark-release-rejected', async () => {
        await store.setState(params.taskId, 'cancelled', new Date().toISOString());
      });
      return { released: false };
    }

    // 5) 完成：bug status open→fixed（判据①后半）+ 任务 done。
    return await step.do('complete-release', async () => {
      const now = new Date().toISOString();
      await this.writeBugEntry(bugPath, {
        title: extractTitle(params.input) ?? `bug via task ${params.taskId}`,
        status: 'fixed',
        taskId: params.taskId,
        fixedAt: now,
      });
      await store.appendStep(
        params.taskId,
        { name: 'release', state: 'done', startedAt: now },
        now,
      );
      await store.setState(params.taskId, 'done', now, 'release');
      return { released: true, bug: `context://feedback/bugs/${bugPath}` };
    });
  }

  /**
   * 写 feedback/bugs 条目（structured provider 直写，namespace 惰性挂载）。
   * 动态 import 避免 Workflow 模块顶层耦合 DO/provider 链（对齐 task-events 模式）。
   */
  private async writeBugEntry(path: string, bug: Record<string, string>): Promise<void> {
    const registry = this.env.CONTEXT_REGISTRY.get(
      this.env.CONTEXT_REGISTRY.idFromName('registry'),
    );
    const mount = await registry.get('feedback/bugs');
    if ('code' in mount) {
      // not_found → 惰性挂载（其它错误也走一次 write：幂等 upsert，失败由下方 provider 写暴露）。
      await registry.write({ namespace: 'feedback/bugs', provider: 'structured' });
    }
    const { StructuredContextProvider } = await import('../context/providers/structured.ts');
    const provider = new StructuredContextProvider(this.env.DB_CONTEXT, 'feedback/bugs');
    const res = await provider.write(path, {
      content: JSON.stringify(bug),
      contentType: 'application/json',
      metadata: { status: bug.status ?? '' },
    });
    if ('code' in res) throw new Error(`feedback/bugs write failed: ${res.message}`);
  }
}
