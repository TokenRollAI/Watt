import { describe, expect, it } from 'vitest';
import { computeSignature, timingSafeEqual, verifySignature } from './hmac.ts';

/**
 * webhook HMAC-SHA256 验签纯逻辑用例（test-first）。
 *
 * 契约（本轮实现自由处，Proto 未规定——见实现决策）：
 *   - 签名算法 HMAC-SHA256，over bodyRaw 字节级原文。
 *   - header 值格式 "sha256=<hex>"（小写十六进制）。
 *   - 常量时间比较（长度先判 + 逐字节异或聚合）。
 *
 * oracle：HMAC 期望值用 Node crypto 独立计算（不复用被测函数产物）。
 */

// 用 Node crypto 独立算 oracle，避免自证。
import { createHmac } from 'node:crypto';

const SECRET = 'topsecret';
const BODY = '{"hello":"world"}';

function oracleHex(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('computeSignature', () => {
  it('produces sha256=<hex> matching an independent HMAC-SHA256 oracle', async () => {
    const sig = await computeSignature(SECRET, BODY);
    expect(sig).toBe(`sha256=${oracleHex(SECRET, BODY)}`);
  });

  it('is deterministic for the same secret/body', async () => {
    expect(await computeSignature(SECRET, BODY)).toBe(await computeSignature(SECRET, BODY));
  });

  it('differs when the secret differs', async () => {
    expect(await computeSignature('other', BODY)).not.toBe(await computeSignature(SECRET, BODY));
  });

  it('handles empty body', async () => {
    expect(await computeSignature(SECRET, '')).toBe(`sha256=${oracleHex(SECRET, '')}`);
  });

  it('accepts Uint8Array body (base64-decoded bytes) byte-exactly', async () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x10, 0x7f]);
    const oracle = createHmac('sha256', SECRET).update(Buffer.from(bytes)).digest('hex');
    expect(await computeSignature(SECRET, bytes)).toBe(`sha256=${oracle}`);
  });
});

describe('verifySignature', () => {
  it('accepts a correct signature', async () => {
    const header = `sha256=${oracleHex(SECRET, BODY)}`;
    expect(await verifySignature(SECRET, BODY, header)).toBe(true);
  });

  it('rejects a wrong signature (same length, different bytes)', async () => {
    // 用另一个 secret 的签名——长度相同、内容不同，逼常量时间比较走到逐字节聚合。
    const header = `sha256=${oracleHex('other', BODY)}`;
    expect(await verifySignature(SECRET, BODY, header)).toBe(false);
  });

  it('rejects a signature over a tampered body', async () => {
    const header = `sha256=${oracleHex(SECRET, BODY)}`;
    expect(await verifySignature(SECRET, `${BODY} `, header)).toBe(false);
  });

  it('rejects when the sha256= prefix is missing', async () => {
    expect(await verifySignature(SECRET, BODY, oracleHex(SECRET, BODY))).toBe(false);
  });

  it('rejects a malformed hex (odd length / non-hex chars)', async () => {
    expect(await verifySignature(SECRET, BODY, 'sha256=zz')).toBe(false);
    expect(await verifySignature(SECRET, BODY, 'sha256=abc')).toBe(false);
  });

  it('rejects an empty header value', async () => {
    expect(await verifySignature(SECRET, BODY, '')).toBe(false);
  });

  it('rejects a length-mismatched (truncated) hex digest', async () => {
    const full = oracleHex(SECRET, BODY);
    expect(await verifySignature(SECRET, BODY, `sha256=${full.slice(0, -2)}`)).toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('returns true for identical byte arrays', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it('returns false for same-length arrays differing in one byte', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 9, 3]))).toBe(false);
  });

  it('returns false for different-length arrays', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('returns true for two empty arrays', () => {
    expect(timingSafeEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true);
  });
});
