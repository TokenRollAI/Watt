import { describe, expect, it } from 'vitest';
import type { Event } from '../types.ts';
import { InMemoryCorrelationTable, type Waiter } from './correlation.ts';
import {
  AGENT_EVENT_TYPES,
  type FailedEventDeps,
  routeAgentEvent,
  terminatedFailedEvent,
  timeoutFailedEvent,
} from './routing.ts';
import { agentFailedPayloadSchema } from './types.ts';

/**
 * §3.4 六条路由规则的纯判定 + 超时/终止代发事件构造。
 * oracle：断言 RouteDecision.kind 与 waiter；代发事件的 type/reason/payload 形状（过 zod）。
 */

function resultEvent(correlationId: string | undefined): Event {
  return {
    id: 'e-1',
    source: { kind: 'agent', ref: 'inst-child' },
    type: AGENT_EVENT_TYPES.result,
    payload:
      correlationId === undefined
        ? { instanceId: 'inst-child', output: {} }
        : { correlationId, instanceId: 'inst-child', output: { score: 9 } },
    occurredAt: '2026-07-03T00:00:00Z',
    traceId: 'tr-1',
  };
}

function failedEvent(correlationId: string): Event {
  return {
    id: 'e-2',
    source: { kind: 'agent', ref: 'inst-child' },
    type: AGENT_EVENT_TYPES.failed,
    payload: { correlationId, instanceId: 'inst-child', reason: 'error' },
    occurredAt: '2026-07-03T00:00:00Z',
    traceId: 'tr-1',
  };
}

const waiterA: Waiter = { kind: 'agent', id: 'inst-parent' };

// ═══ 规则 1/2：定向回送 ══════════════════════════════════════════════════

describe('routeAgentEvent — deliver (规则 1/2 定向回送)', () => {
  it('带 correlationId 的 agent.result 命中等待方 → deliver', () => {
    const t = new InMemoryCorrelationTable();
    t.register('c-1', waiterA, 10_000);
    const d = routeAgentEvent(resultEvent('c-1'), t, 0);
    expect(d).toEqual({ kind: 'deliver', waiter: waiterA });
  });

  it('agent.failed 同样定向回送（result 与 failed 归并回等待方）', () => {
    const t = new InMemoryCorrelationTable();
    t.register('c-1', waiterA, 10_000);
    const d = routeAgentEvent(failedEvent('c-1'), t, 0);
    expect(d).toEqual({ kind: 'deliver', waiter: waiterA });
  });

  it('task 等待方也能回送（Task 步骤 waitForEvent）', () => {
    const t = new InMemoryCorrelationTable();
    const taskWaiter: Waiter = { kind: 'task', id: 'task-9' };
    t.register('c-1', taskWaiter, 10_000);
    const d = routeAgentEvent(resultEvent('c-1'), t, 0);
    expect(d).toEqual({ kind: 'deliver', waiter: taskWaiter });
  });
});

// ═══ 规则 5：等待方先消失 ════════════════════════════════════════════════

describe('routeAgentEvent — drop-no-waiter (规则 5)', () => {
  it('correlationId 从未登记（等待方已消失/伪造）→ drop-no-waiter', () => {
    const t = new InMemoryCorrelationTable();
    const d = routeAgentEvent(resultEvent('ghost'), t, 0);
    expect(d).toEqual({ kind: 'drop-no-waiter' });
  });
});

// ═══ 规则 6：结果去重 ════════════════════════════════════════════════════

describe('routeAgentEvent — drop-duplicate (规则 6)', () => {
  it('同 correlationId 首个 deliver，第二个 drop-duplicate', () => {
    const t = new InMemoryCorrelationTable();
    t.register('c-1', waiterA, 10_000);
    expect(routeAgentEvent(resultEvent('c-1'), t, 0)).toEqual({ kind: 'deliver', waiter: waiterA });
    expect(routeAgentEvent(resultEvent('c-1'), t, 0)).toEqual({ kind: 'drop-duplicate' });
  });

  it('规则 3 幂等：超时代发（expire 置 settled）后真实结果晚到 → drop-duplicate', () => {
    const t = new InMemoryCorrelationTable();
    t.register('c-1', waiterA, 1_000);
    expect(t.expire(2_000)).toEqual(['c-1']); // 平台代发 timeout
    const d = routeAgentEvent(resultEvent('c-1'), t, 3_000); // 真实结果晚到
    expect(d).toEqual({ kind: 'drop-duplicate' });
  });
});

