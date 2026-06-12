import { describe, expect, it } from 'vitest';
import {
  JournalEntry,
  WaitForParams,
  WattEvent,
  newRunId,
  newSessionId,
  newTaskId,
  newAgentId,
  newWorkspaceId,
  newCheckpointId,
} from '../src/index.js';

const runId = newRunId(newTaskId());

describe('Host journal', () => {
  it('journal entry 以 seq 为键、fn 判别', () => {
    const entry = JournalEntry.parse({
      seq: 0,
      fn: 'checkpoint',
      params: { summary: '阶段一完成' },
      result: { ref: newCheckpointId() },
    });
    expect(entry.fn).toBe('checkpoint');
    // CheckpointParams 的 refs 有默认值
    expect(entry.params).toMatchObject({ refs: [] });
  });

  it('pending 调用允许无 result', () => {
    const pending = JournalEntry.parse({
      seq: 1,
      fn: 'sleep',
      params: { ms: 1000 },
    });
    expect(pending.result).toBeUndefined();
  });

  it('params 与 fn 不匹配时拒绝', () => {
    const bad = { seq: 2, fn: 'sleep', params: { summary: 'x' } };
    expect(JournalEntry.safeParse(bad).success).toBe(false);
  });

  it('run 结果可带类型化错误（continue-on-error）', () => {
    const failed = JournalEntry.parse({
      seq: 3,
      fn: 'run',
      params: {
        agent: 'research',
        ctx: {
          objective: 'o',
          inputs: [],
          budget: { maxCostUsd: 1, maxWallClockMs: 1000, maxToolCalls: 5 },
          expectedOutput: 'e',
          permissions: { contextScope: [] },
        },
      },
      result: {
        status: 'failed',
        costUsd: 0.02,
        error: { code: 'SchemaValidation', message: 'output 不符合 schema' },
      },
    });
    expect(failed.result).toMatchObject({ status: 'failed' });
  });

  it('eventKey 必须是分层字面键', () => {
    expect(
      WaitForParams.safeParse({ eventKey: 'github/pr_merged/o-r-123', timeoutMs: 1 }).success,
    ).toBe(true);
    expect(WaitForParams.safeParse({ eventKey: 'pr_merged', timeoutMs: 1 }).success).toBe(false);
  });
});

describe('事件互斥（run XOR session）', () => {
  const workspaceId = newWorkspaceId();
  const sessionId = newSessionId(newAgentId());
  const common = { workspaceId, eventIndex: 0, at: new Date(0).toISOString(), type: 't' };

  it('run 事件不接受 sessionId 字段值进入 runId', () => {
    expect(WattEvent.safeParse({ ...common, scope: 'run', runId: sessionId }).success).toBe(false);
    expect(WattEvent.safeParse({ ...common, scope: 'run', runId }).success).toBe(true);
  });

  it('session 事件不接受 runId 值', () => {
    expect(WattEvent.safeParse({ ...common, scope: 'session', sessionId: runId }).success).toBe(
      false,
    );
    expect(WattEvent.safeParse({ ...common, scope: 'session', sessionId }).success).toBe(true);
  });

  it('scope 与 id 字段名也互斥：run 事件带 sessionId 会被剥离', () => {
    const parsed = WattEvent.parse({ ...common, scope: 'run', runId, sessionId });
    expect('sessionId' in parsed).toBe(false);
  });
});
