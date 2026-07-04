import type { OutboundMessage } from '@watt/core';
import { describe, expect, it } from 'vitest';
import type { Bindings } from '../src/env.ts';
import { feishuSenderFromEnv } from '../src/event/feishu-sender.ts';

/**
 * 飞书出站 sender 接线单测（fake fetch 断言报文形状 + token 换取/缓存/失败留痕）。
 * encode 纯逻辑已在 core/channel/feishu.test.ts 全覆盖；这里只测接线（I/O 编排）。
 * 真实飞书调用留 @feishu 轮（不在此测）。
 */

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: Record<string, unknown>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const key = Object.keys(responses).find((k) => u.includes(k));
    const body = key ? responses[key] : { code: 0 };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

function memCache(): {
  get: (k: string) => Promise<string | null>;
  put: (k: string, v: string, ttl: number) => Promise<void>;
  store: Map<string, { value: string; ttl: number }>;
} {
  const store = new Map<string, { value: string; ttl: number }>();
  return {
    store,
    async get(k) {
      return store.get(k)?.value ?? null;
    },
    async put(k, v, ttl) {
      store.set(k, { value: v, ttl });
    },
  };
}

const env = { FEISHU_APP_ID: 'cli_app', FEISHU_APP_SECRET: 'secret' } as Bindings;

const textMsg: OutboundMessage = { channel: 'feishu', target: 'oc_room', content: { text: 'hi' } };

describe('feishuSenderFromEnv — token 换取 + 消息投递', () => {
  it('换取 tenant_access_token → 缓存 → POST 消息（报文形状断言）', async () => {
    const { fetch, calls } = fakeFetch({
      tenant_access_token: { code: 0, tenant_access_token: 'tat-xyz', expire: 7200 },
      'im/v1/messages': { code: 0, data: { message_id: 'om-1' } },
    });
    const cache = memCache();
    const sender = feishuSenderFromEnv(env, {
      fetchImpl: fetch,
      cacheGet: cache.get,
      cachePut: cache.put,
    });
    const r = await sender.send(textMsg);
    expect(r.ok).toBe(true);
    expect(r.messageId).toBe('om-1');

    // 第一次调用：token 换取；第二次：发消息。
    expect(calls[0]?.url).toContain('/open-apis/auth/v3/tenant_access_token/internal');
    const tokenBody = JSON.parse(calls[0]?.init.body as string);
    expect(tokenBody).toEqual({ app_id: 'cli_app', app_secret: 'secret' });

    expect(calls[1]?.url).toContain('/open-apis/im/v1/messages?receive_id_type=chat_id');
    expect((calls[1]?.init.headers as Record<string, string>).authorization).toBe('Bearer tat-xyz');
    const msgBody = JSON.parse(calls[1]?.init.body as string);
    expect(msgBody.receive_id).toBe('oc_room');
    expect(msgBody.msg_type).toBe('text');
    expect(JSON.parse(msgBody.content)).toEqual({ text: 'hi' });

    // 缓存写入了 token，TTL = expire - 60。
    expect(cache.store.get('feishu:tenant_access_token')?.value).toBe('tat-xyz');
    expect(cache.store.get('feishu:tenant_access_token')?.ttl).toBe(7140);
  });

  it('token 命中缓存 → 不再换取（只调发消息一次）', async () => {
    const { fetch, calls } = fakeFetch({
      'im/v1/messages': { code: 0, data: { message_id: 'om-2' } },
    });
    const cache = memCache();
    cache.store.set('feishu:tenant_access_token', { value: 'cached-tat', ttl: 100 });
    const sender = feishuSenderFromEnv(env, {
      fetchImpl: fetch,
      cacheGet: cache.get,
      cachePut: cache.put,
    });
    const r = await sender.send(textMsg);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/open-apis/im/v1/messages');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer cached-tat',
    );
  });

  it('含 actions → interactive 卡片报文', async () => {
    const { fetch, calls } = fakeFetch({
      tenant_access_token: { code: 0, tenant_access_token: 'tat', expire: 7200 },
      'im/v1/messages': { code: 0, data: { message_id: 'om' } },
    });
    const cache = memCache();
    const sender = feishuSenderFromEnv(env, {
      fetchImpl: fetch,
      cacheGet: cache.get,
      cachePut: cache.put,
    });
    await sender.send({
      channel: 'feishu',
      target: 'oc',
      content: { text: 'confirm?', actions: [{ id: 'cp:approve', label: 'Approve' }] },
    });
    const msgBody = JSON.parse(calls[1]?.init.body as string);
    expect(msgBody.msg_type).toBe('interactive');
    expect(JSON.parse(msgBody.content).elements).toBeDefined();
  });

  it('发消息返回 code!=0 → ok:false + error 留痕', async () => {
    const { fetch } = fakeFetch({
      tenant_access_token: { code: 0, tenant_access_token: 'tat', expire: 7200 },
      'im/v1/messages': { code: 230001, msg: 'bot not in chat' },
    });
    const cache = memCache();
    const sender = feishuSenderFromEnv(env, {
      fetchImpl: fetch,
      cacheGet: cache.get,
      cachePut: cache.put,
    });
    const r = await sender.send(textMsg);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('230001');
  });

  it('token 换取失败（code!=0）→ ok:false + error', async () => {
    const { fetch } = fakeFetch({
      tenant_access_token: { code: 99991663, msg: 'app not found' },
    });
    const cache = memCache();
    const sender = feishuSenderFromEnv(env, {
      fetchImpl: fetch,
      cacheGet: cache.get,
      cachePut: cache.put,
    });
    const r = await sender.send(textMsg);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('99991663');
  });

  it('缺 app_id/secret → ok:false（未配置）', async () => {
    const { fetch } = fakeFetch({});
    const cache = memCache();
    const sender = feishuSenderFromEnv({} as Bindings, {
      fetchImpl: fetch,
      cacheGet: cache.get,
      cachePut: cache.put,
    });
    const r = await sender.send(textMsg);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not configured');
  });

  it('expire 缺省 → TTL 用默认 7200-60；expire 极小 → TTL 兜底 60', async () => {
    const { fetch } = fakeFetch({
      tenant_access_token: { code: 0, tenant_access_token: 'tat', expire: 30 },
      'im/v1/messages': { code: 0, data: {} },
    });
    const cache = memCache();
    const sender = feishuSenderFromEnv(env, {
      fetchImpl: fetch,
      cacheGet: cache.get,
      cachePut: cache.put,
    });
    await sender.send(textMsg);
    // expire=30 → 30-60<0 → 兜底 60。
    expect(cache.store.get('feishu:tenant_access_token')?.ttl).toBe(60);
  });
});

