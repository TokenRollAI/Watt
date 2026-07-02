import { describe, expect, it } from 'vitest';
import type { Event, Policy, TokenClaims } from '../types.ts';
import { authorizeOutbound, outboundAccessRequest } from './outbound.ts';

/**
 * §2.3 出站鉴权点用例矩阵（test-first）。
 *
 * 规范（Proto §2.3 L259-262）：EventBus.Publish 对 type="outbound.message" 的事件判定
 *   Check(context, event://<channel>/<target>, 'write')——"Agent 能否向某渠道发消息"在此收敛。
 *
 * 本项两个纯 helper：
 *   outboundAccessRequest(event) → { resource: "event://<channel>/<target>", action: 'write' }
 *     | { error: WattError }（非 outbound.message → null；payload zod 校验失败 → invalid_argument）；
 *   authorizeOutbound(event, authInput) → 组合 outboundAccessRequest + 现有 authorize()。
 *
 * oracle：硬编码 resource/action 字符串与 allow/deny，不复用被测常量。
 */

function outboundEvent(channel: string, target: string): Event {
  return {
    id: 'e-1',
    source: { kind: 'agent', ref: 'inst-1' },
    type: 'outbound.message',
    payload: { channel, target, content: { text: 'hi' } },
    occurredAt: '2026-07-03T00:00:00Z',
    traceId: 'tr-1',
  };
}
function userClaims(sub: string, roles: string[]): TokenClaims {
  return { sub, roles };
}
function policy(p: Omit<Policy, 'id'> & { id?: string }): Policy {
  return { id: p.id ?? 'pol-1', ...p };
}

// ═══ outboundAccessRequest：派生 AccessRequest ═══════════════════════════

describe('outboundAccessRequest derives event:// resource + write', () => {
  it('A1 outbound.message → resource "event://<channel>/<target>", action write', () => {
    const r = outboundAccessRequest(outboundEvent('feishu', 'oc_xxx'));
    expect(r).not.toBeNull();
    if (r !== null && 'request' in r) {
      expect(r.request.resource).toBe('event://feishu/oc_xxx');
      expect(r.request.action).toBe('write');
    }
  });

  it('A2 非 outbound.message → null（不参与出站鉴权）', () => {
    const inbound: Event = { ...outboundEvent('feishu', 'oc_x'), type: 'im.message' };
    expect(outboundAccessRequest(inbound)).toBeNull();
  });

  it('A3 payload 缺 target → invalid_argument（OutboundMessage zod 校验失败）', () => {
    const bad: Event = {
      ...outboundEvent('feishu', 'oc_x'),
      payload: { channel: 'feishu', content: { text: 'hi' } },
    };
    const r = outboundAccessRequest(bad);
    expect(r).not.toBeNull();
    if (r !== null && 'error' in r) {
      expect(r.error.code).toBe('invalid_argument');
      expect(r.error.retryable).toBe(false);
    }
  });

  it('A4 payload 非对象（字符串）→ invalid_argument', () => {
    const bad: Event = { ...outboundEvent('feishu', 'oc_x'), payload: 'not-an-object' };
    const r = outboundAccessRequest(bad);
    if (r !== null && 'error' in r) {
      expect(r.error.code).toBe('invalid_argument');
    } else {
      throw new Error('expected invalid_argument error');
    }
  });
});

// ═══ authorizeOutbound：组合判定（allow / deny 两向）═════════════════════

describe('authorizeOutbound combines derivation + authorize() (§6.4c)', () => {
  const authCommon = { agentDefs: {}, cronJobs: {}, instances: {} };

  it('B1 allow：policy 放行 event://feishu/* write → allow', () => {
    const d = authorizeOutbound(outboundEvent('feishu', 'oc_x'), {
      claims: userClaims('user:alice', ['ceo']),
      policies: [
        policy({
          subject: 'role:ceo',
          resource: 'event://feishu/*',
          actions: ['write'],
          effect: 'allow',
        }),
      ],
      ...authCommon,
    });
    expect(d.allow).toBe(true);
  });

  it('B2 deny：无匹配 policy → 默认拒绝', () => {
    const d = authorizeOutbound(outboundEvent('feishu', 'oc_x'), {
      claims: userClaims('user:alice', []),
      policies: [],
      ...authCommon,
    });
    expect(d.allow).toBe(false);
  });

  it('B3 deny：policy 只放行 read，不含 write → deny（动作不覆盖）', () => {
    const d = authorizeOutbound(outboundEvent('feishu', 'oc_x'), {
      claims: userClaims('user:alice', []),
      policies: [
        policy({
          subject: 'user:alice',
          resource: 'event://feishu/*',
          actions: ['read'],
          effect: 'allow',
        }),
      ],
      ...authCommon,
    });
    expect(d.allow).toBe(false);
  });

  it('B4 deny：目标渠道不匹配（policy 放行 slack，事件发 feishu）→ deny', () => {
    const d = authorizeOutbound(outboundEvent('feishu', 'oc_x'), {
      claims: userClaims('user:alice', []),
      policies: [
        policy({
          subject: 'user:alice',
          resource: 'event://slack/*',
          actions: ['write'],
          effect: 'allow',
        }),
      ],
      ...authCommon,
    });
    expect(d.allow).toBe(false);
  });

  it('B5 非 outbound.message → allow 且无鉴权（出站鉴权不适用，直接放行）', () => {
    const inbound: Event = { ...outboundEvent('feishu', 'oc_x'), type: 'im.message' };
    const d = authorizeOutbound(inbound, {
      claims: userClaims('user:alice', []),
      policies: [],
      ...authCommon,
    });
    expect(d.allow).toBe(true);
  });

  it('B6 payload 校验失败 → deny 且 reason 含 invalid（不放行畸形出站）', () => {
    const bad: Event = {
      ...outboundEvent('feishu', 'oc_x'),
      payload: { channel: 'feishu', content: { text: 'hi' } },
    };
    const d = authorizeOutbound(bad, {
      claims: userClaims('user:alice', []),
      policies: [policy({ subject: '*', resource: '*', actions: ['*'], effect: 'allow' })],
      ...authCommon,
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/invalid|payload/i);
  });
});