// ═══ not-correlated：无 correlationId 走普通订阅 ═════════════════════════

describe('routeAgentEvent — not-correlated', () => {
  it('agent.result 无 correlationId → not-correlated', () => {
    const t = new InMemoryCorrelationTable();
    expect(routeAgentEvent(resultEvent(undefined), t, 0)).toEqual({ kind: 'not-correlated' });
  });

  it('非 agent.result/failed 事件（如 im.message）→ not-correlated', () => {
    const t = new InMemoryCorrelationTable();
    const im: Event = {
      id: 'e-3',
      source: { kind: 'im', channel: 'feishu' },
      type: 'im.message',
      payload: { correlationId: 'c-1' }, // 即便含该字段，也不属此路由
      occurredAt: '2026-07-03T00:00:00Z',
      traceId: 'tr-1',
    };
    expect(routeAgentEvent(im, t, 0)).toEqual({ kind: 'not-correlated' });
  });

  it('payload 非对象（如字符串）→ not-correlated', () => {
    const t = new InMemoryCorrelationTable();
    const ev: Event = { ...resultEvent('c-1'), payload: 'raw-string' };
    expect(routeAgentEvent(ev, t, 0)).toEqual({ kind: 'not-correlated' });
  });

  it('payload 为 null → not-correlated', () => {
    const t = new InMemoryCorrelationTable();
    const ev: Event = { ...resultEvent('c-1'), payload: null };
    expect(routeAgentEvent(ev, t, 0)).toEqual({ kind: 'not-correlated' });
  });

  it('correlationId 为空串 → not-correlated', () => {
    const t = new InMemoryCorrelationTable();
    const ev: Event = { ...resultEvent('c-1'), payload: { correlationId: '', instanceId: 'x' } };
    expect(routeAgentEvent(ev, t, 0)).toEqual({ kind: 'not-correlated' });
  });

  it('correlationId 非字符串（数字）→ not-correlated', () => {
    const t = new InMemoryCorrelationTable();
    const ev: Event = { ...resultEvent('c-1'), payload: { correlationId: 42, instanceId: 'x' } };
    expect(routeAgentEvent(ev, t, 0)).toEqual({ kind: 'not-correlated' });
  });
});

// ═══ 代发事件构造（规则 3 timeout / 规则 4 terminated）══════════════════

describe('timeout/terminated failed event 构造', () => {
  const deps: FailedEventDeps = {
    genId: () => 'gen-id-1',
    nowIso: () => '2026-07-03T01:00:00Z',
    traceId: 'tr-parent',
  };

  it('timeoutFailedEvent 产 reason=timeout 的 agent.failed', () => {
    const ev = timeoutFailedEvent('c-1', 'inst-child', deps);
    expect(ev.type).toBe(AGENT_EVENT_TYPES.failed);
    expect(ev.source.kind).toBe('system');
    expect(ev.id).toBe('gen-id-1');
    expect(ev.occurredAt).toBe('2026-07-03T01:00:00Z');
    expect(ev.traceId).toBe('tr-parent');
    const parsed = agentFailedPayloadSchema.parse(ev.payload);
    expect(parsed).toEqual({ correlationId: 'c-1', instanceId: 'inst-child', reason: 'timeout' });
  });

  it('terminatedFailedEvent 产 reason=terminated 的 agent.failed', () => {
    const ev = terminatedFailedEvent('c-2', 'inst-child', deps);
    const parsed = agentFailedPayloadSchema.parse(ev.payload);
    expect(parsed.reason).toBe('terminated');
    expect(parsed.correlationId).toBe('c-2');
  });
});
