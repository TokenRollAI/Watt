import { describe, expect, it } from 'vitest';
import { CODE_TO_HTTP, httpStatusFor, WATT_ERROR_CODES, wattError } from './index.ts';

describe('WattError codes', () => {
  it('exposes exactly the 7 Proto §0.2 codes', () => {
    expect([...WATT_ERROR_CODES]).toEqual([
      'not_found',
      'permission_denied',
      'invalid_argument',
      'conflict',
      'unavailable',
      'rate_limited',
      'internal',
    ]);
  });

  it('maps every code to its normative HTTP status', () => {
    expect(CODE_TO_HTTP).toEqual({
      not_found: 404,
      permission_denied: 403,
      invalid_argument: 400,
      conflict: 409,
      rate_limited: 429,
      unavailable: 503,
      internal: 500,
    });
    for (const code of WATT_ERROR_CODES) {
      expect(httpStatusFor(code)).toBe(CODE_TO_HTTP[code]);
    }
  });
});

describe('wattError()', () => {
  // Oracle 来自 Proto §0.2 原文（retryable=true 仅允许 rate_limited/unavailable/internal），
  // 硬编码期望表，不 import 被测常量以避免恒真自引用。
  const RETRYABLE_DEFAULT: Record<string, boolean> = {
    not_found: false,
    permission_denied: false,
    invalid_argument: false,
    conflict: false,
    unavailable: true,
    rate_limited: true,
    internal: true,
  };

  it('defaults retryable from the Proto §0.2 rule (hard-coded oracle)', () => {
    for (const code of WATT_ERROR_CODES) {
      const err = wattError(code, 'msg');
      expect(err.retryable).toBe(RETRYABLE_DEFAULT[code]);
    }
  });

  it('never allows retryable=true on non-retryable codes', () => {
    expect(wattError('invalid_argument', 'x', true).retryable).toBe(false);
    expect(wattError('not_found', 'x', true).retryable).toBe(false);
  });

  it('allows retryable=true on retryable codes and can force false', () => {
    expect(wattError('rate_limited', 'x', true).retryable).toBe(true);
    expect(wattError('unavailable', 'x', false).retryable).toBe(false);
  });

  it('produces a JSON-serialisable bare WattError (no envelope)', () => {
    const err = wattError('internal', 'boom');
    expect(JSON.parse(JSON.stringify(err))).toEqual({
      code: 'internal',
      message: 'boom',
      retryable: true,
    });
  });
});
