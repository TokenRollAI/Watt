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

/** waitForEvent<T>/step.do<T> 要求 T extends Rpc.Serializable<T>：bare unknown 不满足、递归 JSON 触发
 *  深实例化（TS2589）。故事件 payload 用一层深的可序列化 record（primitive 值），够本模板顶层判定用；
 *  嵌套结构的完整投影不在 Workflow 侧读（存 TaskStore 的 steps output 用 unknown 承载全量）。 */
type Primitive = string | number | boolean | null;
type FlatRecord = { [k: string]: Primitive };
/** 人类确认信号 payload（TaskManager.Signal 发的 { decision, payload? } 形状）。 */
type SignalEventPayload = { decision: string; payload?: Primitive | FlatRecord };
/** agent 结果归并 payload（§3.4：result/failed 归并，status 分支）。 */
type AgentResultEventPayload = {
  status: string;
  output?: Primitive | FlatRecord;
  error?: Primitive | FlatRecord;
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

    // 2) 等人类确认（显式短超时，§3.4）。
    const signal = await step.waitForEvent<SignalEventPayload>('await-plan-confirmation', {
      type: eventNameOrThrow(taskSignalEventName(checkpoint)),
      timeout: HUMAN_CHECKPOINT_TIMEOUT,
    });
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
    const outputs: (Primitive | FlatRecord)[] = [];
    for (let i = 0; i < correlationIds.length; i++) {
      const cid = correlationIds[i];
      if (cid === undefined) continue;
      const result = await step.waitForEvent<AgentResultEventPayload>(`await-research-${i}`, {
        type: eventNameOrThrow(agentResultEventName(cid)),
        timeout: AGENT_RESULT_TIMEOUT,
      });
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
   * auto-delivery-lite（E2E-1 精简）：登记 bug（DB 直写桩）→ agent 定位（echo 桩）→ 上线确认
   * checkpoint → 完成。DoD 只要求 run→waiting_human→signal→恢复→done 与 cancel 链路，桩从简。
   */
  private async runAutoDeliveryLite(
    params: TaskWorkflowParams,
    step: WorkflowStep,
    store: TaskStore,
  ): Promise<unknown> {
    const checkpoint = 'confirm-release';

    // 1) 登记 bug（桩：记一个 step，真实 context:// 写入留 Phase 6/收口）。
    await step.do('register-bug', async () => {
      const now = new Date().toISOString();
      await store.appendStep(
        params.taskId,
        { name: 'register-bug', state: 'done', startedAt: now, output: params.input },
        now,
      );
    });

    // 2) agent 定位（echo 桩：即发即忘，不 fan-in——桩从简）。
    await step.do('locate', async () => {
      const runtime = new AgentRuntime(defaultRuntimeDeps(this.env));
      const spawn = await runtime.spawn({
        definition: 'echo',
        instanceKey: `task:${params.taskId}#locate`,
        input: { taskId: params.taskId, phase: 'locate' },
      });
      if ('code' in spawn) throw new Error(`locate agent spawn failed: ${spawn.message}`);
      const now = new Date().toISOString();
      await store.appendStep(params.taskId, { name: 'locate', state: 'done', startedAt: now }, now);
    });

    // 3) 上线确认 checkpoint（§1.1）。
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
        notify: { channel: 'cli', target: params.createdBy },
      });
    });

    // 4) 等人类确认。
    const signal = await step.waitForEvent<SignalEventPayload>('await-release-confirmation', {
      type: eventNameOrThrow(taskSignalEventName(checkpoint)),
      timeout: HUMAN_CHECKPOINT_TIMEOUT,
    });
    await step.do('resume-after-release', async () => {
      await store.clearCheckpoint(params.taskId, new Date().toISOString());
    });
    if (signal.payload.decision === 'reject') {
      await step.do('mark-release-rejected', async () => {
        await store.setState(params.taskId, 'cancelled', new Date().toISOString());
      });
      return { released: false };
    }

    // 5) 完成。
    return await step.do('complete-release', async () => {
      const now = new Date().toISOString();
      await store.appendStep(
        params.taskId,
        { name: 'release', state: 'done', startedAt: now },
        now,
      );
      await store.setState(params.taskId, 'done', now, 'release');
      return { released: true };
    });
  }
}
