/**
 * TaskManager 服务层（Proto §8）——编排 Workflows（env.WATT_TASK）+ TaskStore（状态元数据）。
 *
 * 动词（§8 L786-803）：
 *  - Write(req)：definition 校验存在（DEPLOYED_TEMPLATES）→ TaskStore.create（pending）→
 *    env.WATT_TASK.create({ id: taskId, params }) 启动 Workflow → 返 TaskInfo。taskId 缺省平台生成
 *    （幂等：Write.taskId 给定则复用；同 id 已存在 → conflict）。
 *  - List(opts)：TaskStore.list（filter state/definition/时间）→ Page<TaskInfo>。
 *  - Get(taskId)：TaskStore.getDetail（状态表投影）→ TaskDetail（表侧为对外权威态，不叠加引擎 status）。
 *  - Update(taskId, {note})：TaskStore.patchNote（仅元信息，执行状态由引擎驱动）。
 *  - Cancel(taskId, reason?)：终态守卫（cancelled 幂等 / done|failed → conflict）→ instance.terminate()
 *    + 级联终止 Task 派生 agent 子实例（前缀 task:<taskId>#）+ TaskStore setState('cancelled')。
 *  - Signal(taskId, {checkpoint, decision, payload?})：checkSignalable（waiting 外 → conflict）+
 *    checkpoint 匹配校验（不符 → invalid_argument）→ env.WATT_TASK.get(taskId).sendEvent 恢复
 *    Workflow 的 waitForEvent。
 *  - ListDefinitions()：DEPLOYED_TEMPLATES（kind='deployed'，硬编码两模板 + checkpoints）。
 */

import {
  checkSignalable,
  type SignalRequest,
  type TaskDetail,
  type TaskInfo,
  taskSignalEventName,
} from '@watt/core';
import { type WattError, wattError } from '@watt/shared';
import { AgentRuntime, defaultRuntimeDeps } from '../agent/agent-runtime.ts';
import type { Bindings } from '../env.ts';
import { type ListOptions, type Page, TaskStore } from './task-store.ts';
import { DEPLOYED_TEMPLATES, type TaskWorkflowParams } from './watt-task-workflow.ts';

/** Write 请求（§8 L799；createdBy 由路由从 claims 注入，非入参）。 */
export interface WriteRequest {
  definition: string;
  input?: unknown;
  taskId?: string;
}

/** ListDefinitions 返回项（§8 L793）。 */
export interface DefinitionInfo {
  name: string;
  kind: 'deployed';
  description: string;
  checkpoints: string[];
}

export interface ManagerDeps {
  env: Bindings;
  genId: () => string;
  now: () => string;
}

export function defaultManagerDeps(env: Bindings): ManagerDeps {
  return { env, genId: () => crypto.randomUUID(), now: () => new Date().toISOString() };
}

export class TaskManager {
  private readonly store: TaskStore;
  constructor(private readonly deps: ManagerDeps) {
    this.store = new TaskStore(deps.env.DB_EVENTS);
  }

  /**
   * Write（§8）——启动任务。definition 未部署 → invalid_argument（不透明引用当前只解析已部署模板名）；
   * taskId 给定且已存在 → conflict（幂等启动语义：同 id 不重复启）。
   */
  async write(req: WriteRequest, createdBy: string): Promise<TaskInfo | WattError> {
    const template = DEPLOYED_TEMPLATES.find((t) => t.name === req.definition);
    if (template === undefined) {
      return wattError('invalid_argument', `unknown task definition: ${req.definition}`, false);
    }
    const taskId = req.taskId ?? `task-${this.deps.genId()}`;
    const existing = await this.store.getInfo(taskId);
    if (existing !== null) {
      return wattError('conflict', `task already exists: ${taskId}`, false);
    }
    const now = this.deps.now();
    const info = await this.store.create({
      taskId,
      definition: req.definition,
      state: 'pending',
      createdBy,
      now,
    });
    const params: TaskWorkflowParams = {
      taskId,
      definition: req.definition,
      input: req.input,
      createdBy,
    };
    // 原子性补偿：WATT_TASK.create 抛错 → 删除刚落的 pending 孤儿行，否则同 taskId 重试恒 conflict
    //   （pending 行已存在但引擎无实例）。补偿删除失败仅 best-effort 记日志（无回滚事务面）。
    try {
      await this.deps.env.WATT_TASK.create({ id: taskId, params });
    } catch (err) {
      try {
        await this.store.delete(taskId);
      } catch (delErr) {
        console.error('task manager: write compensation delete failed', {
          taskId,
          err: String(delErr),
        });
      }
      return wattError('internal', `failed to start task workflow: ${String(err)}`, true);
    }
    return info;
  }

  /** List（§8）——filter=state/definition/时间。 */
  async list(opts: ListOptions = {}): Promise<Page<TaskInfo> | WattError> {
    return this.store.list(opts);
  }

  /**
   * Get（§8）——返回 TaskStore 状态表投影的 TaskDetail（steps/pendingCheckpoint/artifacts）。
   * 状态表是平台对外可查的权威态（§8 引擎驱动状态由 Workflow step 落库）；不叠加引擎侧
   *   instance.status()——本地 Workflows 在 waitForEvent hibernate 时 status 误报 'running'
   *   （toolchain §33），叠加反而失真，故以表侧为唯一真源。
   */
  async get(taskId: string): Promise<TaskDetail | WattError> {
    return this.store.getDetail(taskId);
  }

  /** Update（§8）——仅 note 元信息（执行状态由引擎驱动）。 */
  async update(taskId: string, patch: { note?: string }): Promise<TaskInfo | WattError> {
    if (patch.note === undefined) {
      const info = await this.store.getInfo(taskId);
      if (info === null) return wattError('not_found', `task not found: ${taskId}`, false);
      return info;
    }
    return this.store.patchNote(taskId, patch.note, this.deps.now());
  }

