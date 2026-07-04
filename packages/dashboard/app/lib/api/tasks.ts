/**
 * tasks domain wrappers（视图族 C）——POST /htbp/platform/task {tool,arguments}。
 *
 * 请求形状真源：packages/cli/src/task.ts（htbpCall 调用点）+ gateway 路由测试。禁自创形状、禁双形态兜底解析（§34）。
 * 动词映射（CLI 动词 → TaskManager tool）：
 *  - list   → List            {opts:{filter?,limit?}}                          → 裸 Page{items}（TaskInfo）
 *  - get    → Get             {taskId}                                         → { task }（TaskDetail）
 *  - run    → Write           {request:{definition,input?,taskId?}}            → { task }（TaskInfo）
 *  - signal → Signal          {taskId,signal:{checkpoint,decision,payload?}}   → { signalled:true }
 *  - cancel → Cancel          {taskId,reason?}                                 → { cancelled:true }
 *  - defs   → ListDefinitions {}                                              → 裸 Page{items}（DefinitionInfo）
 *
 * scheduler 的 List/Write/Delete wrapper 已在 platform.ts（api.listCron/createCron/deleteCron）；
 * cron 的 Get/Trigger 放此处（不动 platform.ts），形状真源 packages/cli/src/cron.ts。
 */

import { htbp } from './core.ts';
import type { CronJob, Page } from './types.ts';

/** TaskDetail（Get 展示）——扩展 steps/pendingCheckpoint/artifacts。形状真源 cli/src/task.ts TaskDetailView。 */
export interface TaskDetail {
  taskId: string;
  definition: string;
  state: string;
  currentStep?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  note?: string;
  steps: { name: string; state: string; startedAt?: string; output?: unknown }[];
  pendingCheckpoint?: { checkpoint: string; prompt: string; requestedAt: string };
  artifacts: string[];
}

/** DefinitionInfo（ListDefinitions → run 选 def）。 */
export interface TaskDefinitionInfo {
  name: string;
  kind: string;
  description: string;
  checkpoints: string[];
}

export const tasksApi = {
  // Get：单任务详情（checkpoints/结果）。
  getTask: (taskId: string) => htbp<{ task: TaskDetail }>('task', 'Get', { taskId }),
  // ListDefinitions：run 表单的 def 下拉。
  listTaskDefs: () => htbp<Page<TaskDefinitionInfo>>('task', 'ListDefinitions', {}),
  // run → Write：从 def + input 起一个任务。
  runTask: (request: { definition: string; input?: unknown; taskId?: string }) =>
    htbp<{ task: TaskDetail }>('task', 'Write', { request }),
  // Signal：checkpoint 决策（approve/reject/自定义 decision）。
  signalTask: (
    taskId: string,
    signal: { checkpoint: string; decision: string; payload?: unknown },
  ) => htbp<{ signalled: boolean }>('task', 'Signal', { taskId, signal }),
  // Cancel：取消任务（reason 可选）。
  cancelTask: (taskId: string, reason?: string) =>
    htbp<{ cancelled: boolean }>(
      'task',
      'Cancel',
      reason !== undefined ? { taskId, reason } : { taskId },
    ),
  // cron Get/Trigger（scheduler List/Write/Delete 在 platform.ts）。
  getCron: (jobId: string) => htbp<{ job: CronJob }>('scheduler', 'Get', { jobId }),
  triggerCron: (jobId: string) => htbp<{ eventId: string }>('scheduler', 'Trigger', { jobId }),
};
