import { describe, expect, it } from 'vitest';
import { isExpired } from './ttl.ts';

/**
 * TTL 过期判定用例（test-first，Proto §4.2 NamespaceMount.ttl）。
 * 边界含等：now === 到期时刻即视为已过期。
 */

const MOUNTED = '2026-07-03T00:00:00Z';
const mountedMs = Date.parse(MOUNTED);

describe('isExpired', () => {
  it('ttl 缺省 → 永不过期', () => {
    expect(isExpired(MOUNTED, undefined, mountedMs + 1e15)).toBe(false);
  });

  it('到期前未过期', () => {
    // ttl 3600s；挂载后 3599s 未到期。
    expect(isExpired(MOUNTED, 3600, mountedMs + 3599 * 1000)).toBe(false);
  });

  it('到期边界（含等）→ 已过期', () => {
    expect(isExpired(MOUNTED, 3600, mountedMs + 3600 * 1000)).toBe(true);
  });

  it('到期后 → 已过期', () => {
    expect(isExpired(MOUNTED, 3600, mountedMs + 3601 * 1000)).toBe(true);
  });
});
