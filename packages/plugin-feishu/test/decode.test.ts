import type { Event } from '@watt/core';
import { describe, expect, it } from 'vitest';
import { decodeFeishuEvent, type FeishuEvent } from '../src/adapter/decode.ts';

const NOW = () => '2026-07-04T00:00:00.000Z';

function messageEvent(over: Record<string, unknown> = {}): FeishuEvent {
  return {
    header: {
      event_id: 'ev-1',
      event_type: 'im.message.receive_v1',
      create_time: '1751587200000',
    },
    event: {
      sender: { sender_id: { open_id: 'ou_sender' } },
      message: {
        chat_id: 'oc_room',
        chat_type: 'group',
        message_type: 'text',
        content: '{"text":"@_user_1 hello"}',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'WattBot' }],
        ...over,
      },
    },
  };
}

describe('decodeFeishuEvent — im.message + mentions 展开', () => {
  it('expands mentions and restores placeholders in text', () => {
    const res = decodeFeishuEvent(messageEvent(), { now: NOW, botOpenId: 'ou_bot' });
    expect(res.skip).toBe(false);
    if (res.skip) return;
    const payload = res.event.payload as Record<string, unknown>;
    expect(payload.text).toBe('@WattBot hello');
    expect(payload.mentions).toEqual([{ key: '@_user_1', openId: 'ou_bot', name: 'WattBot' }]);
    expect(payload.mentionedBot).toBe(true);
    expect(payload.chatType).toBe('group');
    expect(res.event.session).toBe('feishu:chat:oc_room');
    expect(res.event.dedupeKey).toBe('ev-1');
    expect(res.event.channelUser).toEqual({ channel: 'feishu', userId: 'ou_sender' });
  });

  it('mentionedBot=false when the bot is not mentioned', () => {
    const ev = messageEvent({
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_other' }, name: 'Alice' }],
    });
    const res = decodeFeishuEvent(ev, { now: NOW, botOpenId: 'ou_bot' });
    if (res.skip) throw new Error('unexpected skip');
    expect((res.event.payload as Record<string, unknown>).mentionedBot).toBe(false);
  });

  it('p2p chat sets mentionedBot=true even without an explicit mention', () => {
    const ev = messageEvent({ chat_type: 'p2p', content: '{"text":"hi"}', mentions: undefined });
    const res = decodeFeishuEvent(ev, { now: NOW, botOpenId: 'ou_bot' });
    if (res.skip) throw new Error('unexpected skip');
    const payload = res.event.payload as Record<string, unknown>;
    expect(payload.mentionedBot).toBe(true);
    expect(payload.chatType).toBe('p2p');
  });

  it('no botOpenId → mentionedBot only from p2p (not from mention match)', () => {
    const res = decodeFeishuEvent(messageEvent(), { now: NOW });
    if (res.skip) throw new Error('unexpected skip');
    expect((res.event.payload as Record<string, unknown>).mentionedBot).toBe(false);
  });

  it('skips when chat_id missing', () => {
    const res = decodeFeishuEvent(messageEvent({ chat_id: undefined }), { now: NOW });
    expect(res.skip).toBe(true);
  });
});

describe('decodeFeishuEvent — card.action.trigger → im.action', () => {
  it('maps action.value.signal to payload.signal', () => {
    const raw: FeishuEvent = {
      header: { event_id: 'ev-2', event_type: 'card.action.trigger', create_time: '1751587200000' },
      event: {
        operator: { open_id: 'ou_op' },
        action: {
          value: {
            id: 'confirm-release:approve',
            signal: { taskId: 't1', checkpoint: 'confirm-release', decision: 'approve' },
          },
        },
        context: { open_chat_id: 'oc_room' },
      },
    };
    const res = decodeFeishuEvent(raw, { now: NOW });
    if (res.skip) throw new Error('unexpected skip');
    expect(res.event.type).toBe('im.action');
    const payload = res.event.payload as Record<string, unknown>;
    expect(payload.signal).toEqual({
      taskId: 't1',
      checkpoint: 'confirm-release',
      decision: 'approve',
    });
    expect(res.event.session).toBe('feishu:chat:oc_room');
    expect(res.event.channelUser).toEqual({ channel: 'feishu', userId: 'ou_op' });
  });
});

describe('decodeFeishuEvent — skip 面', () => {
  it('unknown event_type → skip', () => {
    const res = decodeFeishuEvent(
      { header: { event_type: 'contact.user.created_v3' }, event: {} },
      { now: NOW },
    );
    expect(res.skip).toBe(true);
  });
  it('missing header → skip', () => {
    const res = decodeFeishuEvent({ event: {} } as FeishuEvent, { now: NOW });
    expect(res.skip).toBe(true);
  });
});

// 类型断言：decode 产物是 Partial<Event>（source.channel='feishu'）。
const _typecheck: (e: Partial<Event>) => void = () => {};
void _typecheck;
