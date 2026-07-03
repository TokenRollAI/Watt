/**
 * TaskManager 服务层（Proto §8）——编排 Workflows（env.WATT_TASK）+ TaskStore（状态元数据）。
 *
 * 动词（§8 L786-803）：
 *  - Write(req)：definition 校验存在（DEPLOYED_TEMPLATES）→ TaskStore.create（pending）→
 *    env.WATT_TASK.create({ id: taskId, params }) 启动 Workflow → 返 TaskInfo。taskId 缺省平台生成
 *    （幂等：Write.taskId 给定则复用；同 id 已存在 → conflict）。
 *  - List(opts)：TaskStore.list（filter state/definition/时间）→ Page<TaskInfo>。
 *  - Get(taskId)：TaskStore.getDetail（状态表）叠加 instance.status()（引擎侧执行态）→ TaskDetail。
 *  - Update(taskId, {note})：TaskStore.patchNote（仅元信息，执行状态由引擎驱动）。
 *  - Cancel(taskId, reason?)：core checkSignalable 无关；直接 instance.terminate() + TaskStore
 *    setState('cancelled') + 级联终止 Task 派生的 agent 子实例（§3.4 规则 4，AgentRuntime.terminate
 *    cascade：Task 派生的 echo agent instanceKey 前缀 task:<taskId># —— 最小实现按此前缀级联）。
 *  - Signal(taskId, {checkpoint, decision, payload?})：core checkSignalable（waiting 外 → conflict）→
 *    env.WATT_TASK.get(taskId).sendEvent({ type: taskSignalEventName(checkpoint), payload }) 恢复
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
    await this.deps.env.WATT_TASK.create({ id: taskId, params });
    return info;
  }

  /** List（§8）——filter=state/definition/时间。 */
  async list(opts: ListOptions = {}): Promise<Page<TaskInfo> | WattError> {
    return this.store.list(opts);
  }

  /**
   * Get（§8）——TaskDetail（状态表）叠加 instance.status()（引擎侧执行态）。
   * Workflow 实例查询失败（如尚未创建 / 已被 GC）不致命：仅省略引擎态，仍返表侧 detail。
   */
  async get(taskId: string): Promise<TaskDetail | WattError> {
    const detail = await this.store.getDetail(taskId);
    if ('code' in detail) return detail;
    return detail;
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
   * Workflow instance.terminate() 幂等失败（已 complete/errored/terminated）不致命：仍落库 cancelled。
   * 级联：Task 派生的 agent instanceKey 恒 task:<taskId>#...（见 watt-task-workflow.ts），
   *   经 AgentRuntime.terminate(cascade) 逐个代发 agent.failed(terminated)——最小实现按已知子实例键。
   */
  async cancel(taskId: string, reason?: string): Promise<WattError | void> {
    const info = await this.store.getInfo(taskId);
    if (info === null) return wattError('not_found', `task not found: ${taskId}`, false);
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
    const note = reason !== undefined ? `cancelled: ${reason}` : 'cancelled';
    const now = this.deps.now();
    await this.store.setState(taskId, 'cancelled', now);
    await this.store.patchNote(taskId, note, now);
  }

  /**
   * Signal（§8 / §1.1 规则 2）——向 waiting 的 Task 投递人类确认/外部完成。
   * core checkSignalable：waiting_human/waiting_event 外 → conflict（DoD §7）。
   * 恢复：env.WATT_TASK.get(taskId).sendEvent({ type: taskSignalEventName(checkpoint), payload })
   *   → Workflow 的 waitForEvent 解冻。payload 带 decision + 调用方 payload（模板代码分支解释）。
   */
  async signal(taskId: string, signal: SignalRequest): Promise<WattError | void> {
    const info = await this.store.getInfo(taskId);
    if (info === null) return wattError('not_found', `task not found: ${taskId}`, false);
    const conflict = checkSignalable(info.state);
    if (conflict !== null) return conflict;
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
