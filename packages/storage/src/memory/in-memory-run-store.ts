/**
 * RunStore 的内存实现。单线程语义（不考虑并发），但单调/归属/幂等断言严格。
 *
 * 事件用 RunEvent.parse 校验（坏 scope / 错 runId / 错 eventIndex 由本实现断言）。
 * journal 用 JournalEntry.parse 校验形状，seq 幂等由本实现按 fn/params 深比较裁决。
 */
import type { JournalEntry, RunEvent } from '@watt/protocol';
import { RunEvent as RunEventSchema, JournalEntry as JournalEntrySchema } from '@watt/protocol';
import { conflict, notFound } from '../errors.js';
import type {
  CreateRunInput,
  RunRecord,
  RunStore,
  UpdateRunStatusInput,
} from '../run-store.js';
import { assertRunId } from '../run-store.js';

interface RunCell {
  record: RunRecord;
  events: RunEvent[];
  /** seq -> JournalEntry */
  journal: Map<number, JournalEntry>;
}

/** fn + params 是否一致：用于 journal 同 seq 幂等/冲突裁决。 */
const sameCall = (a: JournalEntry, b: JournalEntry): boolean =>
  a.fn === b.fn && stableEqual(a.params, b.params);

/** 结构化深比较（顺序无关的对象键、有序数组）。journal params 是纯 JSON 数据。 */
function stableEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => stableEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    if (ak.length !== bk.length) return false;
    return ak.every((k, i) => k === bk[i] && stableEqual(ao[k], bo[k]));
  }
  return false;
}

export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, RunCell>();

  private cell(runId: string): RunCell {
    const id = assertRunId(runId);
    const cell = this.runs.get(id);
    if (!cell) throw notFound(`run not found: ${id}`);
    return cell;
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const runId = assertRunId(input.runId);
    if (this.runs.has(runId)) throw conflict(`run already exists: ${runId}`);
    const now = new Date().toISOString();
    const record: RunRecord = {
      runId,
      taskId: input.taskId,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      ...(input.planVersionId ? { planVersionId: input.planVersionId } : {}),
    };
    this.runs.set(runId, { record, events: [], journal: new Map() });
    return { ...record };
  }

  async getRun(runId: string): Promise<RunRecord> {
    return { ...this.cell(runId).record };
  }

  async updateRunStatus(input: UpdateRunStatusInput): Promise<RunRecord> {
    const cell = this.cell(input.runId);
    cell.record = {
      ...cell.record,
      status: input.status,
      updatedAt: new Date().toISOString(),
      ...(input.planVersionId ? { planVersionId: input.planVersionId } : {}),
      ...(input.failure ? { failure: input.failure } : {}),
    };
    return { ...cell.record };
  }

  async appendEvent(runId: string, event: RunEvent): Promise<void> {
    const id = assertRunId(runId);
    const cell = this.cell(id);
    // 断言形状：scope === 'run' 且字段合法（SessionEvent 在此被拒）。
    const parsed = RunEventSchema.parse(event);
    if (parsed.runId !== id) {
      throw conflict(`event.runId ${parsed.runId} != target run ${id}`);
    }
    const expected = cell.events.length;
    if (parsed.eventIndex !== expected) {
      throw conflict(
        `eventIndex must be strictly monotonic: expected ${expected}, got ${parsed.eventIndex}`,
      );
    }
    cell.events.push(parsed);
  }

  async readEvents(runId: string, fromIndex = 0, toIndex?: number): Promise<RunEvent[]> {
    const cell = this.cell(runId);
    const end = toIndex ?? cell.events.length;
    return cell.events.slice(Math.max(0, fromIndex), Math.max(0, end));
  }

  async eventCount(runId: string): Promise<number> {
    return this.cell(runId).events.length;
  }

  async upsertJournalEntry(runId: string, entry: JournalEntry): Promise<JournalEntry> {
    const cell = this.cell(runId);
    const parsed = JournalEntrySchema.parse(entry);
    const existing = cell.journal.get(parsed.seq);
    if (!existing) {
      cell.journal.set(parsed.seq, parsed);
      return structuredClone(parsed);
    }
    // 同 seq：fn/params 必须一致，否则重放不一致。
    if (!sameCall(existing, parsed)) {
      throw conflict(
        `journal seq ${parsed.seq} conflict: fn/params differ from existing entry`,
      );
    }
    // 一致：处理 pending <-> completed。
    // 已有 result：保留（不被 pending 回退）。
    // 已有 pending 且新值带 result：补全为 completed。
    if (existing.result === undefined && parsed.result !== undefined) {
      cell.journal.set(parsed.seq, parsed);
      return structuredClone(parsed);
    }
    return structuredClone(existing);
  }

  async getJournalEntry(runId: string, seq: number): Promise<JournalEntry> {
    const entry = this.cell(runId).journal.get(seq);
    if (!entry) throw notFound(`journal entry not found: run ${runId} seq ${seq}`);
    return structuredClone(entry);
  }

  async readJournal(runId: string): Promise<JournalEntry[]> {
    const cell = this.cell(runId);
    return [...cell.journal.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((e) => structuredClone(e));
  }
}
