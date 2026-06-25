import { describe, expect, it } from 'vitest';
import {
  newRunId,
  newTaskId,
  newSessionId,
  newAgentId,
  newWorkspaceId,
  newCheckpointId,
  type RunEvent,
  type SessionEvent,
} from '@watt/protocol';
import { InMemoryRunStore, StorageError } from '../src/index.js';

const at = () => new Date().toISOString();

function makeRunStore() {
  const store = new InMemoryRunStore();
  const taskId = newTaskId();
  const runId = newRunId(taskId);
  const workspaceId = newWorkspaceId();
  return { store, taskId, runId, workspaceId };
}

const runEvent = (
  workspaceId: string,
  runId: string,
  eventIndex: number,
): RunEvent => ({
  scope: 'run',
  workspaceId,
  runId,
  eventIndex,
  at: at(),
  type: 'test',
  payload: {},
});

describe('RunStore Run 记录', () => {
  it('创建 / 取 / 推进状态', async () => {
    const { store, taskId, runId } = makeRunStore();
    const rec = await store.createRun({ runId, taskId });
    expect(rec.status).toBe('pending');
    expect(rec.taskId).toBe(taskId);

    const updated = await store.updateRunStatus({ runId, status: 'running' });
    expect(updated.status).toBe('running');

    const failed = await store.updateRunStatus({
      runId,
      status: 'failed',
      failure: { code: 'X', message: 'boom' },
    });
    expect(failed.failure).toEqual({ code: 'X', message: 'boom' });
  });

  it('重复创建同 runId 抛 conflict', async () => {
    const { store, taskId, runId } = makeRunStore();
    await store.createRun({ runId, taskId });
    await expect(store.createRun({ runId, taskId })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('坏 runId 抛错（schema 校验）', async () => {
    const { store, taskId } = makeRunStore();
    await expect(store.createRun({ runId: 'not-a-run', taskId })).rejects.toThrow();
  });
});

describe('RunStore eventIndex 严格单调', () => {
  it('正确递增序列成功', async () => {
    const { store, taskId, runId, workspaceId } = makeRunStore();
    await store.createRun({ runId, taskId });
    await store.appendEvent(runId, runEvent(workspaceId, runId, 0));
    await store.appendEvent(runId, runEvent(workspaceId, runId, 1));
    await store.appendEvent(runId, runEvent(workspaceId, runId, 2));
    expect(await store.eventCount(runId)).toBe(3);
    const events = await store.readEvents(runId);
    expect(events.map((e) => e.eventIndex)).toEqual([0, 1, 2]);
  });

  it('跳号被拒（0 后直接 2）', async () => {
    const { store, taskId, runId, workspaceId } = makeRunStore();
    await store.createRun({ runId, taskId });
    await store.appendEvent(runId, runEvent(workspaceId, runId, 0));
    await expect(
      store.appendEvent(runId, runEvent(workspaceId, runId, 2)),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('重复 index 被拒（重写 0）', async () => {
    const { store, taskId, runId, workspaceId } = makeRunStore();
    await store.createRun({ runId, taskId });
    await store.appendEvent(runId, runEvent(workspaceId, runId, 0));
    await expect(
      store.appendEvent(runId, runEvent(workspaceId, runId, 0)),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('乱序（首条非 0）被拒', async () => {
    const { store, taskId, runId, workspaceId } = makeRunStore();
    await store.createRun({ runId, taskId });
    await expect(
      store.appendEvent(runId, runEvent(workspaceId, runId, 1)),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('读区间为半开 [from, to)', async () => {
    const { store, taskId, runId, workspaceId } = makeRunStore();
    await store.createRun({ runId, taskId });
    for (let i = 0; i < 5; i++) {
      await store.appendEvent(runId, runEvent(workspaceId, runId, i));
    }
    expect((await store.readEvents(runId, 1, 3)).map((e) => e.eventIndex)).toEqual([1, 2]);
    expect((await store.readEvents(runId, 3)).map((e) => e.eventIndex)).toEqual([3, 4]);
  });
});

describe('RunStore runId / scope 断言', () => {
  it('event.runId 与目标 run 不一致被拒', async () => {
    const { store, taskId, runId, workspaceId } = makeRunStore();
    await store.createRun({ runId, taskId });
    const otherRunId = newRunId(newTaskId());
    await expect(
      store.appendEvent(runId, runEvent(workspaceId, otherRunId, 0)),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('SessionEvent 投进 RunStore 被拒（scope 不符）', async () => {
    const { store, taskId, runId, workspaceId } = makeRunStore();
    await store.createRun({ runId, taskId });
    const sessionEvent = {
      scope: 'session',
      workspaceId,
      sessionId: newSessionId(newAgentId()),
      eventIndex: 0,
      at: at(),
      type: 'test',
      payload: {},
    } as unknown as RunEvent;
    // 运行时 schema 校验拒绝（RunEvent.parse 要求 scope === 'run'）。
    await expect(store.appendEvent(runId, sessionEvent)).rejects.toThrow();
  });
});

describe('RunStore Journal 幂等 upsert', () => {
  const pendingSleep = (seq: number) =>
    ({ seq, fn: 'sleep', params: { ms: 1000 } }) as const;

  it('同 seq pending→completed 合法补全', async () => {
    const { store, taskId, runId } = makeRunStore();
    await store.createRun({ runId, taskId });
    const inserted = await store.upsertJournalEntry(runId, pendingSleep(0));
    expect(inserted.result).toBeUndefined();

    const completed = await store.upsertJournalEntry(runId, {
      seq: 0,
      fn: 'sleep',
      params: { ms: 1000 },
      result: {},
    });
    expect(completed.result).toEqual({});

    // 已完成后再写 pending 不回退。
    const again = await store.upsertJournalEntry(runId, pendingSleep(0));
    expect(again.result).toEqual({});
  });

  it('同 seq 不同 params 被拒（重放不一致）', async () => {
    const { store, taskId, runId } = makeRunStore();
    await store.createRun({ runId, taskId });
    await store.upsertJournalEntry(runId, pendingSleep(0));
    await expect(
      store.upsertJournalEntry(runId, { seq: 0, fn: 'sleep', params: { ms: 9999 } }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('同 seq 不同 fn 被拒', async () => {
    const { store, taskId, runId } = makeRunStore();
    await store.createRun({ runId, taskId });
    await store.upsertJournalEntry(runId, pendingSleep(0));
    await expect(
      store.upsertJournalEntry(runId, {
        seq: 0,
        fn: 'checkpoint',
        params: { summary: 's', refs: [] },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('readJournal 按 seq 升序', async () => {
    const { store, taskId, runId } = makeRunStore();
    await store.createRun({ runId, taskId });
    await store.upsertJournalEntry(runId, pendingSleep(2));
    await store.upsertJournalEntry(runId, pendingSleep(0));
    await store.upsertJournalEntry(runId, pendingSleep(1));
    expect((await store.readJournal(runId)).map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('坏 journal 形状（params 与 fn 不匹配）抛错', async () => {
    const { store, taskId, runId } = makeRunStore();
    await store.createRun({ runId, taskId });
    await expect(
      store.upsertJournalEntry(runId, {
        seq: 0,
        fn: 'sleep',
        params: { summary: 'x' },
      } as never),
    ).rejects.toThrow();
  });

  it('StorageError 暴露 code 与类型', async () => {
    const { store, taskId, runId } = makeRunStore();
    await store.createRun({ runId, taskId });
    await store.createRun({ runId, taskId }).catch((e) => {
      expect(e).toBeInstanceOf(StorageError);
    });
    const refs = newCheckpointId(); // 仅确认导入可用，无副作用
    expect(refs).toMatch(/^ckpt_/);
  });
});
