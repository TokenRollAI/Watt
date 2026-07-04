/**
 * 飞书事件订阅加密/验签纯逻辑（Web Crypto，宿主无关）。
 *
 * 官方契约（open.feishu.cn 事件订阅 § 加密配置 / § 接收事件）：
 *  - 验签：`X-Lark-Signature` = hex( SHA-256( timestamp + nonce + encryptKey + body ) )，
 *    **纯 SHA-256（非 HMAC）**，四段按字节直接拼接无分隔符，body 为字节精确原始请求体。
 *  - 解密：加密推送时 body 为 `{"encrypt":"<base64>"}`；base64 解码后前 16 字节为 IV，其余为密文；
 *    key = SHA-256(encryptKey)（32 字节），算法 AES-256-CBC，PKCS#7 填充（Web Crypto 自动去填充）。
 *
 * 全部走 Web Crypto（`crypto.subtle`）——workerd 与 Node 20+ 同源，plugin 独立发行零 Node-only 依赖。
 */

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** base64 → Uint8Array（标准 base64；飞书 encrypt 为标准 base64）。 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 常量时间比较两个等长 hex 字符串（避免验签时序侧信道）。 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 计算飞书事件签名 = hex(SHA-256(timestamp + nonce + encryptKey + body))。
 * body 为字节精确的原始请求体字符串（不得重序列化）。
 */
export async function computeFeishuSignature(
  timestamp: string,
  nonce: string,
  encryptKey: string,
  body: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    enc.encode(`${timestamp}${nonce}${encryptKey}${body}`),
  );
  return toHex(digest);
}

/**
 * 验签：计算签名与 `X-Lark-Signature` 常量时间比对。encryptKey 缺失时无从验签（返回 false 由调用方决定）。
 */
export async function verifyFeishuSignature(
  input: { timestamp: string; nonce: string; body: string; signature: string },
  encryptKey: string,
): Promise<boolean> {
  const expected = await computeFeishuSignature(
    input.timestamp,
    input.nonce,
    encryptKey,
    input.body,
  );
  return constantTimeEqual(expected, input.signature);
}

/**
 * 解密飞书加密推送：`encrypt`（base64）→ 明文 JSON 字符串。
 * key = SHA-256(encryptKey)；iv = 密文前 16 字节；AES-256-CBC + PKCS#7（Web Crypto 自动去填充）。
 * 解密失败（密钥错/密文损坏/UTF-8 非法）→ 抛错（调用方转拒收）。
 */
export async function decryptFeishuPayload(encrypt: string, encryptKey: string): Promise<string> {
  const keyBytes = await crypto.subtle.digest('SHA-256', enc.encode(encryptKey));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, [
    'decrypt',
  ]);
  const bytes = base64ToBytes(encrypt);
  if (bytes.length <= 16) throw new Error('feishu decrypt: ciphertext too short');
  const iv = bytes.slice(0, 16);
  const ct = bytes.slice(16);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ct);
  return dec.decode(plain);
}
