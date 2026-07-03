import { describe, expect, it } from 'vitest';
import type { OutboundMessage } from '../eventbus/types.ts';
import {
  decodeFeishuEvent,
  encodeFeishuOutbound,
  FEISHU_CHANNEL,
  FEISHU_MESSAGE_PATH,
  type FeishuEvent,
} from './feishu.ts';

/**
 * 飞书规约纯逻辑单测（Proto §2.1 push 型 / §1.1）。oracle 硬编码自飞书 im.message.receive_v1
 * / card.action.trigger 事件形状 + Proto 的 Event/OutboundMessage 字段义务。
 * 覆盖全字段义务（open_id→channelUser、event_id→dedupeKey、chat_id→session、create_time→ISO）
 * + 边界（缺 open_id、非 text 消息、含 actions 卡片、未知类型、畸形信封）。
 */

const NOW = '2026-07-03T00:00:00.000Z';
const now = () => NOW;

function messageEvent(overrides: Record<string, unknown> = {}): FeishuEvent {
  return {
    header: {
      event_id: 'evt-123',
      event_type: 'im.message.receive_v1',
      create_time: '1700000000000',
    },
    event: {
      sender: { sender_id: { open_id: 'ou_admin' } },
      message: {
        chat_id: 'oc_group1',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
      ...overrides,
    },
  };
}

describe('decodeFeishuEvent — im.message.receive_v1', () => {
  it('全字段义务：type/session/channelUser/dedupeKey/occurredAt/payload.text', () => {
    const r = decodeFeishuEvent(messageEvent(), { now });
    expect(r.skip).toBe(false);
    if (r.skip) return;
    const e = r.event;
    expect(e.type).toBe('im.message');
    expect(e.session).toBe('feishu:chat:oc_group1');
    expect(e.channelUser).toEqual({ channel: 'feishu', userId: 'ou_admin' });
    expect(e.dedupeKey).toBe('evt-123');
    expect(e.source).toEqual({ kind: 'im', channel: 'feishu' });
    // create_time 毫秒 → ISO（1700000000000 → 2023-11-14T...）。
    expect(e.occurredAt).toBe(new Date(1700000000000).toISOString());
    expect((e.payload as { text?: string }).text).toBe('hello');
    expect((e.payload as { messageType?: string }).messageType).toBe('text');
  });

  it('缺 open_id → 不产 channelUser（无触发者身份，平台走 anonymous），事件仍产出', () => {
    const r = decodeFeishuEvent(messageEvent({ sender: {} }), { now });
    expect(r.skip).toBe(false);
    if (r.skip) return;
    expect(r.event.channelUser).toBeUndefined();
    expect(r.event.session).toBe('feishu:chat:oc_group1');
  });

  it('sender 存在但 sender_id 非对象 → 无 open_id', () => {
    const r = decodeFeishuEvent(messageEvent({ sender: { sender_id: 'nope' } }), { now });
    expect(r.skip).toBe(false);
    if (r.skip) return;
    expect(r.event.channelUser).toBeUndefined();
  });

  it('sender 完全缺失（event 无 sender 键）→ 无 open_id', () => {
    const ev: FeishuEvent = {
      header: { event_id: 'e', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
      event: { message: { chat_id: 'oc_g', message_type: 'text', content: '{}' } },
    };
    const r = decodeFeishuEvent(ev, { now });
    expect(r.skip).toBe(false);
    if (r.skip) return;
    expect(r.event.channelUser).toBeUndefined();
  });

  it('message 有 chat_id 但无 message_type → messageType undefined', () => {
    const ev = messageEvent({
      message: { chat_id: 'oc_g', content: JSON.stringify({ text: 'x' }) },
    });
    const r = decodeFeishuEvent(ev, { now });
    expect(r.skip).toBe(false);
    if (r.skip) return;
    expect((r.event.payload as { messageType?: string }).messageType).toBeUndefined();
    expect((r.event.payload as { text?: string }).text).toBe('x');
  });

  it('非 text 消息（image）→ payload.text undefined，仍带 content + messageType', () => {
    const ev = messageEvent({
      message: {
        chat_id: 'oc_g',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'k' }),
      },
    });
    const r = decodeFeishuEvent(ev, { now });
    expect(r.skip).toBe(false);
    if (r.skip) return;
    expect((r.event.payload as { text?: string }).text).toBeUndefined();
    expect((r.event.payload as { messageType?: string }).messageType).toBe('image');
  });

  it('content 非 JSON → text undefined（parseMessageText catch 分支）', () => {
    const ev = messageEvent({
      message: { chat_id: 'oc_g', message_type: 'text', content: 'not-json{' },
    });
    const r = decodeFeishuEvent(ev, { now });
    expect(r.skip).toBe(false);
    if (r.skip) return;
    expect((r.event.payload as { text?: string }).text).toBeUndefined();
  });

  it('content 是合法 JSON 但无 text 字段 → text undefined', () => {
    const ev = messageEvent({
      message: { chat_id: 'oc_g', message_type: 'text', content: JSON.stringify({ other: 1 }) },
    });
    const r = decodeFeishuEvent(ev, { now });
    expect(r.skip).toBe(false);
    if (r.skip) return;
    expect((r.event.payload as { text?: string }).text).toBeUndefined();
  });

  it('content 非字符串 → text undefined（parseMessageText 首判）', () => {
    const ev = messageEvent({
      message: { chat_id: 'oc_g', message_type: 'text', content: { text: 'x' } },
    });
    const r = decodeFeishuEvent(ev, { now });
    expect(r.skip).toBe(false);
    if (r.skip) return;
    expect((r.event.payload as { text?: string }).text).toBeUndefined();
  });

  it('缺 chat_id → skip（无 session 不可路由）', () => {
    const ev = messageEvent({ message: { message_type: 'text', content: '{}' } });
    const r = decodeFeishuEvent(ev, { now });
    expect(r.skip).toBe(true);
    if (!r.skip) return;
    expect(r.reason).toContain('chat_id');
  });

  it('message 非对象 → skip（chat_id 缺失）', () => {
    const ev = messageEvent({ message: 'nope' });
    const r = decodeFeishuEvent(ev, { now });
    expect(r.skip).toBe(true);
  });

  it('event body 缺失 → skip', () => {
    const ev: FeishuEvent = { header: { event_type: 'im.message.receive_v1' } };
    const r = decodeFeishuEvent(ev, { now });
    expect(r.skip).toBe(true);
    if (!r.skip) return;
    expect(r.reason).toContain('event body missing');
  });

  it('缺 event_id → 无 dedupeKey', () => {
    const ev = messageEvent();
    delete ev.header?.event_id;
    const r = decodeFeishuEvent(ev, { now });
    expect(r.skip).toBe(false);
    if (r.skip) return;
    expect(r.event.dedupeKey).toBeUndefined();
  });

  it('create_time 缺省 → occurredAt 用 now 注入', () => {
    const ev = messageEvent();
    delete ev.header?.create_time;
    const r = decodeFeishuEvent(ev, { now });
    expect(r.skip).toBe(false);
    if (r.skip) return;
    expect(r.event.occurredAt).toBe(NOW);
  });

  it('create_time 非数字 → occurredAt 用 now（createTimeToIso 非法分支）', () => {
    const ev = messageEvent();
    if (ev.header) ev.header.create_time = 'abc';
    const r = decodeFeishuEvent(ev, { now });
    if (r.skip) return;
    expect(r.event.occurredAt).toBe(NOW);
  });

  it('create_time 为 0/负数 → occurredAt 用 now', () => {
    const ev = messageEvent();
    if (ev.header) ev.header.create_time = '0';
    const r = decodeFeishuEvent(ev, { now });
    if (r.skip) return;
    expect(r.event.occurredAt).toBe(NOW);
  });

  it('deps 缺省（不注入 now）→ 走内置时钟，不报错', () => {
    const ev = messageEvent();
    delete ev.header?.create_time;
    const r = decodeFeishuEvent(ev);
    expect(r.skip).toBe(false);
    if (r.skip) return;
    expect(typeof r.event.occurredAt).toBe('string');
  });
});

