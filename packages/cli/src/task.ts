/**
 * `watt task list|get|run|signal|cancel`（Proto §8 TaskManager / DoD §7）。
 *
 * 挂载点：POST /htbp/platform/task `{tool,arguments}`（复用 client.ts htbpCall）。
 * 动词映射（DoD §7：run 是 CLI 动词，映射到 TaskManager.Write）：
 *  - list   → List            arguments:{opts:{filter?,limit?}}          → 裸 Page{items}（TaskInfo）
 *  - get    → Get             arguments:{taskId}                          → { task }（TaskDetail）
 *  - run    → Write           arguments:{request:{definition,input?,taskId?}} → { task }（TaskInfo）
 *  - signal → Signal          arguments:{taskId,signal:{checkpoint,decision,payload?}} → { signalled:true }
 *  - cancel → Cancel          arguments:{taskId,reason?}                  → { cancelled:true }
 *  - defs   → ListDefinitions arguments:{}                               → 裸 Page{items}（DefinitionInfo）
 *
 * 响应形状真源：gateway packages/gateway/test/platform-task.test.ts（§34 禁双形态兜底，无双形态解析）。
 */

import { type HttpDeps, htbpCall } from './client.ts';

/** TaskInfo 读投影（list/run 展示）。 */
export interface TaskInfoView {
  taskId: string;
  definition: string;
  state: string;
  currentStep?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  note?: string;
}

/** TaskDetail（get 展示）——扩展 steps/pendingCheckpoint/artifacts。 */
export interface TaskDetailView extends TaskInfoView {
  steps: { name: string; state: string; startedAt?: string; output?: unknown }[];
  pendingCheckpoint?: { checkpoint: string; prompt: string; requestedAt: string };
  artifacts: string[];
}

/** DefinitionInfo（defs 展示）。 */
export interface DefinitionInfoView {
  name: string;
  kind: string;
  description: string;
  checkpoints: string[];
}

interface TaskPage {
  items: TaskInfoView[];
}
interface DefinitionPage {
  items: DefinitionInfoView[];
}

export async function taskList(
  base: string,
  token: string,
  filter: { state?: string; definition?: string; limit?: number },
  deps: HttpDeps = {},
): Promise<TaskInfoView[]> {
  const filterObj: Record<string, string> = {};
  if (filter.state) filterObj.state = filter.state;
  if (filter.definition) filterObj.definition = filter.definition;
  const opts: { filter: Record<string, string>; limit?: number } = { filter: filterObj };
  if (filter.limit !== undefined) opts.limit = filter.limit;
  const body = (await htbpCall(base, token, 'task', 'List', { opts }, deps)) as TaskPage;
  return body.items;
}

export async function taskGet(
  base: string,
  token: string,
  taskId: string,
  deps: HttpDeps = {},
): Promise<TaskDetailView> {
  const body = (await htbpCall(base, token, 'task', 'Get', { taskId }, deps)) as {
    task: TaskDetailView;
  };
  return body.task;
}

export async function taskRun(
  base: string,
  token: string,
  request: { definition: string; input?: unknown; taskId?: string },
  deps: HttpDeps = {},
): Promise<TaskInfoView> {
  const body = (await htbpCall(base, token, 'task', 'Write', { request }, deps)) as {
    task: TaskInfoView;
  };
  return body.task;
}

export async function taskSignal(
  base: string,
  token: string,
  taskId: string,
  signal: { checkpoint: string; decision: string; payload?: unknown },
  deps: HttpDeps = {},
): Promise<void> {
  await htbpCall(base, token, 'task', 'Signal', { taskId, signal }, deps);
}

export async function taskCancel(
  base: string,
  token: string,
  taskId: string,
  reason: string | undefined,
  deps: HttpDeps = {},
): Promise<void> {
  const args: Record<string, unknown> = { taskId };
  if (reason !== undefined) args.reason = reason;
  await htbpCall(base, token, 'task', 'Cancel', args, deps);
}

export async function taskDefs(
  base: string,
  token: string,
  deps: HttpDeps = {},
): Promise<DefinitionInfoView[]> {
  const body = (await htbpCall(base, token, 'task', 'ListDefinitions', {}, deps)) as DefinitionPage;
  return body.items;
}

/** 单个任务的人类可读行（制表符分隔）。 */
export function formatTaskLine(t: TaskInfoView): string {
  return `${t.taskId}\t${t.definition}\t${t.state}\t${t.currentStep ?? '-'}`;
}

export function formatTaskListHuman(tasks: TaskInfoView[]): string {
  if (tasks.length === 0) return '(no tasks)';
  return tasks.map(formatTaskLine).join('\n');
}

export function formatDefinitionListHuman(defs: DefinitionInfoView[]): string {
  if (defs.length === 0) return '(no definitions)';
  return defs
    .map((d) => `${d.name}\t${d.kind}\t${d.description}\t[${d.checkpoints.join(',')}]`)
    .join('\n');
}
