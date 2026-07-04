/**
 * 飞书出站投递（Proto §2.1 push 型 Send 义务的 gateway 侧接线 / R24 出站接线）。
 *
 * 决策（调研 §3 出站选型 ②）：出站发消息是普通 HTTPS（POST /open-apis/im/v1/messages），
 * 不依赖 WS 长连接，故在 gateway consumer 承接（与 CLI WS 入站解耦——入站靠 CLI，出站靠 gateway）。
 * 报文形状（OutboundMessage→飞书 REST body）由 core encodeFeishuOutbound 纯逻辑产出，此处只做
 * token 换取 + 缓存 + HTTP 投递（I/O 接线），可注入 fetch 便于测试。
 *
 * tenant_access_token（§ 出站凭据）：app_id + app_secret 换取（POST tenant_access_token/internal），
 * 缓存于 KV_TENANTS 带 TTL（飞书 token ~2h，缓存留 60s 安全边际）。secrets：FEISHU_APP_ID /
 * FEISHU_APP_SECRET 进 gateway secret 面（deploy-all 检查清单同步，本地 .dev.vars 注入 fake）。
 *
 * ChannelConfig.settings 可覆盖 appId/appSecretRef（未来多租户）——本轮从 env secret 取单租户凭据，
 * settings 只用于确认 kind=feishu（adapter 字段）。
 */

import { encodeFeishuOutbound, type OutboundMessage } from '@watt/core';
import type { Bindings } from '../env.ts';

/** 飞书开放平台基址（缺省国内版；env FEISHU_BASE_URL 可覆盖为国际版 open.larksuite.com）。 */
const DEFAULT_FEISHU_BASE = 'https://open.feishu.cn';

/** KV 缓存键（单租户，多租户时以 appId 区分）。 */
const TOKEN_CACHE_KEY = 'feishu:tenant_access_token';

/** 飞书 tenant_access_token 有效期 ~7200s；缓存 TTL 留 60s 安全边际。 */
const TOKEN_TTL_MARGIN_SEC = 60;

export interface FeishuSendResult {
  ok: boolean;
  /** 飞书返回的 message_id（成功时）。 */
  messageId?: string;
  /** 失败详情（留痕用）。 */
  error?: string;
  /**
   * 失败是否可重试（§0.2 retryable 语义，R27 关门 C2）：网络/token 换取/token 失效 → true
   * （队列重投有意义）；飞书业务拒绝（如 receive_id 非法）→ false（重投必然同败）。
   */
  retryable?: boolean;
}

/** 飞书出站投递抽象（consumer 注入，便于测试 fake fetch）。 */
export interface FeishuSender {
  /**
   * dedupeId：投递幂等键（映射飞书 create message 的 uuid 字段，服务端按 uuid 去重）——
   * 队列 at-least-once 重投时同一事件不产生重复消息（R27 关门 C3）。
   */
  send(message: OutboundMessage, opts?: { dedupeId?: string }): Promise<FeishuSendResult>;
}

interface FeishuSenderConfig {
  appId?: string;
  appSecret?: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  /** token 缓存读写（缺省 KV_TENANTS；测试可注入内存实现）。 */
  cacheGet: (key: string) => Promise<string | null>;
  cachePut: (key: string, value: string, ttlSec: number) => Promise<void>;
  /** token 失效时作废缓存（缺省 KV_TENANTS.delete）——否则重投复用同一失效 token 必然连败。 */
  cacheDelete: (key: string) => Promise<void>;
  now: () => number;
}

interface TenantTokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number; // 秒
}

interface SendMessageResponse {
  code?: number;
  msg?: string;
  data?: { message_id?: string };
}

/**
 * 换取 tenant_access_token：先查 KV 缓存，命中直接用；未命中调飞书 internal 端点换取并回写缓存。
 * 缺 app_id/app_secret → 抛错（调用方留痕）。
 */
async function getTenantToken(cfg: FeishuSenderConfig): Promise<string> {
  const cached = await cfg.cacheGet(TOKEN_CACHE_KEY);
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
  await cfg.cachePut(TOKEN_CACHE_KEY, body.tenant_access_token, ttl > 0 ? ttl : 60);
  return body.tenant_access_token;
}

/** 飞书 token 失效类业务码（access token invalid/expired 家族）——作废缓存后重投可自愈。 */
const TOKEN_INVALID_CODES = new Set([99991661, 99991663, 99991665]);

/** 构造飞书 sender（生产依赖：env secrets + KV_TENANTS + 全局 fetch）。 */
export function feishuSenderFromEnv(
  env: Bindings,
  overrides: Partial<FeishuSenderConfig> = {},
): FeishuSender {
  const cfg: FeishuSenderConfig = {
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    baseUrl: env.FEISHU_BASE_URL ?? DEFAULT_FEISHU_BASE,
    // fetch 须绑定 globalThis——裸引用作为对象方法调用时丢 this，workerd 抛 Illegal invocation。
    fetchImpl: overrides.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
    cacheGet: overrides.cacheGet ?? ((key) => env.KV_TENANTS.get(key)),
    cachePut:
      overrides.cachePut ??
      ((key, value, ttlSec) => env.KV_TENANTS.put(key, value, { expirationTtl: ttlSec })),
    cacheDelete: overrides.cacheDelete ?? ((key) => env.KV_TENANTS.delete(key)),
    now: overrides.now ?? Date.now,
    ...overrides,
  };
  return {
    async send(message: OutboundMessage, opts?: { dedupeId?: string }): Promise<FeishuSendResult> {
      try {
        const token = await getTenantToken(cfg);
        const payload = encodeFeishuOutbound(message);
        // uuid：飞书 create message 幂等键（服务端按 uuid 去重）——队列重投同一事件不重复发消息（C3）。
        const reqBody =
          opts?.dedupeId !== undefined ? { ...payload, uuid: opts.dedupeId } : payload;
        const res = await cfg.fetchImpl(
          `${cfg.baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(reqBody),
          },
        );
        const body = (await res.json()) as SendMessageResponse;
        if (body.code !== 0) {
          // token 失效家族：作废缓存（否则重投复用同一失效 token 必然连败）→ retryable。
          if (body.code !== undefined && TOKEN_INVALID_CODES.has(body.code)) {
            await cfg.cacheDelete(TOKEN_CACHE_KEY).catch(() => {});
            return {
              ok: false,
              retryable: true,
              error: `feishu token invalid: code=${body.code} msg=${body.msg ?? 'unknown'}`,
            };
          }
          // 其他业务拒绝（receive_id 非法等）：重投必然同败 → 不可重试。
          return {
            ok: false,
            retryable: false,
            error: `feishu send failed: code=${body.code} msg=${body.msg ?? 'unknown'}`,
          };
        }
        return { ok: true, messageId: body.data?.message_id };
      } catch (err) {
        // 网络抖动 / 飞书 5xx / token 换取失败：瞬时故障 → 可重试。
        return {
          ok: false,
          retryable: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
