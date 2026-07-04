import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  computeFeishuSignature,
  constantTimeEqual,
  decryptFeishuPayload,
  verifyFeishuSignature,
} from '../src/adapter/crypto.ts';

// oracle：用 node:crypto 独立实现飞书官方算法，交叉验证 Web Crypto 实现（避免自证）。
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

describe('computeFeishuSignature — 纯 SHA-256(timestamp+nonce+key+body)', () => {
  it('matches node:crypto oracle', async () => {
    const ts = '1700000000';
    const nonce = 'abc123';
    const key = 'test-encrypt-key-32chars-xxxxxxx';
    const body = '{"encrypt":"zzz"}';
    const got = await computeFeishuSignature(ts, nonce, key, body);
    expect(got).toBe(oracleSignature(ts, nonce, key, body));
  });
});

describe('verifyFeishuSignature', () => {
  const ts = '1700000000';
  const nonce = 'n1';
  const key = 'k'.repeat(32);
  const body = '{"encrypt":"payload"}';

  it('accepts a valid signature', async () => {
    const sig = oracleSignature(ts, nonce, key, body);
    expect(await verifyFeishuSignature({ timestamp: ts, nonce, body, signature: sig }, key)).toBe(
      true,
    );
  });

  it('rejects a tampered body', async () => {
    const sig = oracleSignature(ts, nonce, key, body);
    expect(
      await verifyFeishuSignature(
        { timestamp: ts, nonce, body: `${body} tampered`, signature: sig },
        key,
      ),
    ).toBe(false);
  });

  it('rejects a wrong key', async () => {
    const sig = oracleSignature(ts, nonce, key, body);
    expect(
      await verifyFeishuSignature({ timestamp: ts, nonce, body, signature: sig }, 'wrong-key'),
    ).toBe(false);
  });
});

describe('decryptFeishuPayload — AES-256-CBC, key=sha256(encryptKey), iv=前16字节', () => {
  it('roundtrips an encrypted feishu payload (oracle-produced ciphertext)', async () => {
    const key = 'my-feishu-encrypt-key';
    const plain = JSON.stringify({ type: 'url_verification', challenge: 'ch-123', token: 'tok' });
    const encrypt = oracleEncrypt(plain, key);
    const got = await decryptFeishuPayload(encrypt, key);
    expect(got).toBe(plain);
  });

  it('roundtrips a multi-block (>16 byte) event payload', async () => {
    const key = 'k2';
    const plain = JSON.stringify({
      header: { event_id: 'ev-1', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
      event: { message: { chat_id: 'oc_x', content: '{"text":"hello world 你好"}' } },
    });
    const encrypt = oracleEncrypt(plain, key);
    expect(await decryptFeishuPayload(encrypt, key)).toBe(plain);
  });

  it('throws on wrong key (padding/utf8 error)', async () => {
    const encrypt = oracleEncrypt('{"a":1}', 'right-key');
    await expect(decryptFeishuPayload(encrypt, 'other-key')).rejects.toThrow();
  });

  it('throws on too-short ciphertext', async () => {
    const short = Buffer.from('short').toString('base64');
    await expect(decryptFeishuPayload(short, 'k')).rejects.toThrow();
  });
});

describe('constantTimeEqual', () => {
  it('true for equal, false for different / different length', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'ab')).toBe(false);
  });
});
