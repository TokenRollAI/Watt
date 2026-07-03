import { describe, expect, it } from 'vitest';
import {
  agentResultEventName,
  assertEventName,
  sanitizeEventName,
  taskSignalEventName,
} from './event-names.ts';

/**
 * Workflows 事件名净化（Proto §3.4 L446）。
 * oracle：'.'→'-'、非法字符折叠 '-'、空→'x'；assertEventName 校验空/超长/非法；
 *   agentResultEventName / taskSignalEventName 拼接 + 终检。
 */

describe('sanitizeEventName', () => {
  it("'.' → '-'（点分事件名映射）", () => {
    expect(sanitizeEventName('agent.result')).toBe('agent-result');
    expect(sanitizeEventName('a.b.c')).toBe('a-b-c');
  });

  it('非法字符折叠为 -（空格/斜杠/@/冒号）', () => {
    expect(sanitizeEventName('a b/c@d:e')).toBe('a-b-c-d-e');
  });

  it('合法字符集原样保留', () => {
    expect(sanitizeEventName('abc-DEF_123')).toBe('abc-DEF_123');
  });

  it('净化后为空 → 兜底 x', () => {
    expect(sanitizeEventName('')).toBe('x');
    expect(sanitizeEventName('...')).toBe('---'); // 点全变 -，非空
  });

  it('全非法字符净化后仍非空（折叠为等长 -）', () => {
    expect(sanitizeEventName('@@@')).toBe('---');
  });
});

describe('assertEventName', () => {
  it('合法名 → null', () => {
    expect(assertEventName('agent-result-abc')).toBeNull();
  });

  it('长度 100 边界 → null', () => {
    expect(assertEventName('a'.repeat(100))).toBeNull();
  });

  it('空 → invalid_argument', () => {
    expect(assertEventName('')?.code).toBe('invalid_argument');
  });

  it('长度 101 → invalid_argument', () => {
    const e = assertEventName('a'.repeat(101));
    expect(e?.code).toBe('invalid_argument');
    expect(e?.message).toContain('100');
  });

  it('含非法字符（.）→ invalid_argument', () => {
    expect(assertEventName('a.b')?.code).toBe('invalid_argument');
  });
});

describe('agentResultEventName', () => {
  it('归并前缀 agent-result-<cid>', () => {
    expect(agentResultEventName('c123')).toBe('agent-result-c123');
  });

  it('correlationId 含点 → 净化后拼接', () => {
    expect(agentResultEventName('c.1')).toBe('agent-result-c-1');
  });

  it('correlationId 上界 80 → 合法（前缀13+80=93≤100）', () => {
    const cid = 'a'.repeat(80);
    expect(agentResultEventName(cid)).toBe(`agent-result-${cid}`);
  });

  it('超长非法入参 → invalid_argument（兜底面）', () => {
    const r = agentResultEventName('a'.repeat(200));
    expect(typeof r).not.toBe('string');
    if (typeof r !== 'string') expect(r.code).toBe('invalid_argument');
  });
});

describe('taskSignalEventName', () => {
  it('前缀 task-signal-<checkpoint>', () => {
    expect(taskSignalEventName('confirm-release')).toBe('task-signal-confirm-release');
  });

  it('checkpoint 含点 → 净化', () => {
    expect(taskSignalEventName('a.b')).toBe('task-signal-a-b');
  });

  it('超长 checkpoint → invalid_argument', () => {
    const r = taskSignalEventName('a'.repeat(200));
    expect(typeof r).not.toBe('string');
    if (typeof r !== 'string') expect(r.code).toBe('invalid_argument');
  });
});
