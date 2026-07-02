/**
 * §2.1 webhook 型接入管线（Verify → Decode）——纯逻辑，无 I/O。
 *
 * 规范（Proto §2.1 L228-231）：webhook 型接入平台依次调用
 *   Verify → Decode → 补齐(id/traceId/principal/roles) → Publish。
 * 本项聚焦 Verify 失败拒收；补齐（normalizeEvent，§1）与 Publish（Queue/EventStore）
 * 是后续 DoD 项（HTTP 接线项 2）的职责，故本管线边界止于 Decode 产物。
 *
 * ChannelAdapter（§2.1）以接口注入（此处只需 Verify/Decode 两个入站义务，
 * Encode/Send 是出站义务，不在本管线）。
 */

import { type WattError, wattError } from '@watt/shared';
import type { Event } from '../types.ts';

/** RawInbound（§2.1 L215-221）：字节精确原始 body，验签依赖字节级原文。 */
export interface RawInbound {
  headers: Record<string, string>;
  bodyRaw: string;
  encoding: 'utf8' | 'base64';
}

/**
 * ChannelAdapter 的入站两义务子集（§2.1 L198-206）。
 * Verify：校验入站请求真实性（验签/token），失败 → 拒收。
 * Decode：渠道原始报文 → 标准 Event（不含 id/traceId，由平台补齐）。
 */
export interface InboundAdapter {
  Verify(request: RawInbound): boolean;
  Decode(request: RawInbound): Partial<Event>[];
}

/** processInbound 结果：Verify 通过给 Decode 产物；失败给 permission_denied。 */
export type InboundResult = { events: Partial<Event>[] } | { error: WattError };

/**
 * 入站管线（§2.1 webhook 型）：Verify → Decode。
 * Verify 失败即身份不可信 → permission_denied（HTTP 401/403 由接线层承担，见 §0.2 未认证补充），
 * 且不调用 Decode（拒收短路，避免对不可信报文做任何解析）。
 * Verify 通过 → 返回 Decode 得的 Partial<Event>[]，交调用方补齐 + Publish。
 */
export function processInbound(adapter: InboundAdapter, request: RawInbound): InboundResult {
  if (!adapter.Verify(request)) {
    return {
      error: wattError('permission_denied', 'inbound verification failed', false),
    };
  }
  return { events: adapter.Decode(request) };
}
