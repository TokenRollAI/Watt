import { WATT_HMAC } from './hmac-constants.ts';

/**
 * webhook HMAC-SHA256 验签纯逻辑（Proto §2.1）——用 WebCrypto，零依赖不造轮子。
 *
 * 契约（Proto/Architecture 未规定验签细节，本轮实现自由，逐条声明于 PROGRESS）：
 *   - 算法：HMAC-SHA256，over bodyRaw 的字节级原文（§2.1 L217-219：验签依赖字节级原文）。
 *   - 签名 header 值格式："sha256=<hex>"（小写十六进制摘要）。
 *   - 比较：常量时间（先判等长，再逐字节异或聚合，避免长度/内容短路的时序侧信道）。
 *
 * body 以 string（utf8）或 Uint8Array（已从 base64 解回的字节）传入，
 * 保证对二进制 body 亦字节精确（adapter 对 encoding='base64' 先解码再传入）。
 */

export type BodyBytes = string | Uint8Array;

function toBytes(body: BodyBytes): Uint8Array {
  return typeof body === 'string' ? new TextEncoder().encode(body) : body;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * 解析小写十六进制字符串为字节；非法（奇数长度 / 非 hex 字符）返回 null。
 * 用于把 header 里的 hex 摘要转回字节做常量时间比较。
 */
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    // parseInt 对非 hex 前缀返回 NaN；对含非 hex 字符的双字符段亦可能返回 NaN 或部分解析，
    // 故显式校验字符集，杜绝 "a z" 之类被 parseInt 宽松吞掉。
    if (Number.isNaN(byte) || !/^[0-9a-f]{2}$/.test(hex.slice(i * 2, i * 2 + 2))) {
      return null;
    }
    out[i] = byte;
  }
  return out;
}

/** HMAC-SHA256(secret, body) 的原始摘要字节。 */
async function hmacBytes(secret: string, body: BodyBytes): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, toBytes(body));
  return new Uint8Array(sig);
}

/** 计算签名 header 值 "sha256=<hex>"。 */
export async function computeSignature(secret: string, body: BodyBytes): Promise<string> {
  return `${WATT_HMAC.prefix}${toHex(await hmacBytes(secret, body))}`;
}

/**
 * 常量时间字节比较：长度不等直接 false（长度非机密），
 * 等长时逐字节异或累加，全程遍历不提前返回，避免内容时序泄漏。
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i < a.length===b.length 已保证索引在界内。
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/**
 * 验签：解析 header 值（须 "sha256=<hex>"），对 body 重算 HMAC，常量时间比较。
 * header 缺失前缀 / hex 非法 / 长度不匹配 / 内容不符 → 一律 false。
 */
export async function verifySignature(
  secret: string,
  body: BodyBytes,
  headerValue: string,
): Promise<boolean> {
  if (!headerValue.startsWith(WATT_HMAC.prefix)) {
    return false;
  }
  const provided = hexToBytes(headerValue.slice(WATT_HMAC.prefix.length));
  if (provided === null) {
    return false;
  }
  const expected = await hmacBytes(secret, body);
  return timingSafeEqual(provided, expected);
}
