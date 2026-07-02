/**
 * `watt event tail|get|subs`：POST /htbp/platform/event `{tool,arguments}`（Architecture M10）。
 *
 *  - tail  → 轮询 EventStore.List（M10「tail = 轮询 List」）。记住最大 occurredAt 作 since 游标
 *            （§2.4 since 含端），每轮拉新事件后推进游标；sleep 注入。--once 只拉一轮退出（测试用）。
 *            --json 每事件一行 NDJSON；非 json 每事件一行制表符分隔（occurredAt/type/channel/id）。
 *  - get   → EventStore.Get，arguments:{eventId}。
 *  - subs  → EventBus.ListSubscriptions，arguments:{opts}。
 *
 * List 返回 §0.2 Page `{items}`；tail 语义与 policy list 同构，只是 CLI 侧加轮询循环。
 */

import { type HttpDeps, htbpCall } from './client.ts';

/** Event 信封的最小读投影（CLI 展示 + 游标推进用；完整信封在 payload/raw）。 */
export interface EventView {
  id: string;
  type: string;
  session?: string;
  occurredAt: string;
  source: { kind: string; channel?: string };
  payload?: unknown;
}

interface EventPage {
  items: EventView[];
}

/** 一轮 List（可带 since 游标 + 过滤维度）。返回按 occurredAt 倒序的一页（服务端语义）。 */
export async function eventList(
  base: string,
  token: string,
  filter: { type?: string; channel?: string; session?: string; since?: string },
  deps: HttpDeps = {},
): Promise<EventView[]> {
  const filterObj: Record<string, string> = {};
  if (filter.type) filterObj.type = filter.type;
  if (filter.channel) filterObj.channel = filter.channel;
  if (filter.session) filterObj.session = filter.session;
  if (filter.since) filterObj.since = filter.since;
  const body = (await htbpCall(
    base,
    token,
    'event',
    'List',
    { opts: { filter: filterObj } },
    deps,
  )) as EventPage;
  return body.items;
}

export async function eventGet(
  base: string,
  token: string,
  eventId: string,
  deps: HttpDeps = {},
): Promise<EventView> {
  const body = (await htbpCall(base, token, 'event', 'Get', { eventId }, deps)) as {
    event: EventView;
  };
  return body.event;
}

export interface SubscriptionView {
  id?: string;
  match: Record<string, unknown>;
  sink: Record<string, unknown>;
}

export async function eventSubs(
  base: string,
  token: string,
  deps: HttpDeps = {},
): Promise<SubscriptionView[]> {
  const body = (await htbpCall(base, token, 'event', 'ListSubscriptions', { opts: {} }, deps)) as {
    items: SubscriptionView[];
  };
  return body.items;
}

/** 单个事件的人类可读行（制表符分隔）。 */
export function formatEventLine(e: EventView): string {
  return `${e.occurredAt}\t${e.type}\t${e.source.channel ?? '-'}\t${e.id}`;
}

export interface TailOptions extends HttpDeps {
  /** 轮询间隔 ms（缺省 5000）。 */
  intervalMs?: number;
  /** 只拉一轮就退出（测试用）。 */
  once?: boolean;
  /** 轮询 sleep 注入（缺省 setTimeout）。 */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * tail 轮询循环（M10「tail = 轮询 List」）。每轮 List → 按 occurredAt 升序发出新事件 →
 * 推进 since 游标到最大 occurredAt。emit 逐事件回调（--json NDJSON / 制表符行由调用方决定）。
 * --once 拉一轮即返回；否则 sleep(intervalMs) 后继续。since 含端（§2.4），故推进后加 1ms 避免重复。
 */
export async function eventTail(
  base: string,
  token: string,
  filter: { type?: string; channel?: string; session?: string; since?: string },
  emit: (e: EventView) => void,
  opts: TailOptions = {},
): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  const intervalMs = opts.intervalMs ?? 5000;
  let since = filter.since;
  for (;;) {
    const items = await eventList(base, token, { ...filter, since }, { fetch: opts.fetch });
    // List 返回倒序（最新在前）；tail 按时间顺序发出 → 升序遍历。
    const ascending = [...items].reverse();
    for (const e of ascending) {
      emit(e);
      // 游标推进到已见最大 occurredAt + 1ms（since 含端，避免下轮重复拉到边界事件）。
      const nextMs = Date.parse(e.occurredAt) + 1;
      since = new Date(nextMs).toISOString();
    }
    if (opts.once) return;
    await sleep(intervalMs);
  }
}
