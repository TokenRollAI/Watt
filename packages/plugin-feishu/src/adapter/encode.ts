/**
 * 飞书出站编码（Encode，Proto §2.1）——从 @watt/core channel/feishu.ts 迁入。
 * OutboundMessage（渠道无关消息模型）→ 飞书 REST 报文（POST body：msg_type + content 字符串化 JSON）。
 *
 *  - 纯 text（无 actions）→ msg_type='text'，content='{"text":"..."}'。
 *  - 含 actions → msg_type='interactive'，交互卡片；每个 ActionButton 一个 button，button.value 带
 *    {id, signal?}（飞书 card.action.trigger 回调时 decode 侧还原 im.action.payload.signal）。
 *  - text 与 actions 并存（如 checkpoint 卡片）：卡片头部放 text 段落。
 */

import type { OutboundMessage } from '@watt/core';

/** 飞书 REST 报文（Encode 产物）。 */
export interface FeishuOutboundPayload {
  /** receive_id = OutboundMessage.target（chat_id；端点 query 已带 receive_id_type=chat_id）。 */
  receive_id: string;
  msg_type: 'text' | 'interactive';
  /** content 是字符串化 JSON（飞书 REST 约定）。 */
  content: string;
}

interface FeishuCardButton {
  tag: 'button';
  text: { tag: 'plain_text'; content: string };
  type: 'default';
  value: Record<string, unknown>;
}

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
