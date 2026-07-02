/**
 * §2.3 instanceBy 三态路由（`Subscription.sink.instanceBy` → Agent 实例键）——纯函数，无 I/O。
 *
 * 规范（Proto §2.3 L282 注释 / §3.1 L332-335）：
 *   'session'   → 同一 session 路由到同一 Agent 实例（Session Mapper 语义）；
 *   'event'     → 一事一实例；
 *   'singleton' → 全局唯一。
 *
 * 产出的 key 即 SpawnRequest.instanceKey（§3.2 L364 幂等键）：同 key 返回同实例。
 * key 由 definition 前缀 + 态相关部分拼成，保证不同态/不同 definition 天然不冲突。
 *
 * 契约偏离（doc-gap，Reflection Handoff 报告）：Proto 未定义 instanceBy='session' 但
 *   event.session 缺失时的行为。本实现返回显式 invalid_argument 错误而非静默 fallback
 *   （fallback 到 singleton/event 都会把无关会话错误合流或散射，破坏 session 粘性语义），
 *   把契约缺口暴露为调用方可见错误，交由订阅建立时（AgentDefinition 声明式订阅）保证。
 */

import { type WattError, wattError } from '@watt/shared';
import type { Event } from '../types.ts';
import type { SubscriptionSink } from './types.ts';

/** resolveInstanceKey 结果：成功给 key，session 缺失给 error（非 fallback）。 */
export type InstanceKeyResult = { key: string } | { error: WattError };

/**
 * 依 sink.instanceBy 求 Agent 实例键。仅 sink.kind='agent' 有 instanceBy；其余 kind 无实例概念。
 */
export function resolveInstanceKey(sink: SubscriptionSink, event: Event): InstanceKeyResult {
  if (sink.kind !== 'agent') {
    return {
      error: wattError('invalid_argument', `sink kind '${sink.kind}' has no instance key`, false),
    };
  }

  const base = `agent:${sink.definition}`;
  switch (sink.instanceBy) {
    case 'singleton':
      return { key: base };
    case 'event':
      return { key: `${base}#event:${event.id}` };
    case 'session': {
      if (event.session === undefined) {
        return {
          error: wattError(
            'invalid_argument',
            "instanceBy 'session' requires event.session; none present",
            false,
          ),
        };
      }
      return { key: `${base}#session:${event.session}` };
    }
  }
}
