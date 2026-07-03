import type { FeishuEvent } from '@watt/core';
import { describe, expect, it, vi } from 'vitest';
import {
  type ConnectLogger,
  nextBackoffMs,
  publishDecodedEvent,
  runSupervisor,
} from './connect.ts';

/**
 * `watt channel connect` 可测纯逻辑单测（decode→publish glue + 退避 + 监督重连）。
 * 真实 WSClient 连接不测（依赖飞书账号，留 @feishu R25）。
 * publish body 形状 oracle = gateway platform-event 路由（{tool:'Publish', arguments:{event}}）。
 */

const NOW = '2026-07-03T00:00:00.000Z';
const silentLogger: ConnectLogger = { info: () => {}, warn: () => {} };

function messageEvent(): FeishuEvent {
  return {
    header: {
      event_id: 'evt-1',
      event_type: 'im.message.receive_v1',
      create_time: '1700000000000',
    },
    event: {
      sender: { sender_id: { open_id: 'ou_x' } },
      message: { chat_id: 'oc_1', message_type: 'text', content: JSON.stringify({ text: 'hi' }) },
    },
  };
}

describe('publishDecodedEvent', () => {
  it('decode 成功 → Publish 到 /htbp/platform/event（body 形状断言）', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ eventId: 'e1' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const ok = await publishDecodedEvent(
      'https://p',
      'tok',
      messageEvent(),
      { fetch },
      silentLogger,
      () => NOW,
    );
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://p/htbp/platform/event');
    const body = calls[0]?.body as { tool: string; arguments: { event: Record<string, unknown> } };
    expect(body.tool).toBe('Publish');
    expect(body.arguments.event.type).toBe('im.message');
    expect(body.arguments.event.session).toBe('feishu:chat:oc_1');
    expect(body.arguments.event.dedupeKey).toBe('evt-1');
    expect(body.arguments.event.channelUser).toEqual({ channel: 'feishu', userId: 'ou_x' });
  });

  it('decode skip（未知类型）→ 不 Publish，返回 false', async () => {
    const fetch = vi.fn();
    const ok = await publishDecodedEvent(
      'https://p',
      'tok',
      { header: { event_type: 'contact.updated' }, event: {} },
      { fetch: fetch as unknown as typeof globalThis.fetch },
      silentLogger,
      () => NOW,
    );
    expect(ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('nextBackoffMs', () => {
  it('指数增长 + 封顶', () => {
    expect(nextBackoffMs(0, 1000, 30_000)).toBe(1000);
    expect(nextBackoffMs(1, 1000, 30_000)).toBe(2000);
    expect(nextBackoffMs(2, 1000, 30_000)).toBe(4000);
    expect(nextBackoffMs(10, 1000, 30_000)).toBe(30_000); // 封顶
  });
});

describe('runSupervisor', () => {
  it('断线后退避重连；成功连接后退避计数归零', async () => {
    const sleeps: number[] = [];
    let connects = 0;
    // 前两次正常返回（断线），第三次让 shouldStop 生效退出。
    const deps = {
      connectOnce: async () => {
        connects += 1;
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      logger: silentLogger,
      shouldStop: () => connects >= 3,
      minMs: 1000,
      maxMs: 30_000,
    };
    await runSupervisor(deps);
    expect(connects).toBe(3);
    // connectOnce 每次都成功（正常返回），attempt 归零 → 每次退避都是 minMs。
    expect(sleeps).toEqual([1000, 1000]);
  });

  it('连接抛错 → 退避递增（未成功不归零）', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const deps = {
      connectOnce: async () => {
        attempts += 1;
        throw new Error('connect failed');
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      logger: silentLogger,
      shouldStop: () => attempts >= 3,
      minMs: 1000,
      maxMs: 30_000,
    };
    await runSupervisor(deps);
    // 抛错不归零 attempt → 退避 1000, 2000（第三次 shouldStop 生效前）。
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('shouldStop 起始即 true → 不连接', async () => {
    let connects = 0;
    await runSupervisor({
      connectOnce: async () => {
        connects += 1;
      },
      sleep: async () => {},
      logger: silentLogger,
      shouldStop: () => true,
    });
    expect(connects).toBe(0);
  });
});