describe('feishuSenderFromEnv — retryable 语义 + uuid 幂等（R27 关门 C2/C3）', () => {
  it('dedupeId → 发消息 body 带 uuid（飞书服务端去重键）', async () => {
    const { fetch, calls } = fakeFetch({
      tenant_access_token: { code: 0, tenant_access_token: 'tat', expire: 7200 },
      'im/v1/messages': { code: 0, data: { message_id: 'om-1' } },
    });
    const cache = memCache();
    const sender = feishuSenderFromEnv(env, {
      fetchImpl: fetch,
      cacheGet: cache.get,
      cachePut: cache.put,
    });
    const r = await sender.send(textMsg, { dedupeId: 'evt-42' });
    expect(r.ok).toBe(true);
    const msgCall = calls.find((c) => c.url.includes('im/v1/messages'));
    expect(JSON.parse(msgCall?.init.body as string).uuid).toBe('evt-42');
  });

  it('token 失效业务码（99991663）→ retryable:true + 作废缓存 token', async () => {
    const { fetch } = fakeFetch({
      tenant_access_token: { code: 0, tenant_access_token: 'tat-stale', expire: 7200 },
      'im/v1/messages': { code: 99991663, msg: 'token invalid' },
    });
    const cache = memCache();
    const deleted: string[] = [];
    const sender = feishuSenderFromEnv(env, {
      fetchImpl: fetch,
      cacheGet: cache.get,
      cachePut: cache.put,
      cacheDelete: async (k) => {
        deleted.push(k);
      },
    });
    const r = await sender.send(textMsg);
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
    expect(deleted).toContain('feishu:tenant_access_token');
  });

  it('业务拒绝（如 bot not in chat）→ retryable:false（重投必然同败）', async () => {
    const { fetch } = fakeFetch({
      tenant_access_token: { code: 0, tenant_access_token: 'tat', expire: 7200 },
      'im/v1/messages': { code: 230001, msg: 'bot not in chat' },
    });
    const cache = memCache();
    const sender = feishuSenderFromEnv(env, {
      fetchImpl: fetch,
      cacheGet: cache.get,
      cachePut: cache.put,
    });
    const r = await sender.send(textMsg);
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(false);
  });

  it('网络抛错 → retryable:true（瞬时故障重投可自愈）', async () => {
    const throwingFetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const cache = memCache();
    const sender = feishuSenderFromEnv(env, {
      fetchImpl: throwingFetch,
      cacheGet: cache.get,
      cachePut: cache.put,
    });
    const r = await sender.send(textMsg);
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.error).toContain('network down');
  });
});
