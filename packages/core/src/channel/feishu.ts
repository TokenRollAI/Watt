/**
 * 飞书 ChannelAdapter 规约纯逻辑（Proto §2.1 push 型 / §1.1 / decisions/feishu-websocket-channel.md）。
 * 无 I/O：入站 WS 事件 → 平台 Event 规约字段（decode）；出站 OutboundMessage → 飞书 REST 报文（encode）。
 *
 * 宿主约束（见决策记录）：飞书 WSClient 是 Node SDK，跑在 CLI 承载进程；本模块只做纯映射，
 * 连接/token/HTTP 均不在此。CLI connect 收到 WS 事件后调 decodeFeishuEvent 规约，再以 plugin token
 * 调 EventBus.Publish；gateway 出站接线调 encodeFeishuOutbound 拼报文后 fetch 飞书 REST。
 *
 * 实现自由处（Proto 未细化，逐条声明）：
 *  - 渠道标识固定 'feishu'（session/channelUser.channel/source.channel）。
 *  - session 形状 `feishu:chat:<chat_id>`（Architecture M1 举例，对齐 §1 `<channel>:<scope>:<id>`）。
 *  - im.message.receive_v1 → type='im.message'；card.action.trigger → type='im.action'。
 *  - 未知 event_type → 返回 { skip: true }（不报错、不产事件）：飞书事件类型是开放集合，
 *    未订阅/未建模的类型静默跳过比抛错更稳（承载进程不因单个未知事件断流）。
 *  - occurredAt：飞书 header.create_time 是毫秒时间戳字符串 → ISO8601；缺省/非法用 now 注入。
 *  - dedupeKey = header.event_id（飞书事件唯一 id，保证重投幂等，复用平台 24h 去重窗）。
 *  - 卡片按钮 value 载荷：ActionButton.signal 原样放进飞书卡片 button.value，飞书回调时
 *    在 card.action.trigger 的 action.value 里回传——decode 侧据此还原 im.action.payload.signal。
 */

import type { OutboundMessage } from '../eventbus/types.ts';
import type { Event } from '../types.ts';

/** 平台内飞书渠道固定标识。 */
export const FEISHU_CHANNEL = 'feishu';

/** 飞书 REST 发消息端点（相对路径，宿主拼 base = https://open.feishu.cn）。 */
export const FEISHU_MESSAGE_PATH = '/open-apis/im/v1/messages?receive_id_type=chat_id';

/** 飞书 WS 事件信封（v2 schema：header + event）。字段按需取，未列字段忽略。 */
export interface FeishuEvent {
  header?: {
    event_id?: string;
    event_type?: string;
    create_time?: string; // 毫秒时间戳字符串
  };
  event?: unknown;
}

/**
 * decode 结果：产出一条 Partial<Event>（skip=false），或明确跳过（未知类型/畸形）。
 * skip 时带 reason 供承载进程日志（不产事件、不报错）。
 */
