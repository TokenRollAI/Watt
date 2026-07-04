import { describe, expect, it, vi } from 'vitest';
import {
  type FeishuSendConfig,
  memoryTokenCache,
  sendFeishuMessage,
  type TokenCache,
} from '../src/adapter/send.ts';
import type { OutboundMessage } from '../src/adapter/decode.ts';

const MSG: OutboundMessage = { channel: 'feishu', target: 'oc_room', content: { text: 'hi' } };

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

function cfg(over: Partial<FeishuSendConfig> = {}): FeishuSendConfig {
  return {
    appId: 'cli_app',
    appSecret: 'secret',
    baseUrl: 'https://open.feishu.cn',
    fetchImpl: over.fetchImpl ?? (async () => jsonRes({ code: 0 })),
    cache: over.cache ?? memoryTokenCache(),
    ...over,
  };
}

describe('sendFeishuMessage — token 换取 + 投递', () => {
  it('fetches token then sends, returns channelMessageId', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('tenant_access_token')) return jsonRes({ code: 0, tenant_access_token: 'tk-1', expire: 7200 });
      return jsonRes({ code: 0, data: { message_id: 'om_1' } });
    }) as unknown as typeof fetch;
    const res = await sendFeishuMessage(cfg({ fetchImpl }), MSG);
    expect(res.ok).toBe(true);
    expect(res.channelMessageId).toBe('om_1');
    expect(calls[0]).toContain('tenant_access_token');
    expect(calls[1]).toContain('/open-apis/im/v1/messages');
  });

  it('reuses cached token on second send (single token fetch)', async () => {
    let tokenFetches = 0;
    const cache = memoryTokenCache();
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).includes('tenant_access_token')) {
        tokenFetches++;
        return jsonRes({ code: 0, tenant_access_token: 'tk', expire: 7200 });
      }
      return jsonRes({ code: 0, data: { message_id: 'om' } });
    }) as unknown as typeof fetch;
    await sendFeishuMessage(cfg({ fetchImpl, cache }), MSG);
    await sendFeishuMessage(cfg({ fetchImpl, cache }), MSG);
    expect(tokenFetches).toBe(1);
  });

  it('passes dedupeId as feishu uuid (idempotency)', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('tenant_access_token')) return jsonRes({ code: 0, tenant_access_token: 'tk', expire: 7200 });
      sentBody = JSON.parse(String(init?.body));
      return jsonRes({ code: 0, data: { message_id: 'om' } });
    }) as unknown as typeof fetch;
    await sendFeishuMessage(cfg({ fetchImpl }), MSG, { dedupeId: 'evt-42' });
    expect(sentBody.uuid).toBe('evt-42');
  });
});

describe('sendFeishuMessage — retryable 分类', () => {
  it('network error → retryable', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const res = await sendFeishuMessage(cfg({ fetchImpl }), MSG);
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(true);
  });

  it('business reject (bad receive_id) → non-retryable', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).includes('tenant_access_token')) return jsonRes({ code: 0, tenant_access_token: 'tk', expire: 7200 });
      return jsonRes({ code: 230001, msg: 'invalid receive_id' });
    }) as unknown as typeof fetch;
    const res = await sendFeishuMessage(cfg({ fetchImpl }), MSG);
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(false);
  });

  it('token invalid code → invalidates cache + retryable', async () => {
    const deletes: string[] = [];
    const cache: TokenCache = {
      ...memoryTokenCache(),
      async get() {
        return 'stale-token';
      },
      async delete(key) {
        deletes.push(key);
      },
    };
    const fetchImpl = (async () => jsonRes({ code: 99991663, msg: 'token expired' })) as unknown as typeof fetch;
    const res = await sendFeishuMessage(cfg({ fetchImpl, cache }), MSG);
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(true);
    expect(deletes).toContain('feishu:tenant_access_token');
  });

  it('missing app credentials → retryable error (thrown in token fetch)', async () => {
    const res = await sendFeishuMessage(cfg({ appId: undefined, appSecret: undefined }), MSG);
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(true);
    expect(res.error).toContain('not configured');
  });
});

describe('memoryTokenCache — TTL 过期', () => {
  it('expires entries past ttl', async () => {
    let t = 1000;
    const cache = memoryTokenCache(() => t);
    await cache.put('k', 'v', 10); // expiresAt = 1000 + 10_000
    expect(await cache.get('k')).toBe('v');
    t = 20_000;
    expect(await cache.get('k')).toBeNull();
  });
});
