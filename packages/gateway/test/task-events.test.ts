import type { Event } from '@watt/core';
import { describe, expect, it } from 'vitest';
import { toMergedResultPayload } from '../src/task/task-events.ts';

/**
 * toMergedResultPayload（§3.4 result/failed 归并）单测——纯函数，无 workerd 依赖。
 * 锁定 MINOR 修复：agent.failed 归并须保留 AgentFailedPayload.reason（否则 Workflow 侧只剩笼统 failed）。
 */

function eventOf(type: string, payload: Record<string, unknown>): Event {
  return {
    id: 'ev-1',
    traceId: 'tr-1',
    occurredAt: '2026-07-03T00:00:00.000Z',
    source: { kind: 'agent', ref: 'a-1' },
    type,
    payload,
  } as unknown as Event;
}

describe('toMergedResultPayload', () => {
  it('agent.result → { status:result, output }（无 reason）', () => {
    const merged = toMergedResultPayload(eventOf('agent.result', { output: { n: 1 } }));
    expect(merged.status).toBe('result');
    expect(merged.output).toEqual({ n: 1 });
    expect(merged.reason).toBeUndefined();
  });

  it('agent.failed → 保留 reason（五态）+ error', () => {
    const merged = toMergedResultPayload(
      eventOf('agent.failed', {
        reason: 'timeout',
        error: { code: 'unavailable', message: 'boom', retryable: true },
      }),
    );
    expect(merged.status).toBe('failed');
    expect(merged.reason).toBe('timeout');
    expect(merged.error).toEqual({ code: 'unavailable', message: 'boom', retryable: true });
  });

  it('agent.failed 无 reason 字段 → reason undefined（防御非字符串）', () => {
    const merged = toMergedResultPayload(eventOf('agent.failed', { reason: 42 }));
    expect(merged.status).toBe('failed');
    expect(merged.reason).toBeUndefined();
  });
});
