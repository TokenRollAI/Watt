import { WATT_ERROR_CODES } from '@watt/shared';
import { describe, expect, it } from 'vitest';
import type { Event } from '../types.ts';
import { resolveInstanceKey } from './instance-key.ts';
import type { SubscriptionSink } from './types.ts';

/**
 * §2.3 instanceBy 三态路由用例矩阵（test-first）。
 *
 * 规范（Proto §2.3 L282 注释 / §3.1 L332-335）：
 *   'session'   → 同一 session 路由到同一 Agent 实例（key = definition + event.session）；
 *   'event'     → 一事一实例（key 每事件独立，用 event.id 参与）；
 *   'singleton' → 全局唯一（key 只由 definition 决定）。
 *
 * 契约偏离（doc-gap）：Proto 未定义 instanceBy='session' 但 event.session 缺失的行为——
 *   本实现返回显式 WattError(invalid_argument)，不静默 fallback（见 instance-key.ts 注释）。
 *
 * oracle：断言 key 的等价/相异关系与错误码，不复用被测常量。
 */

function ev(id: string, session?: string): Event {
  return {
    id,
    source: { kind: 'im', channel: 'feishu' },
    type: 'im.message',
    session,
    payload: {},
    occurredAt: '2026-07-03T00:00:00Z',
    traceId: 'tr-1',
  };
}
function agentSink(instanceBy: 'session' | 'event' | 'singleton'): SubscriptionSink {
  return { kind: 'agent', definition: 'recorder', instanceBy };
}

function ok(r: ReturnType<typeof resolveInstanceKey>): string {
  if (!('key' in r)) throw new Error(`expected key, got error: ${JSON.stringify(r)}`);
  return r.key;
}

// ═══ singleton ═══════════════════════════════════════════════════════════

describe('instanceBy singleton (key 只由 definition 决定)', () => {
  it('A1 同 definition 不同事件/session → 同一 key', () => {
    const k1 = ok(resolveInstanceKey(agentSink('singleton'), ev('e-1', 's-1')));
    const k2 = ok(resolveInstanceKey(agentSink('singleton'), ev('e-2', 's-2')));
    expect(k1).toBe(k2);
  });
  it('A2 不同 definition → 不同 key', () => {
    const k1 = ok(resolveInstanceKey(agentSink('singleton'), ev('e-1')));
    const k2 = ok(
      resolveInstanceKey(
        { kind: 'agent', definition: 'other', instanceBy: 'singleton' },
        ev('e-1'),
      ),
    );
    expect(k1).not.toBe(k2);
  });
});

// ═══ event ═══════════════════════════════════════════════════════════════

describe('instanceBy event (一事一实例，key 用 event.id 参与)', () => {
  it('B1 不同事件 → 不同 key', () => {
    const k1 = ok(resolveInstanceKey(agentSink('event'), ev('e-1', 's-1')));
    const k2 = ok(resolveInstanceKey(agentSink('event'), ev('e-2', 's-1')));
    expect(k1).not.toBe(k2);
  });
  it('B2 同一事件（同 event.id）→ 同一 key（幂等）', () => {
    const k1 = ok(resolveInstanceKey(agentSink('event'), ev('e-1')));
    const k2 = ok(resolveInstanceKey(agentSink('event'), ev('e-1')));
    expect(k1).toBe(k2);
  });
  it('B3 event 态不依赖 session（session 缺失也不报错）', () => {
    const r = resolveInstanceKey(agentSink('event'), ev('e-1'));
    expect('key' in r).toBe(true);
  });
});

// ═══ session ═════════════════════════════════════════════════════════════

describe('instanceBy session (同一 session 同一实例)', () => {
  it('C1 同 session 不同事件 → 同一 key', () => {
    const k1 = ok(resolveInstanceKey(agentSink('session'), ev('e-1', 'feishu:chat:oc_x')));
    const k2 = ok(resolveInstanceKey(agentSink('session'), ev('e-2', 'feishu:chat:oc_x')));
    expect(k1).toBe(k2);
  });
  it('C2 不同 session → 不同 key', () => {
    const k1 = ok(resolveInstanceKey(agentSink('session'), ev('e-1', 'feishu:chat:oc_x')));
    const k2 = ok(resolveInstanceKey(agentSink('session'), ev('e-2', 'feishu:chat:oc_y')));
    expect(k1).not.toBe(k2);
  });
  it('C3 同 session 不同 definition → 不同 key', () => {
    const k1 = ok(resolveInstanceKey(agentSink('session'), ev('e-1', 'feishu:chat:oc_x')));
    const k2 = ok(
      resolveInstanceKey(
        { kind: 'agent', definition: 'other', instanceBy: 'session' },
        ev('e-1', 'feishu:chat:oc_x'),
      ),
    );
    expect(k1).not.toBe(k2);
  });
  it('C4 session 态但 event.session 缺失 → 显式 WattError(invalid_argument)，不静默 fallback', () => {
    const r = resolveInstanceKey(agentSink('session'), ev('e-1'));
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.error.code).toBe('invalid_argument');
      expect(r.error.retryable).toBe(false);
      // 断言使用的是规范 7 码集合之一
      expect([...WATT_ERROR_CODES]).toContain(r.error.code);
    }
  });
});

// ═══ 非 agent sink（task/webhook 无实例概念）════════════════════════════

describe('non-agent sink has no instance key', () => {
  it('E1 task sink → invalid_argument（无 instanceBy 概念）', () => {
    const r = resolveInstanceKey({ kind: 'task', workflow: 'wf-1' }, ev('e-1'));
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error.code).toBe('invalid_argument');
  });
  it('E2 webhook sink → invalid_argument', () => {
    const r = resolveInstanceKey({ kind: 'webhook', url: 'https://x' }, ev('e-1'));
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error.code).toBe('invalid_argument');
  });
});
