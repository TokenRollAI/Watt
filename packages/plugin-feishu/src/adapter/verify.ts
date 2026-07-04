/**
 * 飞书自持回调的 Verify + 明文提取（Proto §2.1 自持回调型）。
 *
 * 两模式（部署侧择一，`~help` 注明推荐加密）：
 *  - 配 `encryptKey`：验签（`X-Lark-Signature` vs sha256(timestamp+nonce+encryptKey+body)）→ 解密
 *    `{"encrypt":...}` → 明文 JSON。验签失败/解密失败 → 拒收（unauthorized）。
 *  - 未配 `encryptKey`：明文推送，`body` 即明文 JSON；若配 `verificationToken` 则比对 body.token
 *    防伪造来源（明文模式无签名可验，token 比对是唯一来源校验）。
 *
 * 纯逻辑：headers 由宿主小写化后传入；body 为字节精确原始体。返回提取出的飞书事件信封
 *   （`{header,event}` 或 url_verification `{type,challenge,token}`）或明确拒收原因。
 */

import { decryptFeishuPayload, verifyFeishuSignature } from './crypto.ts';

/** 宿主传入的原始入站（headers 已小写化）。 */
export interface RawInbound {
  headers: Record<string, string>;
  body: string;
}

/** plugin 部署侧渠道凭据（Worker secrets 注入）。 */
export interface FeishuVerifyConfig {
  /** 事件订阅加密密钥（配置后走验签+解密；推荐）。 */
  encryptKey?: string;
  /** 明文模式来源校验 token（未配 encryptKey 时比对 body.token）。 */
  verificationToken?: string;
}

export type VerifyResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string };

function safeJsonParse(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 验签（若加密）+ 提取明文飞书信封。headers key 须小写（`x-lark-signature` 等）。
 * 未通过任一校验 → { ok:false }（宿主转 401/拒收，不 Publish）。
 */
export async function verifyAndExtract(
  raw: RawInbound,
  config: FeishuVerifyConfig,
): Promise<VerifyResult> {
  const outer = safeJsonParse(raw.body);
  if (outer === null) return { ok: false, reason: 'body is not JSON' };

  // 加密模式：验签 + 解密。
  if (config.encryptKey !== undefined && config.encryptKey.length > 0) {
    const signature = raw.headers['x-lark-signature'];
    const timestamp = raw.headers['x-lark-request-timestamp'];
    const nonce = raw.headers['x-lark-request-nonce'];
    if (
      typeof signature !== 'string' ||
      typeof timestamp !== 'string' ||
      typeof nonce !== 'string'
    ) {
      return { ok: false, reason: 'missing signature headers' };
    }
    const valid = await verifyFeishuSignature(
      { timestamp, nonce, body: raw.body, signature },
      config.encryptKey,
    );
    if (!valid) return { ok: false, reason: 'signature mismatch' };

    const encrypt = outer.encrypt;
    if (typeof encrypt !== 'string') {
      return { ok: false, reason: 'encrypted mode but no encrypt field' };
    }
    let plainStr: string;
    try {
      plainStr = await decryptFeishuPayload(encrypt, config.encryptKey);
    } catch (err) {
      return { ok: false, reason: `decrypt failed: ${err instanceof Error ? err.message : err}` };
    }
    const inner = safeJsonParse(plainStr);
    if (inner === null) return { ok: false, reason: 'decrypted payload is not JSON' };
    return { ok: true, payload: inner };
  }

  // 明文模式：无签名可验；若配 verificationToken 则比对来源。
  if (config.verificationToken !== undefined && config.verificationToken.length > 0) {
    // token 位置：url_verification 握手在顶层 token；事件推送在 header.token（v2）。
    const topToken = typeof outer.token === 'string' ? outer.token : undefined;
    const header =
      typeof outer.header === 'object' && outer.header !== null ? outer.header : undefined;
    const headerToken =
      header && typeof (header as { token?: unknown }).token === 'string'
        ? (header as { token: string }).token
        : undefined;
    const token = topToken ?? headerToken;
    if (token !== config.verificationToken) {
      return { ok: false, reason: 'verification token mismatch' };
    }
  }
  return { ok: true, payload: outer };
}

/**
 * url_verification 握手检测：飞书配置回调 URL 时先发 `{type:'url_verification',challenge,token}`，
 * 需在 1s 内原样返回 `{challenge}`。返回 challenge 字符串或 undefined（非握手）。
 */
export function extractChallenge(payload: Record<string, unknown>): string | undefined {
  if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
    return payload.challenge;
  }
  return undefined;
}
