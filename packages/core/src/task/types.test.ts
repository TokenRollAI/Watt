import { describe, expect, it } from 'vitest';
import {
  cronJobSchema,
  signalRequestSchema,
  taskDetailSchema,
  taskInfoSchema,
  taskStateSchema,
  taskWriteRequestSchema,
} from './types.ts';

/**
 * Task + Scheduler 类型层 zod schema（Proto §7 / §8）。
 * oracle：7 态枚举、TaskInfo/TaskDetail/SignalRequest/CronJob/Write 请求的接受与拒绝面。
 */

describe('taskStateSchema — 7 态', () => {
  it('接受全部 7 态', () => {
    for (const s of [
      'pending',
      'running',
      'waiting_human',
      'waiting_event',
      'done',
      'failed',
      'cancelled',
    ]) {
      expect(taskStateSchema.safeParse(s).success).toBe(true);
    }
  });
  it('拒绝未知态', () => {
    expect(taskStateSchema.safeParse('paused').success).toBe(false);
  });
});

describe('taskInfoSchema', () => {
  const base = {
    taskId: 't1',
    definition: 'deep-research',
    state: 'running',
    createdBy: 'user:alice',
    createdAt: '2026-07-03T00:00:00Z',
    updatedAt: '2026-07-03T00:00:00Z',
  };
  it('接受最小面（无可选字段）', () => {
    expect(taskInfoSchema.safeParse(base).success).toBe(true);
  });
  it('接受 currentStep / note 可选字段', () => {
    expect(taskInfoSchema.safeParse({ ...base, currentStep: 's1', note: 'n' }).success).toBe(true);
  });
  it('缺必填字段 → 拒绝', () => {
    const { taskId, ...rest } = base;
    void taskId;
    expect(taskInfoSchema.safeParse(rest).success).toBe(false);
  });
});

describe('taskDetailSchema', () => {
  const detail = {
    taskId: 't1',
    definition: 'deep-research',
    state: 'waiting_human',
    createdBy: 'user:alice',
    createdAt: '2026-07-03T00:00:00Z',
    updatedAt: '2026-07-03T00:00:00Z',
    steps: [{ name: 'plan', state: 'done', output: { x: 1 } }],
    pendingCheckpoint: {
      checkpoint: 'confirm',
      prompt: '确认?',
      requestedAt: '2026-07-03T00:00:00Z',
    },
    artifacts: ['context://out/1'],
  };
  it('接受完整 detail', () => {
    expect(taskDetailSchema.safeParse(detail).success).toBe(true);
  });
  it('接受无 pendingCheckpoint（非 waiting_human）', () => {
    const { pendingCheckpoint, ...rest } = detail;
    void pendingCheckpoint;
    expect(taskDetailSchema.safeParse({ ...rest, state: 'running' }).success).toBe(true);
  });
  it('artifacts 必填', () => {
    const { artifacts, ...rest } = detail;
    void artifacts;
    expect(taskDetailSchema.safeParse(rest).success).toBe(false);
  });
});

describe('signalRequestSchema', () => {
  it('接受三态 decision + 可选 payload', () => {
    expect(signalRequestSchema.safeParse({ checkpoint: 'cp', decision: 'approve' }).success).toBe(
      true,
    );
    expect(
      signalRequestSchema.safeParse({ checkpoint: 'cp', decision: 'custom', payload: { a: 1 } })
        .success,
    ).toBe(true);
  });
  it('拒绝非三态 decision', () => {
    expect(signalRequestSchema.safeParse({ checkpoint: 'cp', decision: 'yes' }).success).toBe(
      false,
    );
  });
});

describe('taskWriteRequestSchema', () => {
  it('接受最小面（仅 definition）', () => {
    expect(taskWriteRequestSchema.safeParse({ definition: 'deep-research' }).success).toBe(true);
  });
  it('接受 input / taskId 可选', () => {
    expect(
      taskWriteRequestSchema.safeParse({ definition: 'd', input: { q: 1 }, taskId: 't' }).success,
    ).toBe(true);
  });
  it('缺 definition → 拒绝', () => {
    expect(taskWriteRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('cronJobSchema — 全字段面（§7）', () => {
  const base = {
    id: 'j1',
    description: '每日巡检',
    schedule: '0 2 * * *',
    enabled: true,
    createdBy: 'user:admin',
  };
  it('接受 publish action', () => {
    const job = { ...base, action: { kind: 'publish', event: { type: 'ping' } } };
    expect(cronJobSchema.safeParse(job).success).toBe(true);
  });
  it('接受 agent action', () => {
    const job = { ...base, action: { kind: 'agent', definition: 'checker' } };
    expect(cronJobSchema.safeParse(job).success).toBe(true);
  });
  it('接受 script action（grants）', () => {
    const job = {
      ...base,
      action: {
        kind: 'script',
        scriptRef: 'context://automations/1',
        grants: [{ resources: ['platform://metrics'], actions: ['read'] }],
      },
    };
    expect(cronJobSchema.safeParse(job).success).toBe(true);
  });
  it('拒绝未知 action.kind', () => {
    const job = { ...base, action: { kind: 'unknown' } };
    expect(cronJobSchema.safeParse(job).success).toBe(false);
  });
  it('缺必填字段（createdBy）→ 拒绝', () => {
    const { createdBy, ...rest } = base;
    void createdBy;
    const job = { ...rest, action: { kind: 'publish', event: { type: 'ping' } } };
    expect(cronJobSchema.safeParse(job).success).toBe(false);
  });
});
