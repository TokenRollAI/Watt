import { describe, expect, it, vi } from 'vitest';
import { createFeishuWorker, type FeishuWorkerEnv } from '../src/worker.ts';

const BASE = 'https://plugin.example.workers.dev';

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, init);
}
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('feishu worker — 元端点', () => {
  const worker = createFeishuWorker({ env: {} });
  it('GET /~describe → channel-adapter/v1', async () => {
    const res = await worker.fetch(req('/~describe'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      kind: 'channel-adapter',
      interfaceVersion: 'channel-adapter/v1',
      capabilities: ['push'],
    });
  });
  it('GET /~help lists Send/Encode', async () => {
    const body = (await (await worker.fetch(req('/~help'))).json()) as { commands: { cmd: string }[] };
    expect(body.commands.map((c) => c.cmd).sort()).toEqual(['Encode', 'Send']);
  });
  it('GET /healthz → healthy', async () => {
    expect(await (await worker.fetch(req('/healthz'))).json()).toEqual({ healthy: true });
  });
  it('unknown route → 404 WattError', async () => {
    const res = await worker.fetch(req('/nope'));
    expect(res.status).toBe(404);
    expect((await res.json()) as { code: string }).toHaveProperty('code', 'not_found');
  });
});

describe('feishu worker — POST /webhook/event（自持回调）', () => {
  const env: FeishuWorkerEnv = {
    // 明文模式（无 encrypt key）+ verification token。
    FEISHU_VERIFICATION_TOKEN: 'vt-1',
    WATT_PLUGIN_TOKEN: 'plugin-token-xyz',
    WATT_BASE_URL: 'https://watt.example.dev',
  };

  it('url_verification challenge is echoed', async () => {
    const worker = createFeishuWorker({ env });
    const body = JSON.stringify({ type: 'url_verification', challenge: 'ch-99', token: 'vt-1' });
    const res = await worker.fetch(req('/webhook/event', { method: 'POST', body }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'ch-99' });
  });

  it('rejects a mismatched verification token', async () => {
    const worker = createFeishuWorker({ env });
    const body = JSON.stringify({ type: 'url_verification', challenge: 'x', token: 'wrong' });
    const res = await worker.fetch(req('/webhook/event', { method: 'POST', body }));
    expect(res.status).toBe(401);
  });

  it('decodes an im.message and Publishes to the platform with plugin token', async () => {
    const captured: { url: string; body: unknown; auth: string | null } = { url: '', body: null, auth: null };
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = String(url);
      captured.auth = new Headers(init?.headers).get('authorization');
      captured.body = JSON.parse(String(init?.body));
      return jsonRes({ eventId: 'e-1' });
    }) as unknown as typeof fetch;
    const worker = createFeishuWorker({ env, fetchImpl, now: () => '2026-07-04T00:00:00.000Z' });
    const inbound = {
      header: { token: 'vt-1', event_id: 'ev-1', event_type: 'im.message.receive_v1', create_time: '1751587200000' },
      event: { sender: { sender_id: { open_id: 'ou_s' } }, message: { chat_id: 'oc_r', chat_type: 'group', content: '{"text":"hello"}' } },
    };
    const res = await worker.fetch(req('/webhook/event', { method: 'POST', body: JSON.stringify(inbound) }));
    expect(res.status).toBe(200);
    expect(captured.url).toBe('https://watt.example.dev/htbp/platform/event');
    expect(captured.auth).toBe('Bearer plugin-token-xyz');
    const call = captured.body as { tool: string; arguments: { event: { type: string; dedupeKey: string } } };
    expect(call.tool).toBe('Publish');
    expect(call.arguments.event.type).toBe('im.message');
    expect(call.arguments.event.dedupeKey).toBe('ev-1');
  });

  it('unknown event_type → 200 skipped, no Publish', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({})) as unknown as typeof fetch;
    const worker = createFeishuWorker({ env, fetchImpl });
    const inbound = { header: { token: 'vt-1', event_type: 'contact.user.created_v3' }, event: {} };
    const res = await worker.fetch(req('/webhook/event', { method: 'POST', body: JSON.stringify(inbound) }));
    expect(res.status).toBe(200);
    expect((await res.json()) as { skipped?: string }).toHaveProperty('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('feishu worker — POST /（§11.4 HTBP 面）', () => {
  const env: FeishuWorkerEnv = { FEISHU_APP_ID: 'cli_app', FEISHU_APP_SECRET: 'secret' };

  function feishuFetch(): typeof fetch {
    return (async (url: string | URL | Request) => {
      if (String(url).includes('tenant_access_token')) return jsonRes({ code: 0, tenant_access_token: 'tk', expire: 7200 });
      return jsonRes({ code: 0, data: { message_id: 'om_9' } });
    }) as unknown as typeof fetch;
  }

  it('Send with valid platform-token delivers and returns a SendReceipt', async () => {
    const worker = createFeishuWorker({ env, fetchImpl: feishuFetch(), verifyPlatformToken: async () => true });
    const res = await worker.fetch(
      req('/', {
        method: 'POST',
        headers: { authorization: 'Bearer good', 'x-watt-request-id': 'evt-77' },
        body: JSON.stringify({ tool: 'Send', arguments: { message: { channel: 'feishu', target: 'oc_r', content: { text: 'hi' } } } }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; channelMessageId: string }).toMatchObject({ ok: true, channelMessageId: 'om_9' });
  });

  it('rejects Send without a valid platform-token', async () => {
    const worker = createFeishuWorker({ env, verifyPlatformToken: async () => false });
    const res = await worker.fetch(
      req('/', { method: 'POST', headers: { authorization: 'Bearer bad' }, body: JSON.stringify({ tool: 'Send', arguments: { message: {} } }) }),
    );
    expect(res.status).toBe(401);
  });

  it('Encode returns a feishu REST payload', async () => {
    const worker = createFeishuWorker({ env, verifyPlatformToken: async () => true });
    const res = await worker.fetch(
      req('/', {
        method: 'POST',
        headers: { authorization: 'Bearer good' },
        body: JSON.stringify({ tool: 'Encode', arguments: { message: { channel: 'feishu', target: 'oc_r', content: { text: 'hi' } } } }),
      }),
    );
    const body = (await res.json()) as { receive_id: string; msg_type: string };
    expect(body.receive_id).toBe('oc_r');
    expect(body.msg_type).toBe('text');
  });

  it('unknown tool → 400', async () => {
    const worker = createFeishuWorker({ env, verifyPlatformToken: async () => true });
    const res = await worker.fetch(
      req('/', { method: 'POST', headers: { authorization: 'Bearer good' }, body: JSON.stringify({ tool: 'Nope' }) }),
    );
    expect(res.status).toBe(400);
  });

  it('Send retryable failure maps to 503', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const worker = createFeishuWorker({ env, fetchImpl, verifyPlatformToken: async () => true });
    const res = await worker.fetch(
      req('/', {
        method: 'POST',
        headers: { authorization: 'Bearer good' },
        body: JSON.stringify({ tool: 'Send', arguments: { message: { channel: 'feishu', target: 'oc_r', content: { text: 'x' } } } }),
      }),
    );
    expect(res.status).toBe(503);
    expect((await res.json()) as { retryable: boolean }).toHaveProperty('retryable', true);
  });
});