describe('decodeFeishuEvent — card.action.trigger', () => {
  function cardEvent(overrides: Record<string, unknown> = {}): FeishuEvent {
    return {
      header: {
        event_id: 'evt-c1',
        event_type: 'card.action.trigger',
        create_time: '1700000000000',
      },
      event: {
        operator: { open_id: 'ou_clicker' },
        action: {
          value: {
            id: 'confirm-release:approve',
            signal: { taskId: 't1', checkpoint: 'confirm-release', decision: 'approve' },
          },
        },
        context: { open_chat_id: 'oc_group1' },
        ...overrides,
      },
    };
  }

  it('type=im.action + payload.signal 还原 + channelUser + session + dedupeKey', () => {
    const r = decodeFeishuEvent(cardEvent(), { now });
    expect(r.skip).toBe(false);
    if (r.skip) return;
    const e = r.event;
    expect(e.type).toBe('im.action');
    expect(e.channelUser).toEqual({ channel: 'feishu', userId: 'ou_clicker' });
    expect(e.session).toBe('feishu:chat:oc_group1');
    expect(e.dedupeKey).toBe('evt-c1');
    const p = e.payload as { actionId?: string; signal?: unknown };
    expect(p.actionId).toBe('confirm-release:approve');
    expect(p.signal).toEqual({ taskId: 't1', checkpoint: 'confirm-release', decision: 'approve' });
  });

  it('无 signal 的按钮 → payload 只有 actionId', () => {
    const r = decodeFeishuEvent(
      cardEvent({
        action: { value: { id: 'plain' } },
        operator: { open_id: 'ou_x' },
        context: { open_chat_id: 'oc' },
      }),
      { now },
    );
    if (r.skip) return;
    const p = r.event.payload as { actionId?: string; signal?: unknown };
    expect(p.actionId).toBe('plain');
    expect(p.signal).toBeUndefined();
  });

  it('缺 action.value → payload 空对象', () => {
    const r = decodeFeishuEvent(cardEvent({ action: {}, operator: {}, context: {} }), { now });
    if (r.skip) return;
    expect(r.event.payload).toEqual({});
  });

  it('缺 context.open_chat_id → 无 session（im.action 靠 signal.taskId 路由）', () => {
    const r = decodeFeishuEvent(
      cardEvent({ action: { value: { id: 'x' } }, operator: { open_id: 'ou' }, context: {} }),
      { now },
    );
    if (r.skip) return;
    expect(r.event.session).toBeUndefined();
  });

  it('action 非对象 / operator 非对象 → value/openId 缺省', () => {
    const r = decodeFeishuEvent(cardEvent({ action: 'nope', operator: 'nope', context: 'nope' }), {
      now,
    });
    if (r.skip) return;
    expect(r.event.payload).toEqual({});
    expect(r.event.channelUser).toBeUndefined();
    expect(r.event.session).toBeUndefined();
  });

  it('event body 缺失 → skip', () => {
    const ev: FeishuEvent = { header: { event_type: 'card.action.trigger' } };
    const r = decodeFeishuEvent(ev, { now });
    expect(r.skip).toBe(true);
  });

  it('缺 event_id → 无 dedupeKey；缺 create_time → occurredAt 用 now', () => {
    const ev: FeishuEvent = {
      header: { event_type: 'card.action.trigger' },
      event: {
        action: { value: { id: 'x' } },
        operator: { open_id: 'ou' },
        context: { open_chat_id: 'oc' },
      },
    };
    const r = decodeFeishuEvent(ev, { now });
    expect(r.skip).toBe(false);
    if (r.skip) return;
    expect(r.event.dedupeKey).toBeUndefined();
    expect(r.event.occurredAt).toBe(NOW);
  });
});

