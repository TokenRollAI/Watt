/**
 * 飞书出站投递（Send，Proto §2.1）——从 gateway event/feishu-sender.ts 迁入本 plugin 包。
 *
 * 迁移背景（P1）：出站凭据（tenant_access_token）与 REST 投递从 gateway 收拢进 plugin，gateway 只经
 *   §11.4 `POST {"tool":"Send"}` 调本 plugin——渠道凭据永不经手平台（Plugin.md 能力边界）。
 *
 * Send = tenant_access_token 换取（app_id+app_secret，POST tenant_access_token/internal）+ 缓存
 *   + encodeFeishuOutbound 拼报文 + 飞书 REST 投递 + SendReceipt/retryable 语义。
 * 缓存：可注入（TokenCache）；worker 默认用 isolate 级内存缓存（token ~2h，冷启动重取可接受——
 *   避免为 plugin 额外 provision KV，见 P1 报告偏离说明）。uuid 幂等：opts.dedupeId → 飞书 create
 *   message 的 uuid 字段（服务端去重，队列重投不重复发）。
 */

import type { OutboundMessage } from './decode.ts';
import { encodeFeishuOutbound } from './encode.ts';

const TOKEN_CACHE_KEY = 'feishu:tenant_access_token';
/** 飞书 tenant_access_token 有效期 ~7200s；缓存 TTL 留 60s 安全边际。 */
const TOKEN_TTL_MARGIN_SEC = 60;

/** SendReceipt（§2.1）——出站投递结果 + retryable 分类。 */
export interface FeishuSendResult {
  ok: boolean;
  channelMessageId?: string;
  error?: string;
  /**
   * §0.2 retryable：网络/token 换取/token 失效 → true（重投有意义）；
   * 飞书业务拒绝（receive_id 非法等）→ false（重投必然同败）。
   */
  retryable?: boolean;
}

/** token 缓存抽象（isolate 内存 / KV / 测试内存 皆可注入）。 */
export interface TokenCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSec: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface FeishuSendConfig {
  appId?: string;
  appSecret?: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  cache: TokenCache;
}

interface TenantTokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

interface SendMessageResponse {
  code?: number;
  msg?: string;
  data?: { message_id?: string };
}

/** 飞书 token 失效类业务码（access token invalid/expired 家族）——作废缓存后重投可自愈。 */
const TOKEN_INVALID_CODES = new Set([99991661, 99991663, 99991665]);

/** isolate 级内存 token 缓存（带过期戳）——plugin worker 默认缓存实现。 */
export function memoryTokenCache(now: () => number = Date.now): TokenCache {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key) {
      const hit = store.get(key);
      if (hit === undefined) return null;
      if (hit.expiresAt <= now()) {
        store.delete(key);
        return null;
      }
      return hit.value;
    },
    async put(key, value, ttlSec) {
      store.set(key, { value, expiresAt: now() + ttlSec * 1000 });
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

async function getTenantToken(cfg: FeishuSendConfig): Promise<string> {
  const cached = await cfg.cache.get(TOKEN_CACHE_KEY);
  if (cached) return cached;
  if (!cfg.appId || !cfg.appSecret) {
    throw new Error('FEISHU_APP_ID / FEISHU_APP_SECRET not configured');
  }
  const res = await cfg.fetchImpl(`${cfg.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
  });
  const body = (await res.json()) as TenantTokenResponse;
  if (body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`tenant_access_token failed: code=${body.code} msg=${body.msg ?? 'unknown'}`);
  }
  const ttl = (body.expire ?? 7200) - TOKEN_TTL_MARGIN_SEC;
  await cfg.cache.put(TOKEN_CACHE_KEY, body.tenant_access_token, ttl > 0 ? ttl : 60);
  return body.tenant_access_token;
}

/**
 * 投递一条出站消息到飞书 REST（Encode 内化）。opts.dedupeId → uuid 幂等键。
 * 失败按 retryable 分类；token 失效家族先作废缓存再报 retryable。
 */
export async function sendFeishuMessage(
  cfg: FeishuSendConfig,
  message: OutboundMessage,
  opts: { dedupeId?: string } = {},
): Promise<FeishuSendResult> {
  try {
    const token = await getTenantToken(cfg);
    const payload = encodeFeishuOutbound(message);
    const reqBody = opts.dedupeId !== undefined ? { ...payload, uuid: opts.dedupeId } : payload;
    const res = await cfg.fetchImpl(
      `${cfg.baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(reqBody),
      },
    );
    const body = (await res.json()) as SendMessageResponse;
    if (body.code !== 0) {
      if (body.code !== undefined && TOKEN_INVALID_CODES.has(body.code)) {
        await cfg.cache.delete(TOKEN_CACHE_KEY).catch(() => {});
        return {
          ok: false,
          retryable: true,
          error: `feishu token invalid: code=${body.code} msg=${body.msg ?? 'unknown'}`,
        };
      }
      return {
        ok: false,
        retryable: false,
        error: `feishu send failed: code=${body.code} msg=${body.msg ?? 'unknown'}`,
      };
    }
    return { ok: true, channelMessageId: body.data?.message_id };
  } catch (err) {
    // 网络抖动 / 飞书 5xx / token 换取失败：瞬时故障 → 可重试。
    return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
  }
}
