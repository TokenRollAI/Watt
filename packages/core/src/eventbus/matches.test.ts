import { describe, expect, it } from 'vitest';
import type { Event } from '../types.ts';
import { matchesSubscription } from './matches.ts';
import type { SubscriptionMatch } from './types.ts';

/**
 * §2.3 订阅匹配用例矩阵（test-first）。
 *
 * 规范（Proto §2.3 L272-283）：
 *   match { type?, sourceKind?, channel?, session? }，全部条件 AND；缺省字段不参与匹配。
 *   type 支持后缀通配 "im.*"；sourceKind ↔ event.source.kind；channel ↔ event.source.channel；
 *   session ↔ event.session。
 *
 * oracle 硬编码 true/false，不复用被测函数产物。
 */

// ── 便捷构造器（测试夹具）────────────────────────────────────────────────
function ev(overrides: Partial<Event> & { type: string }): Event {
  return {
    id: 'e-1',
    source: { kind: 'im', channel: 'feishu' },
    payload: {},
    occurredAt: '2026-07-03T00:00:00Z',
    traceId: 'tr-1',
    ...overrides,
  };
}

// ═══ 空 match：匹配一切 ═══════════════════════════════════════════════════

describe('empty match matches everything (缺省字段不参与匹配)', () => {
  it('A1 空 match{} → 匹配任意事件', () => {
    expect(matchesSubscription(ev({ type: 'im.message' }), {})).toBe(true);
    expect(matchesSubscription(ev({ type: 'cron.fired', source: { kind: 'cron' } }), {})).toBe(
      true,
    );
  });
});

// ═══ type 精确 + 后缀通配 ═════════════════════════════════════════════════

describe('type match: exact + suffix wildcard "im.*"', () => {
  it('B1 精确匹配', () => {
    expect(matchesSubscription(ev({ type: 'im.message' }), { type: 'im.message' })).toBe(true);
  });
  it('B2 精确不匹配', () => {
    expect(matchesSubscription(ev({ type: 'im.action' }), { type: 'im.message' })).toBe(false);
  });
  it('B3 后缀通配 "im.*" 匹配 im.message / im.action', () => {
    expect(matchesSubscription(ev({ type: 'im.message' }), { type: 'im.*' })).toBe(true);
    expect(matchesSubscription(ev({ type: 'im.action' }), { type: 'im.*' })).toBe(true);
  });
  it('B4 后缀通配 "im.*" 不匹配前缀不同的 cron.fired', () => {
    expect(
      matchesSubscription(ev({ type: 'cron.fired', source: { kind: 'cron' } }), { type: 'im.*' }),
    ).toBe(false);
  });
  it('B5 决策锁定："im.*" 不匹配裸 "im" 本身（"im." 前缀含点，"im" 无点不满足）', () => {
    expect(matchesSubscription(ev({ type: 'im' }), { type: 'im.*' })).toBe(false);
  });
  it('B6 决策锁定："im.*" 匹配 "im.message.sub"（后缀通配是前缀 startsWith，含更深层级）', () => {
    expect(matchesSubscription(ev({ type: 'im.message.sub' }), { type: 'im.*' })).toBe(true);
  });
  it('B7 决策锁定：裸 "*" 合法，等价全通配 type', () => {
    expect(matchesSubscription(ev({ type: 'anything.here' }), { type: '*' })).toBe(true);
    expect(matchesSubscription(ev({ type: '' }), { type: '*' })).toBe(true);
  });
});

// ═══ sourceKind / channel ════════════════════════════════════════════════

describe('sourceKind + channel match', () => {
  it('C1 sourceKind 匹配', () => {
    const m: SubscriptionMatch = { sourceKind: 'im' };
    expect(matchesSubscription(ev({ type: 'im.message', source: { kind: 'im' } }), m)).toBe(true);
  });
  it('C2 sourceKind 不匹配', () => {
    const m: SubscriptionMatch = { sourceKind: 'webhook' };
    expect(matchesSubscription(ev({ type: 'im.message', source: { kind: 'im' } }), m)).toBe(false);
  });
  it('C3 channel 匹配 event.source.channel', () => {
    expect(
      matchesSubscription(ev({ type: 'im.message', source: { kind: 'im', channel: 'feishu' } }), {
        channel: 'feishu',
      }),
    ).toBe(true);
  });
  it('C4 channel 不匹配', () => {
    expect(
      matchesSubscription(ev({ type: 'im.message', source: { kind: 'im', channel: 'feishu' } }), {
        channel: 'slack',
      }),
    ).toBe(false);
  });
  it('C5 match.channel 存在而 event 无 channel → 不匹配', () => {
    expect(
      matchesSubscription(ev({ type: 'cron.fired', source: { kind: 'cron' } }), {
        channel: 'feishu',
      }),
    ).toBe(false);
  });
});

// ═══ session ═════════════════════════════════════════════════════════════

describe('session match (Case 3 会话粘性订阅)', () => {
  it('D1 session 匹配', () => {
    expect(
      matchesSubscription(ev({ type: 'im.message', session: 'feishu:chat:oc_x' }), {
        session: 'feishu:chat:oc_x',
      }),
    ).toBe(true);
  });
  it('D2 session 不匹配', () => {
    expect(
      matchesSubscription(ev({ type: 'im.message', session: 'feishu:chat:oc_x' }), {
        session: 'feishu:chat:oc_y',
      }),
    ).toBe(false);
  });
  it('D3 match.session 存在而 event 无 session → 不匹配', () => {
    expect(matchesSubscription(ev({ type: 'im.message' }), { session: 'feishu:chat:oc_x' })).toBe(
      false,
    );
  });
});

// ═══ AND 语义（多条件全满足）═════════════════════════════════════════════

describe('AND semantics: all present conditions must hold', () => {
  const fullMatch: SubscriptionMatch = {
    type: 'im.*',
    sourceKind: 'im',
    channel: 'feishu',
    session: 'feishu:chat:oc_x',
  };
  it('E1 全部条件满足 → 匹配', () => {
    expect(
      matchesSubscription(
        ev({
          type: 'im.message',
          source: { kind: 'im', channel: 'feishu' },
          session: 'feishu:chat:oc_x',
        }),
        fullMatch,
      ),
    ).toBe(true);
  });
  it('E2 仅 session 一项不满足 → 整体不匹配（AND）', () => {
    expect(
      matchesSubscription(
        ev({
          type: 'im.message',
          source: { kind: 'im', channel: 'feishu' },
          session: 'feishu:chat:OTHER',
        }),
        fullMatch,
      ),
    ).toBe(false);
  });
  it('E3 仅 channel 一项不满足 → 整体不匹配（AND）', () => {
    expect(
      matchesSubscription(
        ev({
          type: 'im.message',
          source: { kind: 'im', channel: 'slack' },
          session: 'feishu:chat:oc_x',
        }),
        fullMatch,
      ),
    ).toBe(false);
  });
});