describe('decodeFeishuEvent — 边界', () => {
  it('未知 event_type → skip（静默跳过，不报错）', () => {
    const r = decodeFeishuEvent(
      { header: { event_type: 'contact.user.updated_v3' }, event: {} },
      { now },
    );
    expect(r.skip).toBe(true);
    if (!r.skip) return;
    expect(r.reason).toContain('unhandled event_type');
  });

  it('缺 header → skip', () => {
    const r = decodeFeishuEvent({ event: {} }, { now });
    expect(r.skip).toBe(true);
    if (!r.skip) return;
    expect(r.reason).toContain('event_type missing');
  });

  it('header 存在但无 event_type → skip', () => {
    const r = decodeFeishuEvent({ header: { event_id: 'x' }, event: {} }, { now });
    expect(r.skip).toBe(true);
  });
});

describe('encodeFeishuOutbound', () => {
  function msg(content: OutboundMessage['content']): OutboundMessage {
    return { channel: FEISHU_CHANNEL, target: 'oc_group1', content };
  }

  it('纯 text → msg_type=text，content 字符串化 {text}', () => {
    const p = encodeFeishuOutbound(msg({ text: 'hi' }));
    expect(p.receive_id).toBe('oc_group1');
    expect(p.msg_type).toBe('text');
    expect(JSON.parse(p.content)).toEqual({ text: 'hi' });
  });

  it('无 text 无 actions → text 空串', () => {
    const p = encodeFeishuOutbound(msg({}));
    expect(p.msg_type).toBe('text');
    expect(JSON.parse(p.content)).toEqual({ text: '' });
  });

  it('含 actions → interactive 卡片，按钮 value 带 id + signal', () => {
    const p = encodeFeishuOutbound(
      msg({
        text: 'confirm?',
        actions: [
          {
            id: 'cp:approve',
            label: 'Approve',
            signal: { taskId: 't1', checkpoint: 'cp', decision: 'approve' },
          },
          {
            id: 'cp:reject',
            label: 'Reject',
            signal: { taskId: 't1', checkpoint: 'cp', decision: 'reject' },
          },
        ],
      }),
    );
    expect(p.msg_type).toBe('interactive');
    const card = JSON.parse(p.content) as { elements: Array<Record<string, unknown>> };
    // 首元素 = text div（div），末元素 = action（两个 button）。
    expect(card.elements[0]).toMatchObject({ tag: 'div' });
    const actionEl = card.elements[card.elements.length - 1] as {
      tag: string;
      actions: Array<{ value: Record<string, unknown> }>;
    };
    expect(actionEl.tag).toBe('action');
    expect(actionEl.actions).toHaveLength(2);
    expect(actionEl.actions[0]?.value).toEqual({
      id: 'cp:approve',
      signal: { taskId: 't1', checkpoint: 'cp', decision: 'approve' },
    });
  });

  it('含 actions 但无 text → 卡片无 div 段，只有 action', () => {
    const p = encodeFeishuOutbound(msg({ actions: [{ id: 'a', label: 'A' }] }));
    const card = JSON.parse(p.content) as { elements: Array<Record<string, unknown>> };
    expect(card.elements).toHaveLength(1);
    expect(card.elements[0]).toMatchObject({ tag: 'action' });
  });

  it('无 signal 的按钮 → value 只有 id', () => {
    const p = encodeFeishuOutbound(msg({ actions: [{ id: 'a', label: 'A' }] }));
    const card = JSON.parse(p.content) as {
      elements: Array<{ actions: Array<{ value: Record<string, unknown> }> }>;
    };
    expect(card.elements[0]?.actions[0]?.value).toEqual({ id: 'a' });
  });
});

describe('常量', () => {
  it('FEISHU_MESSAGE_PATH 带 receive_id_type=chat_id', () => {
    expect(FEISHU_MESSAGE_PATH).toContain('receive_id_type=chat_id');
  });
});
