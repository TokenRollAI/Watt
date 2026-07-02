/**
 * EventBus Publish 服务（Proto §2.3 EventBus.Publish）——直接 API 投递入口。
 *
 * 规范流程（§2.3 L259-262 + §1 尺寸 + §2.3 幂等）：
 *   ① type='outbound.message' → 先出站鉴权 Check(event://<channel>/<target>,'write')；deny → permission_denied。
 *   ② core normalizeEvent 补齐 id/traceId/occurredAt/principal（Omit 三字段）。
 *   ③ validateEventSize（128KB 上限）→ 超限 invalid_argument。
 *   ④ dedupeKey 有值 → EventStore.findByDedupeKey 窗内命中 → 幂等返回原 eventId，**不再留痕/不再投递**。
 *   ⑤ EventStore.put 留痕（§2.4）。
 *   ⑥ 送 Queue（consumer 侧再匹配订阅分发）→ 返回 { eventId }。
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

  // ② 补齐 Omit 三字段（+ channelUser 存在时补 principal，由 core 处理）。
  const event = normalizeEvent(input, {
    genId: deps.genId,
    now: deps.now,
    genTraceId: deps.genTraceId,
    traceId: deps.traceId,
  });

  // ③ 尺寸校验（128KB）。
  const sizeErr = validateEventSize(event);
  if (sizeErr !== null) return sizeErr;

  // ④ dedupeKey 幂等：窗内命中原事件 → 返回原 eventId，不再留痕/投递。
  if (event.dedupeKey !== undefined) {
    const nowMs = (deps.nowMs ?? Date.now)();
    const existing = await deps.store.findByDedupeKey(event.dedupeKey, nowMs);
    if (existing !== null) {
      return { eventId: existing };
    }
  }

  // ⑤ 留痕（§2.4）。
  await deps.store.put(event);

  // ⑥ 送 Queue（consumer 侧匹配订阅分发）。
  await deps.queue.send(event);

  return { eventId: event.id };
}
