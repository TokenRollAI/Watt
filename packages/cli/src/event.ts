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

/** 一轮 List（可带 since 游标 + 过滤维度 + limit）。返回按 occurredAt 倒序的一页（服务端语义）。 */
export async function eventList(
  base: string,
  token: string,
  filter: { type?: string; channel?: string; session?: string; since?: string; limit?: number },
  deps: HttpDeps = {},
): Promise<EventView[]> {
  const filterObj: Record<string, string> = {};
  if (filter.type) filterObj.type = filter.type;
  if (filter.channel) filterObj.channel = filter.channel;
  if (filter.session) filterObj.session = filter.session;
  if (filter.since) filterObj.since = filter.since;
  const opts: { filter: Record<string, string>; limit?: number } = { filter: filterObj };
  if (filter.limit !== undefined) opts.limit = filter.limit;
  const body = (await htbpCall(base, token, 'event', 'List', { opts }, deps)) as EventPage;
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
  /** 警告输出注入（缺省 process.stderr；满页可能遗漏时告警）。 */
  stderr?: (line: string) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 服务端 List 单页上限（event-store.ts MAX_LIST_LIMIT）；tail 每轮拿满即可能有遗漏。 */
const TAIL_PAGE_LIMIT = 200;

/**
 * tail 轮询循环（M10「tail = 轮询 List」）。每轮 List → 按 occurredAt 升序发出新事件 →
 * 推进 since 游标到最大 occurredAt。emit 逐事件回调（--json NDJSON / 制表符行由调用方决定）。
 * --once 拉一轮即返回；否则 sleep(intervalMs) 后继续。
 *
 * 游标语义（since 含端 >=，§2.4）：游标保持已见最大 occurredAt（不 +1ms），下轮会重查该毫秒边界，
 * 用「当前游标毫秒的已见 id 集合」去重（seenAtCursor），避免同毫秒晚写入的事件被永久跳过；
 * 游标推进到新毫秒时清空旧集合，防止无界增长。每轮显式请求 limit=200（服务端上限），
 * 拿满一页时该毫秒/窗口内可能有更旧条目被截断 → 输出 stderr 警告（不静默遗漏）。
 */
export async function eventTail(
  base: string,
  token: string,
  filter: { type?: string; channel?: string; session?: string; since?: string },
  emit: (e: EventView) => void,
  opts: TailOptions = {},
): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  const warn = opts.stderr ?? ((l: string) => process.stderr.write(`${l}\n`));
  const intervalMs = opts.intervalMs ?? 5000;
  let since = filter.since;
  // 当前游标毫秒（since）内已 emit 的 id，用于跨轮去重同毫秒边界事件；游标推进到新毫秒时清空。
  let seenAtCursor = new Set<string>();
  for (;;) {
    const items = await eventList(
      base,
      token,
      { ...filter, since, limit: TAIL_PAGE_LIMIT },
      { fetch: opts.fetch },
    );
    if (items.length >= TAIL_PAGE_LIMIT) {
      warn(`watt: tail 单轮拿满 ${TAIL_PAGE_LIMIT} 条（服务端上限），窗口内更旧事件可能被截断遗漏`);
    }
    // List 返回倒序（最新在前）；tail 按时间顺序发出 → 升序遍历。
    const ascending = [...items].reverse();
    for (const e of ascending) {
      // since 含端会把游标毫秒的事件重查回来；只跳过本毫秒内已见的 id，其余（含同毫秒新事件）照发。
      if (e.occurredAt === since && seenAtCursor.has(e.id)) continue;
      emit(e);
      if (e.occurredAt === since) {
        // 同为当前游标毫秒：记入去重集合，游标不动。
        seenAtCursor.add(e.id);
      } else {
        // occurredAt 更新（首事件 since 为 undefined，或严格大于游标毫秒）：推进游标，
        // 清空旧毫秒的 id 集合，只保留新游标毫秒的这一条。
        since = e.occurredAt;
        seenAtCursor = new Set([e.id]);
      }
    }
    if (opts.once) return;
    await sleep(intervalMs);
  }
}
