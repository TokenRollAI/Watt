/**
 * TaskStore（Proto §8 TaskManager 状态持久化）——D1 持久化，无 Workflows 绑定。
 *
 * 库：watt-events（binding DB_EVENTS），表 tasks（见 migrations-events/0002_task_store.sql）。
 * 存 TaskInfo（§8 L806-815）+ TaskDetail 扩展（steps/pendingCheckpoint/artifacts，§8 L817-825）。
 * taskId 即 Workflows instance id（实现声明，见 migration 归属说明）——List/Get 的过滤与投影靠此表，
 * Workflows 实例本身不暴露自定义查询；Get 合成时叠加 instance.status()（引擎侧执行态）。
 *
 * 写入方：
 *  - TaskManager.Write：初始 pending 行；
 *  - WattTaskWorkflow 各 step：setState / setCheckpoint(waiting_human) / clearCheckpoint(恢复) /
 *    appendStep / addArtifacts / complete / fail（Workflow 内经 env.DB_EVENTS 直写，§8 引擎驱动状态）；
 *  - TaskManager.Update：patchNote（仅元信息，不碰执行状态）；Cancel：setState('cancelled')。
 * 手写 SQL（对齐 EventStore/ChannelStore）：D1 无 ORM，prepare+bind。
 */

import type { D1Database } from '@cloudflare/workers-types';
import {
  type PendingCheckpoint,
  type TaskDetail,
  type TaskInfo,
  type TaskState,
  type TaskStep,
  taskDetailSchema,
  taskInfoSchema,
} from '@watt/core';
import { type WattError, wattError } from '@watt/shared';

interface TaskRow {
  task_id: string;
  definition: string;
  state: string;
  current_step: string | null;
  note: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  steps_json: string;
  pending_checkpoint_json: string | null;
  artifacts_json: string;
}

/** Proto ListOptions（§0.2）——filter=state/definition（§8 List 语义）。 */
export interface ListOptions {
  cursor?: string;
  limit?: number;
  filter?: Record<string, string>;
}
export interface Page<T> {
  items: T[];
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** List 合法 filter 键（§8：state/definition + 时间范围 since/until）。 */
const ALLOWED_LIST_FILTER_KEYS = new Set(['state', 'definition', 'since', 'until']);

/** TaskRow → TaskInfo（不含 detail 扩展）。 */
function rowToInfo(row: TaskRow): TaskInfo {
  const info: TaskInfo = {
    taskId: row.task_id,
    definition: row.definition,
    state: row.state as TaskState,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.current_step !== null) info.currentStep = row.current_step;
  if (row.note !== null) info.note = row.note;
  return taskInfoSchema.parse(info);
}

/** TaskRow → TaskDetail（叠加 steps/pendingCheckpoint/artifacts）。 */
function rowToDetail(row: TaskRow): TaskDetail {
  const detail: TaskDetail = {
    ...rowToInfo(row),
    steps: JSON.parse(row.steps_json) as TaskStep[],
    artifacts: JSON.parse(row.artifacts_json) as string[],
  };
  if (row.pending_checkpoint_json !== null) {
    detail.pendingCheckpoint = JSON.parse(row.pending_checkpoint_json) as PendingCheckpoint;
  }
  return taskDetailSchema.parse(detail);
}

export class TaskStore {
  constructor(private readonly db: D1Database) {}

  /** 创建初始任务行（Write 时；state 通常 pending）。幂等 upsert（同 taskId 覆盖，支持 Write.taskId 幂等）。 */
  async create(args: {
    taskId: string;
    definition: string;
    state: TaskState;
    createdBy: string;
    now: string;
  }): Promise<TaskInfo> {
    await this.db
      .prepare(
        `INSERT INTO tasks (task_id, definition, state, created_by, created_at, updated_at, steps_json, artifacts_json)
         VALUES (?, ?, ?, ?, ?, ?, '[]', '[]')
         ON CONFLICT(task_id) DO UPDATE SET
           definition = excluded.definition, state = excluded.state, updated_at = excluded.updated_at`,
      )
      .bind(args.taskId, args.definition, args.state, args.createdBy, args.now, args.now)
      .run();
    const info = await this.getInfo(args.taskId);
    // 刚 upsert，必存在。
    return info as TaskInfo;
  }

  /** 读 TaskInfo（不存在 → null）。 */
  async getInfo(taskId: string): Promise<TaskInfo | null> {
    const row = await this.row(taskId);
    return row === null ? null : rowToInfo(row);
  }

