import { describe, expect, it } from 'vitest';
import { applySignalTransition, checkSignalable } from './signal.ts';
import type { TaskState } from './types.ts';

/**
 * Signal 状态机纯判定（Proto §8 / DoD §7）。
 * oracle：waiting_human/waiting_event 可信号（null）；其余 5 态 → conflict；
 *   applySignalTransition 对可信号态恢复 running，其余透出 conflict。
 */

const ALL_STATES: TaskState[] = [
  'pending',
  'running',
  'waiting_human',
  'waiting_event',
  'done',
  'failed',
  'cancelled',
];
const SIGNALABLE: TaskState[] = ['waiting_human', 'waiting_event'];
const NON_SIGNALABLE = ALL_STATES.filter((s) => !SIGNALABLE.includes(s));

describe('checkSignalable', () => {
  it('waiting_human / waiting_event → null（可信号）', () => {
    for (const s of SIGNALABLE) {
      expect(checkSignalable(s)).toBeNull();
    }
  });

  it('其余 5 态 → conflict（message 带当前态、不可重试）', () => {
    for (const s of NON_SIGNALABLE) {
      const e = checkSignalable(s);
      expect(e?.code).toBe('conflict');
      expect(e?.retryable).toBe(false);
      expect(e?.message).toContain(s);
    }
  });
});

describe('applySignalTransition', () => {
  it('可信号态 + 任一 decision → next=running', () => {
    for (const s of SIGNALABLE) {
      for (const d of ['approve', 'reject', 'custom'] as const) {
        const r = applySignalTransition(s, d);
        expect(r).toEqual({ next: 'running' });
      }
    }
  });

  it('不可信号态 → error=conflict', () => {
    for (const s of NON_SIGNALABLE) {
      const r = applySignalTransition(s, 'approve');
      expect('error' in r).toBe(true);
      if ('error' in r) {
        expect(r.error.code).toBe('conflict');
      }
    }
  });
});
