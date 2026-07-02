/**
 * 内置 webhook ChannelAdapter（Proto §2.1 全四义务）——gateway 内置,不走 PluginRegistry
 * (Plugin System 属后期 Phase)。验签纯逻辑下沉 @watt/core（hmac.ts）,此处只做 I/O 与规约胶水。
 *
 * 契约实现自由处（Proto/Architecture 未规定,逐条声明于 PROGRESS + 本文注释）：
 *  - 签名 header：x-watt-signature，值 "sha256=<hex>"（见 core WATT_HMAC）。
 *  - session scope：webhook:<channelId>:<scope>；通用 webhook 无更细粒度端点作用域,
 *    scope 退化为 channelId（注释声明）。
 *  - payload：JSON.parse(bodyRaw);parse 失败降级为 {text: bodyRaw}（注释声明）。
 *  - dedupeKey：请求头 x-watt-delivery-id 存在则 webhook:<channelId>:<delivery-id>,
 *    否则缺省（通用 webhook 不保证重投语义）。
 *  - channelUser：缺省（通用 webhook 无标准触发者身份;principal 由平台走 anonymous）。
 *
 * ⚠️ Verify 因走 WebCrypto（crypto.subtle）必然 async,与 core 同步 InboundAdapter.Verify
 *    签名不结构兼容,故此处用 AsyncInboundAdapter。路由层接 processInbound 时需 await（见 handoff）。
 */

import type { Event, OutboundMessage, RawInbound } from '@watt/core';
import { verifySignature, WATT_HMAC } from '@watt/core';
import { type WattError, wattError } from '@watt/shared';

/** RawOutbound（§2.1 L222）：出站原生报文。 */
export interface RawOutbound {
  endpoint: string;
  headers: Record<string, string>;
  body: unknown;
}

/** SendReceipt（§2.1 L223）：投递回执。 */
export interface SendReceipt {
  ok: boolean;
  channelMessageId?: string;
  error?: WattError;
}

/**
 * webhook adapter 形状（§2.1 四义务）。Verify 因 WebCrypto 为 async,
 * 与 core 同步 InboundAdapter 不结构兼容,故独立声明。Decode 保持同步。
 */
export interface WebhookAdapter {
  Verify(request: RawInbound): Promise<boolean>;
  Decode(request: RawInbound): Partial<Event>[];
  Encode(message: OutboundMessage): RawOutbound;
  Send(payload: RawOutbound): Promise<SendReceipt>;
}

export interface WebhookAdapterOptions {
  /** 验签共享密钥（gateway 从 secret 引用取值后注入,见 ChannelConfig.settings 契约）。 */
  secret: string;
  /** 渠道 ID（source.channel / session scope / dedupeKey 前缀）。 */
  channelId: string;
  /** 出站投递用的 fetch（缺省全局 fetch;测试注入）。 */
  fetchImpl?: typeof fetch;
  /** occurredAt 时钟（缺省 now;测试注入）。 */
  now?: () => string;
}

/** 大小写不敏感取 header 值（RawInbound.headers 是普通 Record,key 大小写不定）。 */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      return headers[key];
    }
  }
  return undefined;
}

/** encoding='base64' 时解回字节,保证验签与规约都基于字节级原文;utf8 直接用字符串。 */
function bodyBytes(request: RawInbound): string | Uint8Array {
  if (request.encoding === 'base64') {
    // atob 在 workerd/node 26 均有;逐字节还原,验签依赖字节精确原文（§2.1）。
    const binary = atob(request.bodyRaw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  return request.bodyRaw;
}

/** 解码 body 为文本(供 JSON.parse / 降级);base64 先解回 utf8 文本。 */
function bodyText(request: RawInbound): string {
  const raw = bodyBytes(request);
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
}

export function createWebhookAdapter(options: WebhookAdapterOptions): WebhookAdapter {
  const { secret, channelId } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async Verify(request: RawInbound): Promise<boolean> {
      const provided = headerValue(request.headers, WATT_HMAC.signatureHeader);
      if (provided === undefined) {
        return false;
      }
      return verifySignature(secret, bodyBytes(request), provided);
    },

    Decode(request: RawInbound): Partial<Event>[] {
      const text = bodyText(request);
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        // 非 JSON body 降级为文本载荷,保留原文供下游处理。
        payload = { text };
      }

      const delivery = headerValue(request.headers, WATT_HMAC.deliveryHeader);

      const event: Partial<Event> = {
        type: 'webhook.received',
        // scope 退化为 channelId：通用 webhook 无更细粒度端点作用域。
        session: `webhook:${channelId}:${channelId}`,
        payload,
        occurredAt: now(),
        source: { kind: 'webhook', channel: channelId },
        raw: text,
      };
      if (delivery !== undefined) {
        event.dedupeKey = `webhook:${channelId}:${delivery}`;
      }
      return [event];
    },

    Encode(message: OutboundMessage): RawOutbound {
      return {
        endpoint: message.target,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message.content),
      };
    },

    async Send(payload: RawOutbound): Promise<SendReceipt> {
      try {
        const res = await fetchImpl(payload.endpoint, {
          method: 'POST',
          headers: payload.headers,
          body: typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body),
        });
        if (!res.ok) {
          return {
            ok: false,
            error: wattError('unavailable', `webhook sink responded ${res.status}`, true),
          };
        }
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: wattError('unavailable', `webhook send failed: ${message}`, true),
        };
      }
    },
  };
}
