import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractChallenge, verifyAndExtract } from '../src/adapter/verify.ts';

function oracleSignature(ts: string, nonce: string, key: string, body: string): string {
  return createHash('sha256').update(`${ts}${nonce}${key}${body}`).digest('hex');
}
function oracleEncrypt(plaintext: string, key: string): string {
  const keyBytes = createHash('sha256').update(key).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', keyBytes, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ct]).toString('base64');
}

describe('verifyAndExtract — 加密模式（验签 + 解密）', () => {
  const key = 'encrypt-key-abc';
  const inner = {
    header: { event_id: 'ev-1', event_type: 'im.message.receive_v1' },
    event: { message: { chat_id: 'oc_1' } },
  };

  function encryptedInbound(): { headers: Record<string, string>; body: string } {
    const encrypt = oracleEncrypt(JSON.stringify(inner), key);
    const body = JSON.stringify({ encrypt });
    const ts = '1700000000';
    const nonce = 'nonce-1';
    return {
      headers: {
        'x-lark-signature': oracleSignature(ts, nonce, key, body),
        'x-lark-request-timestamp': ts,
        'x-lark-request-nonce': nonce,
      },
      body,
    };
  }

  it('verifies signature then decrypts to the inner envelope', async () => {
    const res = await verifyAndExtract(encryptedInbound(), { encryptKey: key });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payload).toEqual(inner);
  });

  it('rejects when signature mismatches', async () => {
    const raw = encryptedInbound();
    raw.headers['x-lark-signature'] = 'deadbeef';
    const res = await verifyAndExtract(raw, { encryptKey: key });
    expect(res.ok).toBe(false);
  });

  it('rejects when signature headers missing', async () => {
    const raw = encryptedInbound();
    delete raw.headers['x-lark-signature'];
    const res = await verifyAndExtract(raw, { encryptKey: key });
    expect(res.ok).toBe(false);
  });

  it('rejects when body is not JSON', async () => {
    const res = await verifyAndExtract({ headers: {}, body: 'not-json' }, { encryptKey: key });
    expect(res.ok).toBe(false);
  });
});

describe('verifyAndExtract — 明文模式（verification token 比对）', () => {
  it('accepts plaintext with matching top-level token (url_verification)', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'c1', token: 'vt-1' });
    const res = await verifyAndExtract({ headers: {}, body }, { verificationToken: 'vt-1' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(extractChallenge(res.payload)).toBe('c1');
  });

  it('accepts plaintext event with matching header.token (v2)', async () => {
    const body = JSON.stringify({
      header: { token: 'vt-2', event_type: 'im.message.receive_v1' },
      event: {},
    });
    const res = await verifyAndExtract({ headers: {}, body }, { verificationToken: 'vt-2' });
    expect(res.ok).toBe(true);
  });

  it('rejects plaintext with mismatched token', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'c1', token: 'wrong' });
    const res = await verifyAndExtract({ headers: {}, body }, { verificationToken: 'vt-1' });
    expect(res.ok).toBe(false);
  });

  it('accepts plaintext with no verificationToken configured (no source check)', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'c1' });
    const res = await verifyAndExtract({ headers: {}, body }, {});
    expect(res.ok).toBe(true);
  });
});

describe('extractChallenge', () => {
  it('returns challenge only for url_verification', () => {
    expect(extractChallenge({ type: 'url_verification', challenge: 'x' })).toBe('x');
    expect(extractChallenge({ type: 'event_callback' })).toBeUndefined();
    expect(extractChallenge({ type: 'url_verification' })).toBeUndefined();
  });
});
