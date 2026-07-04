/**
 * events domain wrappers（视图族A：Events 视图）。
 * 请求形状真源：packages/cli/src/event.ts（htbpCall 调用点）+ gateway 路由测试；禁自创形状、禁双形态兜底。
 *
 *  - List → event `List` {opts:{filter,limit}}；filter 合法键仅 type/channel/session/since/until
 *           （event-store.ts ALLOWED_LIST_FILTER_KEYS，未知键硬拒）。返回 §0.2 Page {items}（倒序）。
 *  - Get  → event `Get` {eventId} → {event}。
 *  - subs → event `ListSubscriptions` {opts:{}} → {items}。
 */
import { htbp } from './core.ts';
import type { Page } from './types.ts';

/** Event 信封读投影（与 CLI EventView 对齐；完整信封在 payload）。 */
export interface EventView {
  id: string;
  type: string;
  session?: string;
  occurredAt: string;
  source: { kind: string; channel?: string; ref?: string };
  payload?: unknown;
}

/** EventBus 订阅（match/sink 不透明对象；id 可选，取决于登记形态）。 */
export interface SubscriptionView {
  id?: string;
  match: Record<string, unknown>;
  sink: Record<string, unknown>;
}

/** event List filter（服务端白名单键；limit 另置于 opts 顶层）。 */
export interface EventListFilter {
  type?: string;
  channel?: string;
  session?: string;
  since?: string;
  until?: string;
}

export const eventsApi = {
  // EventStore.List——filter 只放白名单键（空值不下发），limit 置 opts 顶层。
  listEvents: (filter: EventListFilter = {}, limit = 100) => {
    const f: Record<string, string> = {};
    if (filter.type) f.type = filter.type;
    if (filter.channel) f.channel = filter.channel;
    if (filter.session) f.session = filter.session;
    if (filter.since) f.since = filter.since;
    if (filter.until) f.until = filter.until;
    return htbp<Page<EventView>>('event', 'List', { opts: { filter: f, limit } });
  },
  // EventStore.Get → {event}。
  getEvent: (eventId: string) => htbp<{ event: EventView }>('event', 'Get', { eventId }),
  // EventBus.ListSubscriptions → {items}。
  listSubscriptions: () => htbp<Page<SubscriptionView>>('event', 'ListSubscriptions', { opts: {} }),
};
