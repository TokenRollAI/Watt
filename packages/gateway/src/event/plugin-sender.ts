/**
 * 通用出站分发器（Proto §2.1 / §11.4 / Architecture M1 出站对称 + M11 出站分发机制）——P1 飞书 plugin 化。
 *
 * 规范缺失的那一段落地：把 gateway consumer 里对具体渠道（原 feishu-sender 硬编码）的耦合，替换为
 *   按 ChannelConfig.adapter → PluginRegistry 查 enabled channel-adapter → 经 §11.4 `POST {"tool":"Send"}`
 *   投递的**通用机制**。惠及所有未来 channel-adapter plugin；gateway 不含任何具体渠道代码/凭据。
 *
 * 分发规则：
 *  - pluginId = ChannelConfig.settings.pluginId（覆盖）?? 约定 `channel-<adapter>`。
 *  - 查 PluginRegistry：不存在 / 未 enabled / 非 channel-adapter → skipped（无投递目标，consumer ack）。
 *  - endpoint `binding:<name>` → 经 env service binding fetch（平台内 Worker plugin）；HTTPS → 直接 fetch。
 *  - 认证：平台以 WATT_JWT_PRIVATE_JWK 签**短时 platform-token**（principal=`platform:outbound`，ttl 120s），
 *    Bearer 携带；plugin 侧经 jwksUrl 验签（§11.4c）。X-Watt-Request-Id=event.id（plugin 幂等）。10s 超时。
 *  - 返回 SendReceipt：error.retryable → consumer 返回 false 触发队列重投（§2.1 retryable 语义）。
 */

import { type ChannelConfig, type OutboundMessage, signUserToken } from '@watt/core';
import type { WattError } from '@watt/shared';
import { loadPlatformKeys } from '../authz/keys.ts';
import type { Bindings } from '../env.ts';
import { PluginRegistry } from '../plugin/plugin-registry.ts';

/** 本地 WattError 守卫（对齐 routes.ts / context-routes.ts 习惯，避免跨模块耦合）。 */
function isWattError(v: unknown): v is WattError {
  return typeof v === 'object' && v !== null && 'code' in v && 'message' in v;
}

/** 出站分发结果。skipped=无 plugin 可投（ack，不重投）；ok=false + retryable → consumer 重投。 */
export interface OutboundDispatchResult {
  ok: boolean;
  channelMessageId?: string;
  error?: string;
  retryable?: boolean;
  /** 无 enabled channel-adapter 可投（渠道未接 plugin）——非失败，consumer ack。 */
  skipped?: boolean;
}

/** 出站分发器抽象（consumer 注入，便于测试 fake）。 */
export interface PluginSender {
  send(
    channel: ChannelConfig,
    message: OutboundMessage,
    opts: { requestId: string; traceId?: string },
  ): Promise<OutboundDispatchResult>;
}

/** §11.4 Send 超时（Channel Send 10s）。 */
const SEND_TIMEOUT_MS = 10_000;
/** platform-token 短时 ttl（出站单次调用够用）。 */
const PLATFORM_TOKEN_TTL_SEC = 120;

/** 约定 adapter → plugin id（settings.pluginId 覆盖）。 */
export function resolvePluginId(channel: ChannelConfig): string {
  const override = channel.settings?.pluginId;
  return typeof override === 'string' && override.length > 0
    ? override
    : `channel-${channel.adapter}`;
}

/** 签发出站用短时 platform-token（plugin 经 JWKS 验签）。 */
async function signPlatformToken(env: Bindings, traceId?: string): Promise<string> {
  const keys = await loadPlatformKeys(env);
  return signUserToken(
    {
      principal: 'platform:outbound',
      roles: [],
      ttlSeconds: PLATFORM_TOKEN_TTL_SEC,
      ...(traceId !== undefined ? { trace: traceId } : {}),
    },
    keys.priv,
    keys.meta,
  );
}

/** 解析出站响应体（成功 SendReceipt / 失败 SendReceipt 或裸 WattError）→ 归一化 dispatch 结果。 */
function parseDispatchResponse(status: number, body: unknown): OutboundDispatchResult {
  const b = (typeof body === 'object' && body !== null ? body : {}) as {
    ok?: boolean;
    channelMessageId?: string;
    error?: string;
    retryable?: boolean;
    message?: string;
    code?: string;
  };
  if (status >= 200 && status < 300) {
    if (b.ok === true) {
      return {
        ok: true,
        ...(b.channelMessageId !== undefined ? { channelMessageId: b.channelMessageId } : {}),
      };
    }
    // 200 但 receipt.ok=false（防御）：按 receipt 语义。
    return { ok: false, error: b.error, retryable: b.retryable === true };
  }
  // 非 2xx：优先 SendReceipt.retryable / WattError.retryable；缺省按 HTTP（429/5xx→retryable）。
  const retryable =
    typeof b.retryable === 'boolean' ? b.retryable : status === 429 || status >= 500;
  const error = b.error ?? b.message ?? `plugin returned HTTP ${status}`;
  return { ok: false, error, retryable };
}

/**
 * 生产出站分发器：PluginRegistry 解析 + platform-token 签发 + binding/HTTPS 分发（§11.4）。
 * fetchImpl 可注入（HTTPS 路径测试）；binding 路径经 env service binding（vitest serviceBindings fake）。
 */
export function defaultPluginSender(
  env: Bindings,
  fetchImpl: typeof fetch = (...a: Parameters<typeof fetch>) => fetch(...a),
): PluginSender {
  const registry = new PluginRegistry(env.DB_PROVIDERS);
  return {
    async send(channel, message, opts): Promise<OutboundDispatchResult> {
      const pluginId = resolvePluginId(channel);
      const plugin = await registry.get(pluginId);
      if (isWattError(plugin)) {
        return {
          ok: false,
          skipped: true,
          error: `no plugin ${pluginId} for channel ${channel.id}`,
        };
      }
      if (!plugin.enabled || plugin.kind !== 'channel-adapter') {
        return {
          ok: false,
          skipped: true,
          error: `plugin ${pluginId} not an enabled channel-adapter`,
        };
      }

      let token: string;
      try {
        token = await signPlatformToken(env, opts.traceId);
      } catch (err) {
        // 签名密钥缺失 → 出站不可用（retryable：配置修复后重投可成）。
        return {
          ok: false,
          retryable: true,
          error: `platform token sign failed: ${err instanceof Error ? err.message : err}`,
        };
      }

      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-watt-request-id': opts.requestId,
        ...(opts.traceId !== undefined ? { 'x-watt-trace': opts.traceId } : {}),
      };
      const reqBody = JSON.stringify({ tool: 'Send', arguments: { message } });

      try {
        let res: Response;
        if (plugin.endpoint.startsWith('binding:')) {
          const name = plugin.endpoint.slice('binding:'.length);
          const fetcher = (env as unknown as Record<string, { fetch: typeof fetch } | undefined>)[
            name
          ];
          if (fetcher === undefined || typeof fetcher.fetch !== 'function') {
            return { ok: false, skipped: true, error: `service binding ${name} not bound` };
          }
          res = await fetcher.fetch('https://plugin.internal/', {
            method: 'POST',
            headers,
            body: reqBody,
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          });
        } else {
          const url = plugin.endpoint.replace(/\/+$/, '');
          res = await fetchImpl(url, {
            method: 'POST',
            headers,
            body: reqBody,
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          });
        }
        const body = await res.json().catch(() => ({}));
        return parseDispatchResponse(res.status, body);
      } catch (err) {
        // 网络抖动 / 超时 / 服务 5xx：瞬时故障 → 可重试。
        return {
          ok: false,
          retryable: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
