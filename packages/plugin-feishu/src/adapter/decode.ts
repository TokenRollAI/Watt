/**
 * 飞书事件 → 平台 Event 规约（Decode，Proto §2.1）——从 @watt/core channel/feishu.ts 迁入 + mentions 展开。
 *
 * 迁移背景（P1 飞书 plugin 化）：decode/encode 从 gateway/core 迁入本独立 plugin 包，使飞书渠道逻辑
 *   自包含、可独立发行。CLI `channel connect`（WS dev 路径）与 Worker webhook 宿主复用同一份纯逻辑。
 *
 * 新增（相对 core 原版）：mentions 展开——读 message.mentions[] 产 payload.mentions:[{key,openId,name}]、
 *   text 占位符（@_user_N）还原为 name、透传 chatType、比对 bot open_id 产 payload.mentionedBot。
 *   使 gateway lurker 触发判定改为渠道无关的 payload.mentionedBot/chatType（不再字面量 '@watt'）。
 *
 * 实现自由处（Proto 未细化，逐条声明，与 core 原版一致）：
 *  - 渠道标识固定 'feishu'；session 形状 `feishu:chat:<chat_id>`。
 *  - im.message.receive_v1 → im.message；card.action.trigger → im.action；未知 → skip。
 *  - occurredAt：header.create_time（毫秒串）→ ISO8601；缺省/非法用 now。
 *  - dedupeKey = header.event_id（飞书事件唯一 id，复用平台 24h 去重窗）。
 */

import type { Event, OutboundMessage } from '@watt/core';

/** 平台内飞书渠道固定标识。 */
export const FEISHU_CHANNEL = 'feishu';

/** 飞书 REST 发消息端点（相对路径，宿主拼 base = https://open.feishu.cn）。 */
export const FEISHU_MESSAGE_PATH = '/open-apis/im/v1/messages?receive_id_type=chat_id';

/** 飞书 WS/webhook 事件信封（v2 schema：header + event）。字段按需取，未列字段忽略。 */
export interface FeishuEvent {
  header?: {
    event_id?: string;
    event_type?: string;
    create_time?: string; // 毫秒时间戳字符串
    token?: string;
  };
  event?: unknown;
}

export type FeishuDecodeResult =
  | { skip: false; event: Partial<Event> }
  | { skip: true; reason: string };

/** decode 展开的一条 @提及。 */
export interface FeishuMention {
  /** 占位键（text 里的 @_user_N）。 */
  key: string;
  /** 被提及者 open_id。 */
  openId?: string;
  /** 被提及者展示名。 */
  name?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function createTimeToIso(createTime: string | undefined): string | undefined {
  if (typeof createTime !== 'string' || createTime.length === 0) return undefined;
  const ms = Number(createTime);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

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
 * 展开 message.mentions[]（飞书 @提及结构）：每项 {key:"@_user_1", id:{open_id,...}, name:"张三"}。
 * 产出 FeishuMention[]；同时判定是否 @了机器人（botOpenId 命中）。
 */
function expandMentions(
  message: Record<string, unknown>,
  botOpenId: string | undefined,
): { mentions: FeishuMention[]; mentionedBot: boolean } {
  const raw = Array.isArray(message.mentions) ? message.mentions : [];
  const mentions: FeishuMention[] = [];
  let mentionedBot = false;
  for (const m of raw) {
    if (!isRecord(m)) continue;
    const key = typeof m.key === 'string' ? m.key : undefined;
    if (key === undefined) continue;
    const id = isRecord(m.id) ? m.id : undefined;
    const openId = id && typeof id.open_id === 'string' ? id.open_id : undefined;
    const name = typeof m.name === 'string' ? m.name : undefined;
    const mention: FeishuMention = { key };
    if (openId !== undefined) mention.openId = openId;
    if (name !== undefined) mention.name = name;
    mentions.push(mention);
    if (botOpenId !== undefined && openId === botOpenId) mentionedBot = true;
  }
  return { mentions, mentionedBot };
}

/** 用 mentions 的 name 把 text 里的占位符（@_user_N）还原为可读文本（无 name 保留占位）。 */
function restorePlaceholders(text: string, mentions: FeishuMention[]): string {
  let out = text;
  for (const m of mentions) {
    if (m.name !== undefined) out = out.split(m.key).join(`@${m.name}`);
  }
  return out;
}

function decodeMessageReceive(
  header: NonNullable<FeishuEvent['header']>,
  event: unknown,
  now: () => string,
  botOpenId: string | undefined,
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
  const chatType = typeof message.chat_type === 'string' ? message.chat_type : undefined;
  const rawText = parseMessageText(message.content);

  const { mentions, mentionedBot } = expandMentions(message, botOpenId);
  const text = rawText !== undefined ? restorePlaceholders(rawText, mentions) : undefined;

  const payload: Record<string, unknown> = { text, messageType, content: message.content };
  if (mentions.length > 0) payload.mentions = mentions;
  if (chatType !== undefined) payload.chatType = chatType;
  // 单聊（p2p）等价于"面向机器人"——mentionedBot 直报 true，渠道无关触发判定据此简化。
  payload.mentionedBot = mentionedBot || chatType === 'p2p';

  const decoded: Partial<Event> = {
    type: 'im.message',
    session: `${FEISHU_CHANNEL}:chat:${chatId}`,
    payload,
    occurredAt: createTimeToIso(header.create_time) ?? now(),
    source: { kind: 'im', channel: FEISHU_CHANNEL },
    raw: event,
  };
  if (header.event_id !== undefined) decoded.dedupeKey = header.event_id;
  if (openId !== undefined) decoded.channelUser = { channel: FEISHU_CHANNEL, userId: openId };
  return { skip: false, event: decoded };
}

function decodeCardAction(
  header: NonNullable<FeishuEvent['header']>,
  event: unknown,
  now: () => string,
): FeishuDecodeResult {
  if (!isRecord(event)) return { skip: true, reason: 'im.action: event body missing' };
  const action = isRecord(event.action) ? event.action : undefined;
  const value = action && isRecord(action.value) ? action.value : undefined;

  const operator = isRecord(event.operator) ? event.operator : undefined;
  const openId = operator && typeof operator.open_id === 'string' ? operator.open_id : undefined;

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
  /** 机器人 open_id（用于判定 @机器人 → payload.mentionedBot；缺省则只靠 p2p/字面量兜底）。 */
  botOpenId?: string;
}

/**
 * 飞书事件 → 平台 Event 规约字段（Decode 义务，§2.1）。
 * 支持 im.message.receive_v1 / card.action.trigger；未知 event_type → skip；畸形信封 → skip。
 */
export function decodeFeishuEvent(raw: FeishuEvent, deps: DecodeDeps = {}): FeishuDecodeResult {
  const now = deps.now ?? (() => new Date().toISOString());
  const header = raw.header;
  if (!isRecord(header) || typeof header.event_type !== 'string') {
    return { skip: true, reason: 'feishu event: header.event_type missing' };
  }
  switch (header.event_type) {
    case 'im.message.receive_v1':
      return decodeMessageReceive(header, raw.event, now, deps.botOpenId);
    case 'card.action.trigger':
      return decodeCardAction(header, raw.event, now);
    default:
      return { skip: true, reason: `feishu event: unhandled event_type ${header.event_type}` };
  }
}

export type { OutboundMessage };
