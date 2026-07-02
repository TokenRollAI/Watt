import type { OutboundMessage, RawInbound } from '@watt/core';
import { computeSignature, WATT_HMAC } from '@watt/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { createWebhookAdapter } from '../src/event/adapters/webhook.ts';

/**
 * 内置 webhook ChannelAdapter 单测（Proto §2.1 全四义务，test-first）。
 *
 * 覆盖：
 *  - Verify：四拒收路径（header 缺失 / 格式非法 / 内容不匹配 / body 篡改）+ 通过 + base64 body。
 *  - Decode：义务字段齐全（type/session/payload/occurredAt/source.channel）+ dedupeKey 有/无 + payload 降级。
 *  - Encode / Send：RawOutbound 形状 + fetch mock 成功/失败路径。
 */

const SECRET = 'unit-secret';
const CHANNEL = 'demo-hook';
const BODY = '{"msg":"hi","n":1}';

let goodSig: string;

beforeAll(async () => {
  goodSig = await computeSignature(SECRET, BODY);
});

function inbound(
  overrides: Partial<RawInbound> & { headers?: Record<string, string> },
): RawInbound {
  return {
    headers: {},
    bodyRaw: BODY,
    encoding: 'utf8',
    ...overrides,
  };
}

describe('createWebhookAdapter — Verify', () => {
  const adapter = createWebhookAdapter({ secret: SECRET, channelId: CHANNEL });

  it('accepts a request with a valid signature', async () => {
    const req = inbound({ headers: { [WATT_HMAC.signatureHeader]: goodSig } });
    expect(await adapter.Verify(req)).toBe(true);
  });

  it('normalizes header name case-insensitively', async () => {
    const req = inbound({ headers: { 'X-Watt-Signature': goodSig } });
    expect(await adapter.Verify(req)).toBe(true);
  });

  it('rejects when the signature header is missing', async () => {
    expect(await adapter.Verify(inbound({}))).toBe(false);
  });

  it('rejects a malformed signature header (no sha256= prefix)', async () => {
    const req = inbound({ headers: { [WATT_HMAC.signatureHeader]: 'deadbeef' } });
    expect(await adapter.Verify(req)).toBe(false);
  });

  it('rejects a signature computed with the wrong secret (content mismatch)', async () => {
    const wrong = await computeSignature('nope', BODY);
    const req = inbound({ headers: { [WATT_HMAC.signatureHeader]: wrong } });
    expect(await adapter.Verify(req)).toBe(false);
  });

  it('rejects when the body was tampered after signing', async () => {
    const req = inbound({ headers: { [WATT_HMAC.signatureHeader]: goodSig }, bodyRaw: `${BODY} ` });
    expect(await adapter.Verify(req)).toBe(false);
  });

  it('verifies over base64-decoded bytes byte-exactly', async () => {
    const b64 = Buffer.from(BODY, 'utf8').toString('base64');
    const sig = await computeSignature(SECRET, new Uint8Array(Buffer.from(BODY, 'utf8')));
    const req: RawInbound = {
      headers: { [WATT_HMAC.signatureHeader]: sig },
      bodyRaw: b64,
      encoding: 'base64',
    };
    expect(await adapter.Verify(req)).toBe(true);
  });
});

describe('createWebhookAdapter — Decode', () => {
  const adapter = createWebhookAdapter({
    secret: SECRET,
    channelId: CHANNEL,
    now: () => '2026-07-03T12:00:00.000Z',
  });

  it('produces one event with all obligation fields', () => {
    const events = adapter.Decode(inbound({}));
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e?.type).toBe('webhook.received');
    expect(e?.session).toBe(`webhook:${CHANNEL}:${CHANNEL}`);
    expect(e?.payload).toEqual({ msg: 'hi', n: 1 });
    expect(e?.occurredAt).toBe('2026-07-03T12:00:00.000Z');
    expect(e?.source).toEqual({ kind: 'webhook', channel: CHANNEL });
  });

  it('sets dedupeKey from x-watt-delivery-id when present', () => {
    const req = inbound({ headers: { [WATT_HMAC.deliveryHeader]: 'del-42' } });
    expect(adapter.Decode(req)[0]?.dedupeKey).toBe(`webhook:${CHANNEL}:del-42`);
  });

  it('normalizes the delivery-id header case-insensitively', () => {
    const req = inbound({ headers: { 'X-Watt-Delivery-Id': 'del-99' } });
    expect(adapter.Decode(req)[0]?.dedupeKey).toBe(`webhook:${CHANNEL}:del-99`);
  });

  it('omits dedupeKey when no delivery id is present', () => {
    expect(adapter.Decode(inbound({}))[0]?.dedupeKey).toBeUndefined();
  });

  it('degrades payload to {text: bodyRaw} on JSON parse failure', () => {
    const req = inbound({ bodyRaw: 'not-json' });
    expect(adapter.Decode(req)[0]?.payload).toEqual({ text: 'not-json' });
  });

  it('does not set channelUser (generic webhook has no standard trigger identity)', () => {
    expect(adapter.Decode(inbound({}))[0]?.channelUser).toBeUndefined();
  });
});

describe('createWebhookAdapter — Encode', () => {
  const adapter = createWebhookAdapter({ secret: SECRET, channelId: CHANNEL });

  it('maps OutboundMessage to RawOutbound with endpoint=target and JSON body', () => {
    const msg: OutboundMessage = {
      channel: CHANNEL,
      target: 'https://sink.example/webhook',
      content: { text: 'pong' },
    };
    const raw = adapter.Encode(msg);
    expect(raw.endpoint).toBe('https://sink.example/webhook');
    expect(raw.headers['content-type']).toBe('application/json');
    expect(JSON.parse(raw.body as string)).toEqual({ text: 'pong' });
  });
});

describe('createWebhookAdapter — Send', () => {
  it('returns ok:true when fetch responds 2xx', async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      seen = { url: String(url), init };
      return new Response('ok', { status: 200 });
    };
    const adapter = createWebhookAdapter({ secret: SECRET, channelId: CHANNEL, fetchImpl });
    const receipt = await adapter.Send({
      endpoint: 'https://sink.example/webhook',
      headers: { 'content-type': 'application/json' },
      body: '{"x":1}',
    });
    expect(receipt.ok).toBe(true);
    expect(receipt.error).toBeUndefined();
    expect(seen?.url).toBe('https://sink.example/webhook');
    expect(seen?.init?.method).toBe('POST');
  });

  it('returns ok:false with an unavailable WattError on non-2xx', async () => {
    const fetchImpl: typeof fetch = async () => new Response('boom', { status: 500 });
    const adapter = createWebhookAdapter({ secret: SECRET, channelId: CHANNEL, fetchImpl });
    const receipt = await adapter.Send({
      endpoint: 'https://sink.example/webhook',
      headers: {},
      body: '{}',
    });
    expect(receipt.ok).toBe(false);
    expect(receipt.error?.code).toBe('unavailable');
  });

  it('returns ok:false with an unavailable WattError when fetch throws', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('network down');
    };
    const adapter = createWebhookAdapter({ secret: SECRET, channelId: CHANNEL, fetchImpl });
    const receipt = await adapter.Send({
      endpoint: 'https://sink.example/x',
      headers: {},
      body: '',
    });
    expect(receipt.ok).toBe(false);
    expect(receipt.error?.code).toBe('unavailable');
    expect(receipt.error?.message).toContain('network down');
  });
});
