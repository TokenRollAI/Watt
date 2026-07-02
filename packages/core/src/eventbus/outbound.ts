/**
 * §2.3 出站鉴权点（EventBus.Publish 对 outbound.message 的 Check）——纯逻辑，无 I/O。
 *
 * 规范（Proto §2.3 L259-262）：type="outbound.message" 时判定
 *   Check(context, event://<channel>/<target>, 'write')——"Agent 能否向某渠道发消息"在此收敛。
 *
 * 两个 helper：
 *   outboundAccessRequest —— 从事件导出 { resource, action }（非 outbound.message → null；
 *     OutboundMessage payload zod 校验失败 → invalid_argument）；
 *   authorizeOutbound —— 与现有 §6.4c authorize() 组合，产出 AccessDecision。
 */

import { type WattError, wattError } from '@watt/shared';
import { type AuthorizeInput, authorize } from '../authz/authorize.ts';
import type { AccessDecision, Event } from '../types.ts';
import { outboundMessageSchema } from './types.ts';

const OUTBOUND_TYPE = 'outbound.message';

/** 出站鉴权的 (resource, action)：resource = event://<channel>/<target>，action 恒为 'write'。 */
export interface OutboundAccessRequest {
  resource: string;
  action: 'write';
}

/** 派生结果：非 outbound.message → null；校验通过 → request；payload 畸形 → error。 */
export type OutboundRequestResult = { request: OutboundAccessRequest } | { error: WattError };

/**
 * 从事件导出出站 AccessRequest（§2.3 L259-262）。
 * - type ≠ "outbound.message" → null（不参与出站鉴权）。
 * - OutboundMessage payload（§1 L139）zod 校验失败 → invalid_argument。
 */
export function outboundAccessRequest(event: Event): OutboundRequestResult | null {
  if (event.type !== OUTBOUND_TYPE) return null;

  const parsed = outboundMessageSchema.safeParse(event.payload);
  if (!parsed.success) {
    return {
      error: wattError('invalid_argument', 'invalid OutboundMessage payload', false),
    };
  }
  const { channel, target } = parsed.data;
  return { request: { resource: `event://${channel}/${target}`, action: 'write' } };
}

/**
 * 组合判定：从事件导出出站请求，再交 §6.4c authorize() 判定。
 * - 非 outbound.message → { allow: true }（出站鉴权不适用，本 helper 不拦截其他事件）。
 * - payload 畸形 → { allow: false, reason }（不放行畸形出站）。
 * - 否则以派生的 (resource, action='write') 覆写 authorize 输入的 resource/action 后判定。
 */
export function authorizeOutbound(
  event: Event,
  authInput: Omit<AuthorizeInput, 'resource' | 'action'>,
): AccessDecision {
  const derived = outboundAccessRequest(event);
  if (derived === null) return { allow: true };
  if ('error' in derived) {
    return { allow: false, reason: derived.error.message };
  }
  return authorize({
    ...authInput,
    resource: derived.request.resource,
    action: derived.request.action,
  });
}
