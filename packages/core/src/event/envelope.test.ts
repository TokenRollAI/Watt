import { describe, expect, it } from 'vitest';
import type { EventInput } from '../types.ts';
import { EVENT_MAX_BYTES, eventByteSize, normalizeEvent, validateEventSize } from './envelope.ts';

/**
 * Event 信封纯逻辑单测（§1 / §2.3）。
 * oracle 硬编码：128 KB = 131072 字节写死在断言里，不 import 被测常量做期望。
 */

const HARD_MAX = 131072; // 128 * 1024，Proto §1「≤128 KB」的字节数（硬编码 oracle）

function baseInput(overrides: Partial<EventInput> = {}): EventInput {
  return {
    source: { kind: 'im', channel: 'feishu' },
    type: 'im.message',
    payload: { text: 'hi' },
    ...overrides,
  };
}

describe('validateEventSize (§1 128KB)', () => {
  it('constant matches the hard-coded 128KB byte count', () => {
    expect(EVENT_MAX_BYTES).toBe(HARD_MAX);
  });

  it('L1 rejects event whose serialized size exceeds 128KB → invalid_argument', () => {
    // 构造刚好超界：一个大字符串 payload。
    const big = 'x'.repeat(HARD_MAX); // 序列化后必然 > 128KB（加上信封字段与引号）
    const evt = {
      ...baseInput({ payload: big }),
      id: 'e1',
      occurredAt: '2026-07-03T00:00:00Z',
      traceId: 'tr-1',
    };
    expect(eventByteSize(evt)).toBeGreaterThan(HARD_MAX);
    const err = validateEventSize(evt);
    expect(err).not.toBeNull();
    expect(err?.code).toBe('invalid_argument');
    expect(err?.retryable).toBe(false);
  });

  it('L2 accepts event exactly at the 128KB boundary', () => {
    // 先造一个骨架，测其字节数，用 padding 精确填到 == HARD_MAX。
    const skeleton = {
      ...baseInput({ payload: '' }),
      id: 'e1',
      occurredAt: '2026-07-03T00:00:00Z',
      traceId: 'tr-1',
    };
    const skeletonBytes = eventByteSize(skeleton);
    const pad = HARD_MAX - skeletonBytes; // 需要补的字节数（payload 空串每加 1 字符 +1 字节）
    const evt = { ...skeleton, payload: 'x'.repeat(pad) };
    expect(eventByteSize(evt)).toBe(HARD_MAX);
    expect(validateEventSize(evt)).toBeNull(); // 恰好 128KB 允许（≤）
  });

  it('L2b rejects one byte over the boundary', () => {
    const skeleton = {
      ...baseInput({ payload: '' }),
      id: 'e1',
      occurredAt: '2026-07-03T00:00:00Z',
      traceId: 'tr-1',
    };
    const pad = HARD_MAX - eventByteSize(skeleton) + 1;
    const evt = { ...skeleton, payload: 'x'.repeat(pad) };
    expect(eventByteSize(evt)).toBe(HARD_MAX + 1);
    expect(validateEventSize(evt)?.code).toBe('invalid_argument');
  });

  it('measures multi-byte UTF-8 by bytes, not chars', () => {
    // 一个中文字符 UTF-8 = 3 字节。断言 eventByteSize 用字节而非字符长度。
    const evt = { ...baseInput({ payload: '汉' }), id: 'e', occurredAt: 't', traceId: 'x' };
    const asString = JSON.stringify(evt);
    expect(eventByteSize(evt)).toBe(new TextEncoder().encode(asString).byteLength);
    expect(eventByteSize(evt)).toBeGreaterThan(asString.length); // 字节 > 字符数（含中文）
  });
});

describe('normalizeEvent (Omit fields platform-filled, §2.3)', () => {
  it('L5 fills id/occurredAt/traceId when absent (id/ts injectable)', () => {
    const out = normalizeEvent(baseInput(), {
      genId: () => 'evt-generated',
      now: () => '2026-07-03T12:00:00.000Z',
      genTraceId: () => 'tr-generated',
    });
    expect(out.id).toBe('evt-generated');
    expect(out.occurredAt).toBe('2026-07-03T12:00:00.000Z');
    expect(out.traceId).toBe('tr-generated');
    // 非 Omit 字段透传
    expect(out.type).toBe('im.message');
    expect(out.source).toEqual({ kind: 'im', channel: 'feishu' });
  });

  it('L5b passes through an existing traceId (link-carried) instead of generating', () => {
    const out = normalizeEvent(baseInput(), {
      genId: () => 'evt-1',
      now: () => 't',
      genTraceId: () => 'tr-fresh',
      traceId: 'tr-inherited', // 链路已有 → 透传
    });
    expect(out.traceId).toBe('tr-inherited');
  });

  it('L6 fills principal via resolver when channelUser present and principal absent', () => {
    const out = normalizeEvent(baseInput({ channelUser: { channel: 'feishu', userId: 'ou_x' } }), {
      genId: () => 'evt-1',
      now: () => 't',
      genTraceId: () => 'tr-1',
      resolvePrincipal: (ch, uid) => {
        expect(ch).toBe('feishu');
        expect(uid).toBe('ou_x');
        return 'user:alice';
      },
    });
    expect(out.principal).toBe('user:alice');
  });

  it('L6b does not overwrite an already-provided principal', () => {
    const out = normalizeEvent(
      baseInput({ principal: 'user:preset', channelUser: { channel: 'feishu', userId: 'ou_x' } }),
      {
        genId: () => 'evt-1',
        now: () => 't',
        genTraceId: () => 'tr-1',
        resolvePrincipal: () => 'user:should-not-be-used',
      },
    );
    expect(out.principal).toBe('user:preset');
  });

  it('L6c leaves principal undefined when no channelUser and no resolver', () => {
    const out = normalizeEvent(baseInput(), {
      genId: () => 'evt-1',
      now: () => 't',
      genTraceId: () => 'tr-1',
    });
    expect(out.principal).toBeUndefined();
  });

  it('L6d does not resolve principal when channelUser present but no resolver provided', () => {
    const out = normalizeEvent(baseInput({ channelUser: { channel: 'feishu', userId: 'ou_x' } }), {
      genId: () => 'evt-1',
      now: () => 't',
      genTraceId: () => 'tr-1',
    });
    expect(out.principal).toBeUndefined();
  });
});