  /**
   * Cancel（§8）——终止 Workflow 实例 + 级联终止 Task 派生的 agent 子实例（§3.4 规则 4）。
   * 终态守卫（§8 状态机）：cancelled → 幂等成功（重复 Cancel 无副作用）；done/failed → conflict
   *   （已完成的任务不可取消，避免终态被覆写）。
   * Workflow instance.terminate() 幂等失败（已 complete/errored/terminated）不致命：仍落库 cancelled。
   * 级联：Task 派生的 agent instanceKey 恒 task:<taskId>#...（见 watt-task-workflow.ts）——这些子实例
   *   无 parent（spawn 用 taskWaiter 非 parent），故 subtree/cascade 查不到；用 AgentRuntime.listInstances
   *   全列 + 前缀过滤逐个 terminate（terminate 内含 markTerminated + failProducer 代发 terminated failed）。
   */
  async cancel(taskId: string, reason?: string): Promise<WattError | void> {
    const info = await this.store.getInfo(taskId);
    if (info === null) return wattError('not_found', `task not found: ${taskId}`, false);
    // 终态守卫：cancelled 幂等成功；done/failed 拒绝（不可覆写终态）。
    if (info.state === 'cancelled') return;
    if (info.state === 'done' || info.state === 'failed') {
      return wattError(
        'conflict',
        `task already in terminal state '${info.state}': ${taskId}`,
        false,
      );
    }
    try {
      const instance = await this.deps.env.WATT_TASK.get(taskId);
      await instance.terminate();
    } catch (err) {
      // 已终态实例 terminate 抛错：记日志，仍落库 cancelled（对外 Cancel 幂等）。
      console.log('task manager: workflow terminate non-fatal error', {
        taskId,
        err: String(err),
      });
    }
    // 级联终止 Task 派生的 agent 子实例（instanceKey 前缀 task:<taskId>#，§3.4 规则 4）。
    await this.cascadeTerminateAgents(taskId);
    const note = reason !== undefined ? `cancelled: ${reason}` : 'cancelled';
    const now = this.deps.now();
    await this.store.setState(taskId, 'cancelled', now);
    await this.store.patchNote(taskId, note, now);
  }

  /**
   * 级联终止 Task 派生的 agent 子实例（instanceKey 前缀 task:<taskId>#）。逐个 AgentRuntime.terminate：
   * markTerminated + correlation.failProducer 代发 agent.failed(reason='terminated')——等待方不悬挂。
   * 枚举经现有 listInstances 全列 + 前缀过滤（子实例无 parent，subtree 查不到；不自建索引表）。
   * 枚举/终止失败仅 best-effort 记日志（Task 本身已 terminate，agent 子实例回收尽力交付）。
   */
  private async cascadeTerminateAgents(taskId: string): Promise<void> {
    const prefix = `task:${taskId}#`;
    try {
      const runtime = new AgentRuntime(defaultRuntimeDeps(this.deps.env));
      const { items } = await runtime.listInstances();
      for (const inst of items) {
        if (!inst.instanceId.startsWith(prefix)) continue;
        if (inst.state === 'terminated') continue;
        await runtime.terminate(inst.instanceId);
      }
    } catch (err) {
      console.error('task manager: cascade terminate agents failed', {
        taskId,
        err: String(err),
      });
    }
  }

  /**
   * Signal（§8 / §1.1 规则 2）——向 waiting 的 Task 投递人类确认/外部完成。
   * core checkSignalable：waiting_human/waiting_event 外 → conflict（DoD §7）。
   * checkpoint 匹配校验：waiting_human 时读 pendingCheckpoint，signal.checkpoint 与之不符 →
   *   invalid_argument（否则向无 waiter 的事件名 sendEvent 静默无效，Workflow 永不解冻）。
   *   waiting_event 态当前模板不产（无 pendingCheckpoint）——保守放行（外部完成通知无 checkpoint 绑定）。
   * 恢复：env.WATT_TASK.get(taskId).sendEvent({ type: taskSignalEventName(checkpoint), payload })
   *   → Workflow 的 waitForEvent 解冻。payload 带 decision + 调用方 payload（模板代码分支解释）。
   */
  async signal(taskId: string, signal: SignalRequest): Promise<WattError | void> {
    const detail = await this.store.getDetail(taskId);
    if ('code' in detail) return detail; // not_found
    const conflict = checkSignalable(detail.state);
    if (conflict !== null) return conflict;
    // checkpoint 匹配：waiting_human 有 pendingCheckpoint 时必须对齐（防投错事件名导致永久悬挂）。
    const pending = detail.pendingCheckpoint;
    if (pending !== undefined && signal.checkpoint !== pending.checkpoint) {
      return wattError(
        'invalid_argument',
        `checkpoint mismatch: task waiting on '${pending.checkpoint}', got '${signal.checkpoint}'`,
        false,
      );
    }
    const type = taskSignalEventName(signal.checkpoint);
    if (typeof type !== 'string') return type; // 净化后非法（超长等）→ invalid_argument。
    const instance = await this.deps.env.WATT_TASK.get(taskId);
    await instance.sendEvent({
      type,
      payload: { decision: signal.decision, payload: signal.payload },
    });
  }

  /** ListDefinitions（§8 L793）——硬编码两部署模板（kind='deployed'，checkpoints 由模板代码声明）。 */
  listDefinitions(): Page<DefinitionInfo> {
    return {
      items: DEPLOYED_TEMPLATES.map((t) => ({
        name: t.name,
        kind: 'deployed' as const,
        description: t.description,
        checkpoints: t.checkpoints,
      })),
    };
  }
}
