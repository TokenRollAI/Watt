import { describe, expect, it } from 'vitest';
import { parseImActionSignal, parseTaskCheckpoint } from './checkpoint.ts';

/**
 * task.checkpoint / im.action type guard 下沉到 core（Proto §1.1）。
 * oracle：与 gateway consumer 现有实现语义一致——合法 payload 解析、各字段缺失/畸形 → null。
 */

describe('parseTaskCheckpoint', () => {
  const valid = {
    taskId: 't1',
    checkpoint: 'confirm-release',
    prompt: '请确认上线',
    options: ['approve', 'reject'],
    notify: { channel: 'feishu', target: 'oc_x' },
  };

  it('合法 payload → 解析', () => {
    expect(parseTaskCheckpoint(valid)).toEqual(valid);
  });

  it('非对象 → null', () => {
    expect(parseTaskCheckpoint(null)).toBeNull();
    expect(parseTaskCheckpoint('x')).toBeNull();
  });

  it('taskId/checkpoint/prompt 非字符串 → null', () => {
    expect(parseTaskCheckpoint({ ...valid, taskId: 1 })).toBeNull();
    expect(parseTaskCheckpoint({ ...valid, checkpoint: 1 })).toBeNull();
    expect(parseTaskCheckpoint({ ...valid, prompt: 1 })).toBeNull();
  });

  it('options 非数组 / 空 / 含非法 decision → null', () => {
    expect(parseTaskCheckpoint({ ...valid, options: 'approve' })).toBeNull();
    expect(parseTaskCheckpoint({ ...valid, options: [] })).toBeNull();
    expect(parseTaskCheckpoint({ ...valid, options: ['yes'] })).toBeNull();
  });

  it('notify 缺字段 / 非对象 → null', () => {
    expect(parseTaskCheckpoint({ ...valid, notify: null })).toBeNull();
    expect(parseTaskCheckpoint({ ...valid, notify: { channel: 'x' } })).toBeNull();
    expect(parseTaskCheckpoint({ ...valid, notify: { channel: 1, target: 'x' } })).toBeNull();
  });
});

describe('parseImActionSignal', () => {
  const valid = { signal: { taskId: 't1', checkpoint: 'cp', decision: 'approve' } };

  it('合法 signal → 解析', () => {
    expect(parseImActionSignal(valid)).toEqual({
      taskId: 't1',
      checkpoint: 'cp',
      decision: 'approve',
    });
  });

  it('非对象 payload → null', () => {
    expect(parseImActionSignal(undefined)).toBeNull();
  });

  it('无 signal / signal 非对象 → null', () => {
    expect(parseImActionSignal({})).toBeNull();
    expect(parseImActionSignal({ signal: 'x' })).toBeNull();
  });

  it('signal.taskId/checkpoint 非字符串 → null', () => {
    expect(
      parseImActionSignal({ signal: { taskId: 1, checkpoint: 'cp', decision: 'approve' } }),
    ).toBeNull();
    expect(
      parseImActionSignal({ signal: { taskId: 't', checkpoint: 1, decision: 'approve' } }),
    ).toBeNull();
  });

  it('signal.decision 非三态 → null', () => {
    expect(
      parseImActionSignal({ signal: { taskId: 't', checkpoint: 'cp', decision: 'yes' } }),
    ).toBeNull();
  });

  it('decision 三态全接受', () => {
    for (const d of ['approve', 'reject', 'custom']) {
      expect(
        parseImActionSignal({ signal: { taskId: 't', checkpoint: 'cp', decision: d } }),
      ).not.toBeNull();
    }
  });
});