export type FeishuDecodeResult =
  | { skip: false; event: Partial<Event> }
  | { skip: true; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 飞书 create_time（毫秒字符串）→ ISO8601；缺省/非法 → undefined（由调用方 now 补齐）。 */
function createTimeToIso(createTime: string | undefined): string | undefined {
  if (typeof createTime !== 'string' || createTime.length === 0) return undefined;
  const ms = Number(createTime);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

/**
 * im.message.receive_v1 的 message.content 是 JSON 字符串（如文本消息 '{"text":"hi"}'）。
 * 解析出 text 字段；非 JSON / 无 text → undefined（payload 仍带 raw content + message_type）。
 */
function parseMessageText(content: unknown): string | undefined {
  if (typeof content !== 'string') return undefined;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed) && typeof parsed.text === 'string') return parsed.text;
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * 解码 im.message.receive_v1（用户在群/私聊发消息）。
 * event.sender.sender_id.open_id → channelUser.userId；event.message.chat_id → session；
 * message.content JSON 里的 text → payload.text。缺 open_id 仍产事件（无触发者身份 → 平台走 anonymous），
 * 但缺 chat_id → 无法定位会话 → skip（无 session 的 im.message 不可路由）。
 */
function decodeMessageReceive(
  header: NonNullable<FeishuEvent['header']>,
  event: unknown,
  now: () => string,
): FeishuDecodeResult {
  if (!isRecord(event)) return { skip: true, reason: 'im.message: event body missing' };
  const message = isRecord(event.message) ? event.message : undefined;
  if (message === undefined || typeof message.chat_id !== 'string') {
    return { skip: true, reason: 'im.message: chat_id missing' };
  }
  const chatId = message.chat_id;

  const sender = isRecord(event.sender) ? event.sender : undefined;
  const senderId = sender && isRecord(sender.sender_id) ? sender.sender_id : undefined;
  const openId = senderId && typeof senderId.open_id === 'string' ? senderId.open_id : undefined;

  const messageType = typeof message.message_type === 'string' ? message.message_type : undefined;
  const text = parseMessageText(message.content);

  const decoded: Partial<Event> = {
    type: 'im.message',
    session: `${FEISHU_CHANNEL}:chat:${chatId}`,
    payload: { text, messageType, content: message.content },
    occurredAt: createTimeToIso(header.create_time) ?? now(),
    source: { kind: 'im', channel: FEISHU_CHANNEL },
    raw: event,
  };
  if (header.event_id !== undefined) decoded.dedupeKey = header.event_id;
  if (openId !== undefined) decoded.channelUser = { channel: FEISHU_CHANNEL, userId: openId };
  return { skip: false, event: decoded };
}

/**
 * 解码 card.action.trigger（用户点击交互卡片按钮）→ type='im.action'。
 * action.value 里回传的 signal 载荷（encode 侧塞入的 ActionButton.signal）映射到
 * payload.signal，使 §1.1 规则 2（im.action + signal → TaskManager.Signal）闭环。
 * 缺 chat_id 时 session 缺省（im.action 的路由靠 signal.taskId，不强依赖 session）。
 */
function decodeCardAction(
  header: NonNullable<FeishuEvent['header']>,
  event: unknown,
  now: () => string,
): FeishuDecodeResult {
  if (!isRecord(event)) return { skip: true, reason: 'im.action: event body missing' };
  const action = isRecord(event.action) ? event.action : undefined;
  const value = action && isRecord(action.value) ? action.value : undefined;

  // 触发者 open_id（飞书 card.action.trigger 的 operator.open_id）。
  const operator = isRecord(event.operator) ? event.operator : undefined;
  const openId = operator && typeof operator.open_id === 'string' ? operator.open_id : undefined;

  // action.value.signal 是 encode 侧塞入的 {taskId,checkpoint,decision}（可能整体存在）。
  const signal = value && isRecord(value.signal) ? value.signal : undefined;
  const actionId = value && typeof value.id === 'string' ? value.id : undefined;

  const payload: Record<string, unknown> = {};
  if (actionId !== undefined) payload.actionId = actionId;
  if (signal !== undefined) payload.signal = signal;

  const chatId =
    isRecord(event.context) && typeof event.context.open_chat_id === 'string'
      ? event.context.open_chat_id
      : undefined;

  const decoded: Partial<Event> = {
    type: 'im.action',
    payload,
    occurredAt: createTimeToIso(header.create_time) ?? now(),
    source: { kind: 'im', channel: FEISHU_CHANNEL },
    raw: event,
  };
  if (chatId !== undefined) decoded.session = `${FEISHU_CHANNEL}:chat:${chatId}`;
  if (header.event_id !== undefined) decoded.dedupeKey = header.event_id;
  if (openId !== undefined) decoded.channelUser = { channel: FEISHU_CHANNEL, userId: openId };
  return { skip: false, event: decoded };
}

export interface DecodeDeps {
  /** occurredAt 缺省时钟（缺省 now ISO）。 */
  now?: () => string;
}

/**
 * 飞书 WS 事件 → 平台 Event 规约字段（push 型 Decode 义务，§2.1）。
 * 支持 im.message.receive_v1 / card.action.trigger；未知 event_type → skip（静默跳过）。
 * 畸形信封（无 header/event_type）→ skip。
 */
export function decodeFeishuEvent(raw: FeishuEvent, deps: DecodeDeps = {}): FeishuDecodeResult {
  const now = deps.now ?? (() => new Date().toISOString());
  const header = raw.header;
  if (!isRecord(header) || typeof header.event_type !== 'string') {
    return { skip: true, reason: 'feishu event: header.event_type missing' };
  }
  switch (header.event_type) {
    case 'im.message.receive_v1':
      return decodeMessageReceive(header, raw.event, now);
    case 'card.action.trigger':
      return decodeCardAction(header, raw.event, now);
    default:
      return { skip: true, reason: `feishu event: unhandled event_type ${header.event_type}` };
  }
}

/** 飞书 REST 报文（Encode 产物）：POST body（含 msg_type + content）。 */
export interface FeishuOutboundPayload {
  /** receive_id = OutboundMessage.target（chat_id，端点 query 已带 receive_id_type=chat_id）。 */
  receive_id: string;
  msg_type: 'text' | 'interactive';
  /** content 是 JSON 字符串（飞书 REST 约定：content 字段传字符串化 JSON）。 */
  content: string;
}

/** 飞书交互卡片按钮（interactive card 的 action 元素）。 */
interface FeishuCardButton {
  tag: 'button';
  text: { tag: 'plain_text'; content: string };
  type: 'default';
  value: Record<string, unknown>;
}

/**
 * OutboundMessage → 飞书 REST 报文（Encode 义务，§2.1）。
 *  - 纯 text（无 actions）→ msg_type='text'，content='{"text":"..."}'。
 *  - 含 actions → msg_type='interactive'，构造交互卡片；每个 ActionButton 一个 button，
 *    button.value 带 {id, signal?}（回调时 decode 侧还原 im.action.payload.signal）。
 *  - text 与 actions 并存时（如 checkpoint 卡片：prompt + 选项按钮）：卡片头部放 text 段落。
 * blocks（富文本，各渠道自渲染）本轮不建模——含 blocks 无 actions 时退化为 text（取 text 字段）。
 */
export function encodeFeishuOutbound(message: OutboundMessage): FeishuOutboundPayload {
  const { target, content } = message;
  const actions = content.actions ?? [];

  if (actions.length === 0) {
    return {
      receive_id: target,
      msg_type: 'text',
      content: JSON.stringify({ text: content.text ?? '' }),
    };
  }

  const elements: unknown[] = [];
  if (content.text !== undefined) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: content.text } });
  }
  const buttons: FeishuCardButton[] = actions.map((action) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: action.label },
    type: 'default',
    // value 回传标识：id 必带；signal 存在则带（人类确认闭环载荷）。
    value:
      action.signal !== undefined ? { id: action.id, signal: action.signal } : { id: action.id },
  }));
  elements.push({ tag: 'action', actions: buttons });

  return {
    receive_id: target,
    msg_type: 'interactive',
    content: JSON.stringify({ config: { wide_screen_mode: true }, elements }),
  };
}
