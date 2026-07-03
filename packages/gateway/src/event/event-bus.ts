/**
 * EventBus Publish 服务（Proto §2.3 EventBus.Publish）——直接 API 投递入口。
 *
 * 规范流程（§2.3 L259-262 + §1 尺寸 + §2.3 幂等）：
 *   ① type='outbound.message' → 先出站鉴权 Check(event://<channel>/<target>,'write')；deny → permission_denied。
 *   ② channelUser 存在且 principal 缺省 → await resolvePrincipal 补齐 principal（§1 L115-116，未映射 anonymous）。
 *   ③ core normalizeEvent 补齐 id/traceId/occurredAt（occurredAt 渠道已填则保留）。
 *   ④ validateEventSize（128KB 上限）→ 超限 invalid_argument。
 *   ⑤ dedupeKey 有值 → EventStore.findByDedupeKey 窗内命中 → 幂等返回原 eventId，**不再留痕/不再投递**。
 *   ⑥ EventStore.put 留痕（§2.4）。
 *   ⑦ 送 Queue（consumer 侧再匹配订阅分发）→ 返回 { eventId }。send 失败 → 补偿删留痕 + unavailable(retryable)。
 *
 * 出站鉴权接线：用 core outboundAccessRequest 从事件派生 (event://<channel>/<target>, 'write')，
 * 再交 gateway 侧 Authorizer.check（复用 PolicyStore.resolveCandidatePolicies + core.authorize
 * 四步判定）——不平行实现鉴权。非 outbound.message 不做出站鉴权（其余事件放行进入规约）。
 */

import {
  type Event,
  type EventInput,
  normalizeEvent,
  outboundAccessRequest,
  type PrincipalRef,
  type TokenClaims,
  validateEventSize,
} from '@watt/core';
import { type WattError, wattError } from '@watt/shared';
import type { Authorizer } from '../authz/authorizer.ts';
import type { EventStore } from './event-store.ts';

/** Queue send 抽象（QUEUE_EVENTS.send 的最小面；测试可注入计数器）。 */
export interface EventQueueSender {
  send(event: Event): Promise<void>;
}

/** Publish 的注入依赖（补齐字段的 gen 函数 + 存储/队列/鉴权），便于测试与纯逻辑分离。 */
export interface PublishDeps {
  store: EventStore;
  authorizer: Authorizer;
  queue: EventQueueSender;
  /** 出站鉴权所需的调用方 token claims（§6.4a）。非 outbound.message 时不使用。 */
  claims: TokenClaims;
  genId: () => string;
  now: () => string;
  genTraceId: () => string;
  /** 链路已有 traceId 则透传（§0.3）。 */
  traceId?: string;
  /** dedupe 窗判定的当前时刻（epoch ms，可注入以便测试）；缺省 Date.now()。 */
  nowMs?: () => number;
  /**
   * channelUser → principal 解析（§1 L115-116：Publish 前以 channelUser 调 IdentityMapper.Resolve
   * 补齐 principal）。async 因走 D1；未映射时约定 resolver 返回 'user:anonymous'（§6.3）。
   * 仅在 input.channelUser 存在且 input.principal 缺省时调用。缺省则不解析（保持 principal 原状）。
   */
  resolvePrincipal?: (channel: string, userId: string) => Promise<PrincipalRef>;
}

export interface PublishResult {
  eventId: string;
}

/**
 * Publish（§2.3）。成功返回 { eventId }（幂等命中时为原 eventId）；失败返回 WattError。
 */
export async function publish(
  input: EventInput,
  deps: PublishDeps,
): Promise<PublishResult | WattError> {
  // ① 出站鉴权（仅 type='outbound.message'）。core 派生 resource/action，gateway Authorizer 判定。
  const derived = outboundAccessRequest({ ...input, id: '', traceId: '', occurredAt: '' } as Event);
  if (derived !== null) {
    if ('error' in derived) {
      return derived.error; // payload 畸形 → invalid_argument
    }
    const decision = await deps.authorizer.check(
      deps.claims,
      derived.request.resource,
      derived.request.action,
    );
    if (!decision.allow) {
      return wattError('permission_denied', decision.reason ?? 'outbound not permitted', false);
    }
  }

  // ② 接线 IdentityMapper.Resolve（§1 L115-116）：channelUser 存在且 principal 缺省时，
  //    Publish 前 await 解析补齐 principal（未映射时 resolver 返回 'user:anonymous'，§6.3）。
  //    async 解析下沉此处；core normalizeEvent 的同步注入点保留不动。
  let resolvedInput = input;
  if (
    input.principal === undefined &&
    input.channelUser !== undefined &&
    deps.resolvePrincipal !== undefined
  ) {
    const principal = await deps.resolvePrincipal(
      input.channelUser.channel,
      input.channelUser.userId,
    );
    resolvedInput = { ...input, principal };
  }

  // ③ 补齐 Omit 三字段（principal 已由上一步解析注入，走透传分支）。
  const event = normalizeEvent(resolvedInput, {
    genId: deps.genId,
    now: deps.now,
    genTraceId: deps.genTraceId,
    traceId: deps.traceId,
  });

  // ④ 尺寸校验（128KB）。
  const sizeErr = validateEventSize(event);
  if (sizeErr !== null) return sizeErr;

  // ⑤ dedupeKey 幂等：窗内命中原事件 → 返回原 eventId，不再留痕/投递。
  if (event.dedupeKey !== undefined) {
    const nowMs = (deps.nowMs ?? Date.now)();
    const existing = await deps.store.findByDedupeKey(event.dedupeKey, nowMs);
    if (existing !== null) {
      return { eventId: existing };
    }
  }

  // ⑥ 留痕（§2.4）。
  await deps.store.put(event);

  // ⑦ 送 Queue（consumer 侧匹配订阅分发）。put 成功但 send 失败时：best-effort 删留痕，
  //    使调用方重投不被 dedupe 短路（否则投递永久丢失），返回 unavailable + retryable 引导重试。
  try {
    await deps.queue.send(event);
  } catch (_sendErr) {
    // 补偿删除本身失败时仅留痕（best-effort 边界：无法保证补偿一定成功，
    // 但仍返回 unavailable 让调用方重试；重投若命中残留 dedupe 会返回原 eventId，语义可接受）。
    try {
      await deps.store.delete(event.id);
    } catch (delErr) {
      console.error('event-bus: compensating delete failed after queue.send error', delErr);
    }
    return wattError('unavailable', 'event enqueue failed; retry', true);
  }

  return { eventId: event.id };
}
