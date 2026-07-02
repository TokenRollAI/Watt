/**
 * §2.3 订阅匹配（`EventBus.Subscribe` 的 match 语义）——纯函数，无 I/O。
 *
 * 规范（Proto §2.3 L272-283）：match 全部条件 AND；缺省字段不参与匹配（空 match 匹配一切）。
 * type 支持后缀通配 "im.*"；sourceKind ↔ event.source.kind；channel ↔ event.source.channel；
 * session ↔ event.session。
 */

import type { Event } from '../types.ts';
import type { SubscriptionMatch } from './types.ts';

/**
 * type 匹配。
 * - "*" → 全通配（合法，匹配任意 type，含空串）。
 * - 以 "*" 结尾（如 "im.*"）→ 前缀 startsWith 匹配（前缀含末尾的点，故不匹配裸 "im"，
 *   匹配 "im.message" / "im.action" / "im.message.sub"）。
 * - 否则精确相等。
 */
function typeMatches(pattern: string, type: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    return type.startsWith(pattern.slice(0, -1));
  }
  return pattern === type;
}

/**
 * 判定事件是否命中订阅 match（§2.3）。全部已声明条件 AND；未声明字段跳过（不参与匹配）。
 */
export function matchesSubscription(event: Event, match: SubscriptionMatch): boolean {
  if (match.type !== undefined && !typeMatches(match.type, event.type)) return false;
  if (match.sourceKind !== undefined && event.source.kind !== match.sourceKind) return false;
  if (match.channel !== undefined && event.source.channel !== match.channel) return false;
  if (match.session !== undefined && event.session !== match.session) return false;
  return true;
}