  /** 读 TaskDetail（不存在 → not_found）。 */
  async getDetail(taskId: string): Promise<TaskDetail | WattError> {
    const row = await this.row(taskId);
    if (row === null) return wattError('not_found', `task not found: ${taskId}`, false);
    return rowToDetail(row);
  }

  private async row(taskId: string): Promise<TaskRow | null> {
    return this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').bind(taskId).first<TaskRow>();
  }

  /**
   * List（§8 / §0.2）——filter=state/definition/since/until，返回 Page<TaskInfo>。
   * limit 默认 50、上限 200；未声明的 filter 键 → invalid_argument（对齐 EventStore.list）。
   * 按 created_at 倒序（最新在前）。
   */
  async list(opts: ListOptions = {}): Promise<Page<TaskInfo> | WattError> {
    const filter = opts.filter ?? {};
    for (const key of Object.keys(filter)) {
      if (!ALLOWED_LIST_FILTER_KEYS.has(key)) {
        return wattError('invalid_argument', `unknown filter key: ${key}`, false);
      }
    }
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
    const clauses: string[] = [];
    const binds: string[] = [];
    if (filter.state !== undefined) {
      clauses.push('state = ?');
      binds.push(filter.state);
    }
    if (filter.definition !== undefined) {
      clauses.push('definition = ?');
      binds.push(filter.definition);
    }
    if (filter.since !== undefined) {
      clauses.push('created_at >= ?');
      binds.push(filter.since);
    }
    if (filter.until !== undefined) {
      clauses.push('created_at < ?');
      binds.push(filter.until);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const { results } = await this.db
      .prepare(`SELECT * FROM tasks${where} ORDER BY created_at DESC LIMIT ?`)
      .bind(...binds, limit)
      .all<TaskRow>();
    return { items: results.map(rowToInfo) };
  }

  /** 更新执行状态（引擎驱动，§8 L800）+ currentStep。同步 updated_at。 */
  async setState(
    taskId: string,
    state: TaskState,
    now: string,
    currentStep?: string,
  ): Promise<void> {
    await this.db
      .prepare('UPDATE tasks SET state = ?, current_step = ?, updated_at = ? WHERE task_id = ?')
      .bind(state, currentStep ?? null, now, taskId)
      .run();
  }

  /** 进 waiting_human：写 pendingCheckpoint + state（§8 L820-824）。 */
  async setCheckpoint(taskId: string, pending: PendingCheckpoint, now: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE tasks SET state = 'waiting_human', pending_checkpoint_json = ?, current_step = ?, updated_at = ? WHERE task_id = ?",
      )
      .bind(JSON.stringify(pending), pending.checkpoint, now, taskId)
      .run();
  }

  /** 恢复（signal 到达）：清 pendingCheckpoint + 置 running。 */
  async clearCheckpoint(taskId: string, now: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE tasks SET state = 'running', pending_checkpoint_json = NULL, updated_at = ? WHERE task_id = ?",
      )
      .bind(now, taskId)
      .run();
  }

  /** 追加一个 step 记录（Workflow step.do 产出后调）。读-改-写（Workflow step 内串行，无并发）。 */
  async appendStep(taskId: string, step: TaskStep, now: string): Promise<void> {
    const row = await this.row(taskId);
    if (row === null) return;
    const steps = JSON.parse(row.steps_json) as TaskStep[];
    steps.push(step);
    await this.db
      .prepare(
        'UPDATE tasks SET steps_json = ?, current_step = ?, updated_at = ? WHERE task_id = ?',
      )
      .bind(JSON.stringify(steps), step.name, now, taskId)
      .run();
  }

  /** 追加 artifacts（context:// URI）。 */
  async addArtifacts(taskId: string, uris: string[], now: string): Promise<void> {
    if (uris.length === 0) return;
    const row = await this.row(taskId);
    if (row === null) return;
    const existing = JSON.parse(row.artifacts_json) as string[];
    const merged = [...existing, ...uris];
    await this.db
      .prepare('UPDATE tasks SET artifacts_json = ?, updated_at = ? WHERE task_id = ?')
      .bind(JSON.stringify(merged), now, taskId)
      .run();
  }

  /** Update.note（§8 L800，仅元信息，不碰执行状态）。 */
  async patchNote(taskId: string, note: string, now: string): Promise<TaskInfo | WattError> {
    const row = await this.row(taskId);
    if (row === null) return wattError('not_found', `task not found: ${taskId}`, false);
    await this.db
      .prepare('UPDATE tasks SET note = ?, updated_at = ? WHERE task_id = ?')
      .bind(note, now, taskId)
      .run();
    return (await this.getInfo(taskId)) as TaskInfo;
  }
}
