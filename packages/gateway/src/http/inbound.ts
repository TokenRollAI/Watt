/**
 * 通用入站端点（Proto §2.1 webhook 型）——POST /channels/:channelId/inbound。
 *
 * **无认证**：验签即认证（§2.1；飞书走 WebSocket push 不经此入口）。流程：
 *   ① ChannelRegistry 查 channelId：不存在 → 404 not_found；disabled → 403 permission_denied。
 *   ② 按 config.adapter 构造 Adapter（Phase 2 仅内置 'webhook'；其余 → 501 unavailable）。
 *      webhook 验签 secret 从 config.settings.verifySecretRef 引用名在 env 取（§2.1：密钥走
 *      Secrets 引用，不明文存 settings）——引用缺失/env 无值 → 500 internal（配置错误，非请求错误）。
 *   ③ 构造 RawInbound（字节级 bodyRaw 透传，§2.1 L217-219）→ Verify（失败 → 403 permission_denied
 *      裸 WattError）→ Decode 产 Partial<Event>[]。
 *   ④ 每个 Partial<Event> 走 event-bus publish（source 已由 adapter 填 webhook；principal 匿名系统）
 *      → 收集 eventId。
 *   ⑤ 返回 { eventIds:[...] }（200）。dedupeKey 命中的重投由 publish 内部幂等（返回原 eventId、
 *      不再留痕/投递），对调用方透明。
 *
 * webhook adapter 的 Verify 走 WebCrypto（async），与 core 同步 processInbound 的 Verify 签名
 * 不兼容，故此处内联 Verify → Decode（await Verify），语义等同 core processInbound（拒收短路）。
 */

import type { Event, EventInput, PrincipalRef, TokenClaims } from '@watt/core';
import { type WattError, wattError } from '@watt/shared';
import { Hono } from 'hono';
import { Authorizer } from '../authz/authorizer.ts';
import { IdentityMapper } from '../authz/identity-mapper.ts';
import { PolicyStore } from '../authz/policy-store.ts';
import type { Bindings } from '../env.ts';
import { createWebhookAdapter } from '../event/adapters/webhook.ts';
import { ChannelStore } from '../event/channel-store.ts';
import { publish } from '../event/event-bus.ts';
import { EventStore } from '../event/event-store.ts';
import { wattErrorResponse } from './errors.ts';

/** 入站规约事件的匿名系统身份（通用 webhook 无标准触发者；principal 走匿名，对齐 E2E-4 降级）。 */
const ANONYMOUS_CLAIMS: TokenClaims = { sub: 'service:anonymous', roles: [] };

/** 从 env 按引用名取 secret 值（settings.verifySecretRef → wrangler secret / miniflare binding）。 */
function resolveSecret(env: Bindings, ref: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[ref];
  return typeof value === 'string' ? value : undefined;
}

/** 请求头 → 普通 Record（RawInbound.headers；大小写由 adapter 归一）。 */
function collectHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

export function inboundRoutes(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();

  app.post('/channels/:channelId/inbound', async (c) => {
    const channelId = c.req.param('channelId');

    // ① ChannelRegistry 查配置。
    const channels = new ChannelStore(c.env.DB_EVENTS);
    const config = await channels.get(channelId);
    if ('code' in config) {
      return wattErrorResponse(c, config); // not_found → 404
    }
    if (!config.enabled) {
      return wattErrorResponse(
        c,
        wattError('permission_denied', `channel is disabled: ${channelId}`, false),
      );
    }

    // ② 按 adapter 构造（Phase 2 仅 webhook）。未落地能力 → HTTP 501（§0.2 补充：未实现
    //    返回 501 + code:'unavailable'、retryable:false；不走 httpStatusFor 默认的 503）。
    if (config.adapter !== 'webhook') {
      const body: WattError = {
        code: 'unavailable',
        message: `channel adapter not implemented: ${config.adapter}`,
        retryable: false,
      };
      // biome-ignore lint/suspicious/noExplicitAny: 501 非 unavailable 的默认映射（503），此处显式覆盖。
      return c.json(body, 501 as any);
    }
    const secretRef = config.settings.verifySecretRef;
    if (typeof secretRef !== 'string') {
      return wattErrorResponse(
        c,
        wattError('internal', 'channel is missing settings.verifySecretRef', false),
      );
    }
    const secret = resolveSecret(c.env, secretRef);
    if (secret === undefined) {
      return wattErrorResponse(
        c,
        wattError('internal', `verify secret is not configured: ${secretRef}`, false),
      );
    }
    const adapter = createWebhookAdapter({ secret, channelId });

    // ③ RawInbound：字节级原文透传（§2.1 L217-219，验签依赖字节精确）→ Verify → Decode。
    //    c.req.text() 会有损解码非 UTF-8 字节（破坏 HMAC），改为读原始 bytes：
    //    严格 UTF-8 解码成功 → utf8；含非 UTF-8 字节 → 逐字节 base64（webhook adapter 已支持 base64 分支）。
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    let bodyRaw: string;
    let encoding: 'utf8' | 'base64';
    try {
      bodyRaw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      encoding = 'utf8';
    } catch {
      let binary = '';
      for (const b of bytes) {
        binary += String.fromCharCode(b);
      }
      bodyRaw = btoa(binary);
      encoding = 'base64';
    }
    const rawInbound = { headers: collectHeaders(c.req.raw), bodyRaw, encoding };
    const verified = await adapter.Verify(rawInbound);
    if (!verified) {
      // Verify 失败短路：不 Decode 不可信报文（§2.1 拒收）。permission_denied → 403。
      return wattErrorResponse(
        c,
        wattError('permission_denied', 'inbound verification failed', false),
      );
    }
    const decoded = adapter.Decode(rawInbound);

    // ④ 每个 Partial<Event> 补齐 + Publish（source 已由 adapter 填 webhook）。
    const store = new EventStore(c.env.DB_EVENTS);
    const authorizer = new Authorizer(new PolicyStore(c.env.DB_POLICIES));
    // IdentityMapper.Resolve 接线（§1 L115-116）：channelUser → principal（查无映射 → 'user:anonymous'）。
    const identity = new IdentityMapper(c.env.DB_POLICIES);
    const resolvePrincipal = async (channel: string, userId: string): Promise<PrincipalRef> => {
      const resolved = await identity.resolve(channel, userId);
      return resolved.principal;
    };
    const queue = {
      async send(event: Event): Promise<void> {
        await c.env.QUEUE_EVENTS.send(event);
      },
    };
    const eventIds: string[] = [];
    for (const partial of decoded) {
      const result = await publish(partial as EventInput, {
        store,
        authorizer,
        queue,
        claims: ANONYMOUS_CLAIMS,
        resolvePrincipal,
        genId: () => crypto.randomUUID(),
        now: () => new Date().toISOString(),
        genTraceId: () => crypto.randomUUID(),
        traceId: c.req.header('X-Watt-Trace'),
      });
      if ('code' in result) {
        return wattErrorResponse(c, result as WattError);
      }
      eventIds.push(result.eventId);
    }

    // ⑤ 返回 eventIds（幂等命中的重投返回原 eventId，对调用方透明）。
    return c.json({ eventIds });
  });

  return app;
}
