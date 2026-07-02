import { describe, expect, it } from 'vitest';
import {
  createDeviceGrant,
  DEVICE_CODE_EXPIRES_IN_SEC,
  DEVICE_CODE_INTERVAL_SEC,
  type DeviceGrant,
  evaluateTokenExchange,
  generateDeviceCode,
  generateUserCode,
  isDeviceGrantExpired,
  normalizeUserCode,
  oauthError,
} from './device-flow.ts';

/** 确定性随机字节：每次返回递增序列，便于断言。 */
function seqRandom(start = 0): (n: number) => Uint8Array {
  let v = start;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (v++ + i) % 256;
    return out;
  };
}

describe('generateUserCode', () => {
  it('produces an 8-char code from the unambiguous alphabet', () => {
    const code = generateUserCode(seqRandom(0));
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  });
  it('is deterministic for a fixed random source', () => {
    expect(generateUserCode(seqRandom(5))).toBe(generateUserCode(seqRandom(5)));
  });
  it('uses crypto by default and yields distinct codes', () => {
    expect(generateUserCode()).not.toBe(generateUserCode());
  });
});

describe('generateDeviceCode', () => {
  it('is URL-safe base64 without padding', () => {
    const dc = generateDeviceCode(seqRandom(0));
    expect(dc).not.toMatch(/[+/=]/);
    expect(dc.length).toBeGreaterThan(20);
  });
  it('uses crypto by default and yields distinct codes', () => {
    expect(generateDeviceCode()).not.toBe(generateDeviceCode());
  });
});

describe('createDeviceGrant', () => {
  it('creates a pending grant with default expiry/interval', () => {
    const { grant, response } = createDeviceGrant({
      verificationUri: 'https://x/device',
      now: () => 1000,
      random: seqRandom(0),
    });
    expect(grant.status).toBe('pending');
    expect(grant.createdAt).toBe(1000);
    expect(grant.expiresAt).toBe(1000 + DEVICE_CODE_EXPIRES_IN_SEC);
    expect(response.expires_in).toBe(DEVICE_CODE_EXPIRES_IN_SEC);
    expect(response.interval).toBe(DEVICE_CODE_INTERVAL_SEC);
    expect(response.verification_uri).toBe('https://x/device');
    expect(response.device_code).toBe(grant.deviceCode);
    expect(response.user_code).toBe(grant.userCode);
  });
  it('honors injected expiry/interval', () => {
    const { grant, response } = createDeviceGrant({
      verificationUri: 'https://x',
      expiresInSec: 60,
      intervalSec: 2,
      now: () => 0,
      random: seqRandom(0),
    });
    expect(grant.expiresAt).toBe(60);
    expect(response.interval).toBe(2);
  });
  it('uses real clock/crypto when not injected', () => {
    const { grant } = createDeviceGrant({ verificationUri: 'https://x' });
    expect(grant.expiresAt - grant.createdAt).toBe(DEVICE_CODE_EXPIRES_IN_SEC);
  });
});

describe('isDeviceGrantExpired', () => {
  const g: DeviceGrant = {
    deviceCode: 'd',
    userCode: 'U',
    status: 'pending',
    createdAt: 0,
    expiresAt: 100,
  };
  it('false before expiry', () => expect(isDeviceGrantExpired(g, 99)).toBe(false));
  it('true at/after expiry', () => {
    expect(isDeviceGrantExpired(g, 100)).toBe(true);
    expect(isDeviceGrantExpired(g, 101)).toBe(true);
  });
});

describe('evaluateTokenExchange', () => {
  const base: DeviceGrant = {
    deviceCode: 'd',
    userCode: 'U',
    status: 'pending',
    createdAt: 0,
    expiresAt: 100,
  };
  it('invalid_grant when grant missing', () => {
    expect(evaluateTokenExchange(undefined, 10)).toEqual({ kind: 'invalid_grant' });
  });
  it('expired when past expiresAt', () => {
    expect(evaluateTokenExchange(base, 100)).toEqual({ kind: 'expired' });
  });
  it('pending when still pending in window', () => {
    expect(evaluateTokenExchange(base, 10)).toEqual({ kind: 'pending' });
  });
  it('pending when approved but principal missing (defensive)', () => {
    expect(evaluateTokenExchange({ ...base, status: 'approved' }, 10)).toEqual({ kind: 'pending' });
  });
  it('approved with principal when approved in window', () => {
    expect(
      evaluateTokenExchange({ ...base, status: 'approved', principal: 'user:djj' }, 10),
    ).toEqual({ kind: 'approved', principal: 'user:djj' });
  });
  it('expired takes precedence over approved (order: expiry checked before status)', () => {
    // approved 且 principal 已设，但 now≥expiresAt → 必须判 expired（§6.5d：过期先于状态）。
    expect(
      evaluateTokenExchange({ ...base, status: 'approved', principal: 'user:djj' }, 100),
    ).toEqual({ kind: 'expired' });
  });
});

describe('normalizeUserCode', () => {
  it('uppercases lowercase input', () => {
    expect(normalizeUserCode('abcd1234')).toBe('ABCD1234');
  });
  it('strips hyphen separators', () => {
    expect(normalizeUserCode('ABCD-1234')).toBe('ABCD1234');
  });
  it('strips whitespace separators and trims', () => {
    expect(normalizeUserCode('  abcd 1234 ')).toBe('ABCD1234');
  });
});

describe('oauthError', () => {
  it('omits description when absent', () => {
    expect(oauthError('authorization_pending')).toEqual({ error: 'authorization_pending' });
  });
  it('includes description when provided', () => {
    expect(oauthError('expired_token', 'the device_code has expired')).toEqual({
      error: 'expired_token',
      error_description: 'the device_code has expired',
    });
  });
});
