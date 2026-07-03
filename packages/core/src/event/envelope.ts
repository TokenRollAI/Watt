/**
 * Event 信封纯逻辑（§1 / §2.3）：尺寸判定 + Omit 字段补齐。无 I/O。
 */

import { type WattError, wattError } from '@watt/shared';
import type { Event, EventInput, PrincipalRef } from '../types.ts';

/** Proto §1：Event 序列化总尺寸 ≤128 KB（对齐 Cloudflare Queues 单消息上限）。128 * 1024 字节。 */
export const EVENT_MAX_BYTES = 128 * 1024;

/** 整个 Event 对象 JSON 序列化后的 UTF-8 字节数（含平台补齐的 id/traceId/occurredAt）。 */
export function eventByteSize(event: Event): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength;
}

/**
 * 尺寸校验（§1 L126 / DOD §3）。超过 128 KB → 返回 invalid_argument 的 WattError；否则 null。
 * 测量对象是最终要进 Queue 的完整 Event（补齐字段之后）。
 */
export function validateEventSize(event: Event): WattError | null {
  const bytes = eventByteSize(event);
  if (bytes > EVENT_MAX_BYTES) {
    return wattError(
      'invalid_argument',
      `event exceeds ${EVENT_MAX_BYTES} bytes (got ${bytes}); large content must be moved to Context/R2 via $ref`,
      false,
    );
  }
  return null;
}

/**
 * normalizeEvent 的可注入依赖（便于测试 & 满足纯函数要求）：
 * - genId / now / genTraceId：平台补齐 Omit 三字段（id/occurredAt/traceId）。
 * - traceId：链路中已有则透传（优先于 genTraceId）。
 * - resolvePrincipal：channelUser 存在且 principal 缺省时补齐 principal（IdentityMapper.Resolve 的注入点）。
 */
export interface NormalizeDeps {
  genId: () => string;
  now: () => string;
  genTraceId: () => string;
  traceId?: string;
  resolvePrincipal?: (channel: string, userId: string) => PrincipalRef;
}

/**
 * 补齐 Publish 入参（Omit<Event,'id'|'traceId'|'occurredAt'>）为完整 Event（§2.3 L259）。
 * - id：genId 生成（可注入以便测试）。
 * - occurredAt：input 已带则保留（§2.1 Decode 义务字段含 occurredAt，即渠道侧发生时刻），
 *   缺省才用 now()。EventInput 类型 Omit 了 occurredAt，但 ChannelAdapter.Decode 会在运行时填入
 *   （见 §2.1 L203），故这里读取运行时可能存在的值。（Proto §2.3 Omit 列表与 §2.1 Decode 义务
 *   对 occurredAt 的取舍矛盾属 doc-gap，此处依 §2.1 保留渠道时刻。）
 * - traceId：deps.traceId 已有则透传，否则 genTraceId 生成（§0.3 全链路观测）。
 * - principal：不在 Omit 列表，但当 channelUser 存在且 principal 缺省时由 resolvePrincipal 覆写（doc-gap #10）。
 */
export function normalizeEvent(
  input: EventInput & { occurredAt?: string },
  deps: NormalizeDeps,
): Event {
  let principal = input.principal;
  if (
    principal === undefined &&
    input.channelUser !== undefined &&
    deps.resolvePrincipal !== undefined
  ) {
    principal = deps.resolvePrincipal(input.channelUser.channel, input.channelUser.userId);
  }

  return {
    ...input,
    principal,
    id: deps.genId(),
    occurredAt: input.occurredAt ?? deps.now(),
    traceId: deps.traceId ?? deps.genTraceId(),
  };
}
