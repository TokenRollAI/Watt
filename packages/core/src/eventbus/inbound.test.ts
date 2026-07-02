import { describe, expect, it } from 'vitest';
import type { RawInbound } from './inbound.ts';
import { type InboundAdapter, processInbound } from './inbound.ts';

/**
 * §2.1 webhook 型接入管线用例矩阵（test-first）。
 *
 * 规范（Proto §2.1 L228-231）：webhook 型接入依次 Verify → Decode → 补齐 → Publish。
 *   Verify 失败 → 拒收（本项聚焦：验签失败即身份不可信 → permission_denied，
 *   不调用 Decode/Publish）。Publish 的 Queue/存储侧不在本项（管线边界止于 Decode 产物）。
 *
 * 管线边界（本实现，注释声明）：processInbound(adapter, rawInbound) →
 *   Verify 通过 → { events: Partial<Event>[] }（Decode 产物，交调用方补齐+Publish）；
 *   Verify 失败 → { error: WattError permission_denied }，Decode 不被调用（副作用可观测）。
 *
 * oracle：断言错误码、Decode 调用次数、产物条数，不复用被测常量。
 */

const rawInbound: RawInbound = {
  headers: { 'x-sig': 'abc' },
  bodyRaw: '{"msg":"hi"}',
  encoding: 'utf8',
};

// ── 可观测副作用的 fake adapter（记录 Verify/Decode 调用）─────────────────
function makeAdapter(opts: {
  verify: boolean;
  decodeOut?: ReturnType<InboundAdapter['Decode']>;
}): InboundAdapter & { verifyCalls: RawInbound[]; decodeCalls: RawInbound[] } {
  const verifyCalls: RawInbound[] = [];
  const decodeCalls: RawInbound[] = [];
  return {
    verifyCalls,
    decodeCalls,
    Verify(req) {
      verifyCalls.push(req);
      return opts.verify;
    },
    Decode(req) {
      decodeCalls.push(req);
      return opts.decodeOut ?? [];
    },
  };
}

// ═══ Verify 失败拒收 ═════════════════════════════════════════════════════

describe('Verify failure rejects inbound (permission_denied, no Decode)', () => {
  it('A1 Verify=false → error permission_denied, retryable=false', () => {
    const adapter = makeAdapter({ verify: false });
    const r = processInbound(adapter, rawInbound);
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.error.code).toBe('permission_denied');
      expect(r.error.retryable).toBe(false);
    }
  });

  it('A2 Verify=false → Decode 未被调用（拒收即短路）', () => {
    const adapter = makeAdapter({ verify: false });
    processInbound(adapter, rawInbound);
    expect(adapter.verifyCalls.length).toBe(1);
    expect(adapter.decodeCalls.length).toBe(0);
  });
});

// ═══ Verify 通过 → Decode 产物 ═══════════════════════════════════════════

describe('Verify pass → Decode produces Partial<Event>[]', () => {
  it('B1 Verify=true → 返回 Decode 的事件数组', () => {
    const adapter = makeAdapter({
      verify: true,
      decodeOut: [
        { type: 'im.message', session: 'feishu:chat:oc_x', payload: { text: 'hi' } },
        { type: 'im.mention', session: 'feishu:chat:oc_x', payload: {} },
      ],
    });
    const r = processInbound(adapter, rawInbound);
    expect('events' in r).toBe(true);
    if ('events' in r) {
      expect(r.events.length).toBe(2);
      expect(r.events[0]?.type).toBe('im.message');
    }
    expect(adapter.verifyCalls.length).toBe(1);
    expect(adapter.decodeCalls.length).toBe(1);
  });

  it('B2 Verify=true 但 Decode 空数组 → events=[]（合法，无事件产出）', () => {
    const adapter = makeAdapter({ verify: true, decodeOut: [] });
    const r = processInbound(adapter, rawInbound);
    expect('events' in r).toBe(true);
    if ('events' in r) expect(r.events.length).toBe(0);
  });

  it('B3 rawInbound 原样透传给 Verify 与 Decode（bodyRaw 字节级不变）', () => {
    const adapter = makeAdapter({ verify: true, decodeOut: [{ type: 'im.message' }] });
    processInbound(adapter, rawInbound);
    expect(adapter.verifyCalls[0]?.bodyRaw).toBe('{"msg":"hi"}');
    expect(adapter.decodeCalls[0]?.bodyRaw).toBe('{"msg":"hi"}');
  });
});
