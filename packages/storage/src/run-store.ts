/**
 * RunStore：Run 维度的权威状态（执行期间状态权威是 Run Coordinator DO，
 * 本接口是其存储契约的平台无关表达；D1 Run index 是异步查询投影，不在此）。
 *
 * 三块职责，三组语义契约：
 *
 * 1. Run 记录：创建 + 状态机推进。状态机保持最小（见 RunStatus）。
 * 2. 运行事件日志：append-only，eventIndex 严格单调（期望值 = 当前长度）。
 *    断言 event.scope === 'run' 且 event.runId 与目标 run 一致——SessionEvent
 *    投进 RunStore 必被拒（结构防线第三道：存储隔离）。
 * 3. PlanScript journal：以 seq 为键幂等 upsert。同 seq 的 pending→completed
 *    是合法补全；同 seq 不同 fn/params 是冲突（重放不一致）必拒。
 *
 * 接口面向"调用方需要什么"：Run Coordinator 需要 append 事件、读区间、
 * 推进状态、写 journal、按 seq 重放。不预设 D1 投影、不预设归档。
 */
import type { JournalEntry, RunEvent } from '@watt/protocol';
import { RunId } from '@watt/protocol';

/**
 * Run 最小状态机。docs/architecture.md「Run Store」要求承载
 * retry / cancel / failure state，这里收敛为五态：
 * - pending：已创建未派发。
 * - running：脚本执行中。
 * - succeeded / failed / cancelled：终态。
 *
 * 不在协议层（protocol-v1 未定义 Run 状态枚举），故由存储契约自定，保持最小。
 */
export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** Run 记录：执行状态的最小投影。详细计数器（预算）属 Run Coordinator，不在此。 */
export interface RunRecord {
  runId: string;
  /** 编码所属 task（由 run id 语法保证），冗余存一份便于按 task 列出 */
  taskId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  /** 当前 PlanVersion 索引（脚本本体在 ArtifactStore）。pending 时可空。 */
  planVersionId?: string;
  /** 终态失败原因，仅 failed 有意义 */
  failure?: { code: string; message: string };
}

export interface CreateRunInput {
  runId: string;
  taskId: string;
  planVersionId?: string;
}

export interface UpdateRunStatusInput {
  runId: string;
  status: RunStatus;
  planVersionId?: string;
  failure?: { code: string; message: string };
}

export interface RunStore {
  /** 创建 Run 记录。runId 必须通过 RunId 校验；重复创建同 runId 抛 conflict。 */
  createRun(input: CreateRunInput): Promise<RunRecord>;

  /** 取 Run 记录，缺失抛 not_found。 */
  getRun(runId: string): Promise<RunRecord>;

  /** 推进状态机。runId 必须已存在。可选带 planVersionId / failure。 */
  updateRunStatus(input: UpdateRunStatusInput): Promise<RunRecord>;

  /**
   * append 一条运行事件。约束：
   * - event 必须是 RunEvent（scope === 'run'），SessionEvent 被拒。
   * - event.runId 必须等于参数 runId。
   * - event.eventIndex 必须严格等于当前日志长度（严格单调、无跳号、无重复）。
   *   重复 index / 跳号 / 乱序一律抛 conflict。
   */
  appendEvent(runId: string, event: RunEvent): Promise<void>;

  /**
   * 读事件区间 [fromIndex, toIndex)（半开区间）。toIndex 省略即到末尾。
   * 越界自动收敛到有效范围，不抛错。
   */
  readEvents(runId: string, fromIndex?: number, toIndex?: number): Promise<RunEvent[]>;

  /** 当前事件日志长度（= 下一个合法 eventIndex）。 */
  eventCount(runId: string): Promise<number>;

  /**
   * 幂等 upsert 一条 journal 记录（以 seq 为键）。约束：
   * - 同 seq 首次写入：插入。
   * - 同 seq 重复写入且 fn/params 完全一致：幂等。
   *   * 已有 result 而新值 pending：保留已有 result（不回退到 pending）。
   *   * 已有 pending 而新值带 result：补全为 completed（合法 pending→completed）。
   * - 同 seq 但 fn 或 params 不一致：抛 conflict（重放不一致）。
   */
  upsertJournalEntry(runId: string, entry: JournalEntry): Promise<JournalEntry>;

  /** 取某条 journal 记录，缺失抛 not_found。 */
  getJournalEntry(runId: string, seq: number): Promise<JournalEntry>;

  /** 读全部 journal 记录，按 seq 升序。 */
  readJournal(runId: string): Promise<JournalEntry[]>;
}

/** 校验并返回规范化 runId（坏 id 抛 ZodError）。供实现与调用方复用。 */
export const assertRunId = (runId: string): string => RunId.parse(runId);
