import { describe, expect, it } from 'vitest';
import { eventInputSchema, eventSchema } from './types.ts';

/**
 * eventInputSchema 边界测试（§2.3 Publish 入参）。
 * 派生自 eventSchema：omit id/traceId（平台补齐），occurredAt 可选（有则保留、缺则补齐）。
 * 覆盖率 include 不含 types.ts（见 vitest.config.ts）；此测试保 schema 语义正确，不计门禁。
 */

function validInput(over: Record<string, unknown> = {}) {
  return {
    source: { kind: 'system' as const },
    type: 'demo.event',
    payload: { hello: 'world' },
    ...over,
  };
}

describe('eventInputSchema (§2.3 Publish input)', () => {
  it('accepts a minimal valid event input (no id/traceId/occurredAt)', () => {
    const parsed = eventInputSchema.safeParse(validInput());
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty object (missing required source/type/payload)', () => {
    const parsed = eventInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('rejects a malformed source.kind', () => {
    const parsed = eventInputSchema.safeParse(validInput({ source: { kind: 'nope' } }));
    expect(parsed.success).toBe(false);
  });

  it('treats occurredAt as optional but accepts it when provided (retain-if-present)', () => {
    const without = eventInputSchema.safeParse(validInput());
    expect(without.success).toBe(true);
    const withTs = eventInputSchema.safeParse(validInput({ occurredAt: '2026-01-01T00:00:00Z' }));
    expect(withTs.success).toBe(true);
    if (withTs.success) expect(withTs.data.occurredAt).toBe('2026-01-01T00:00:00Z');
  });

  it('preserves optional carriers (principal, channelUser, dedupeKey, session, raw)', () => {
    const parsed = eventInputSchema.safeParse(
      validInput({
        principal: 'user:alice',
        channelUser: { channel: 'feishu', userId: 'ou_x' },
        dedupeKey: 'k-1',
        session: 's-1',
        raw: { original: true },
        source: { kind: 'webhook', channel: 'inbound-hook', ref: 'ep-1' },
      }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.principal).toBe('user:alice');
      expect(parsed.data.dedupeKey).toBe('k-1');
    }
  });

  it('does not require the platform-filled fields but is a strict subset of eventSchema', () => {
    // 补齐 id/traceId/occurredAt 后应满足完整 eventSchema（保证 Publish 补齐是安全的）。
    const input = validInput();
    const full = eventSchema.safeParse({
      ...input,
      id: 'evt-1',
      traceId: 'tr-1',
      occurredAt: '2026-01-01T00:00:00Z',
    });
    expect(full.success).toBe(true);
  });
});
