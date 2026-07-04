/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import type { ChannelConfig, OutboundMessage } from '@watt/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultPluginSender, resolvePluginId } from '../src/event/plugin-sender.ts';
import { PluginRegistry } from '../src/plugin/plugin-registry.ts';

/**
 * 通用出站分发器单测（P1）——PluginRegistry 解析 + platform-token 签发 + binding/HTTPS 分发（§11.4）。
 * binding 路径经 miniflare serviceBindings 的 fakeFeishuPlugin（vitest.config，忠实 §11.4 Send 契约）真实穿透；
 * HTTPS 路径经注入 fetch 断言请求形状。WATT_JWT_PRIVATE_JWK 由 vitest 注入（真实 EdDSA 签发）。
 */

const CH = (over: Partial<ChannelConfig> = {}): ChannelConfig => ({
  id: 'feishu',
  adapter: 'feishu',
  enabled: true,
  settings: {},
  ...over,
});
const MSG = (target = 'oc_room'): OutboundMessage => ({
  channel: 'feishu',
  target,
  content: { text: 'hi' },
});

async function registerFeishuPlugin(over: Record<string, unknown> = {}): Promise<void> {
  const reg = new PluginRegistry(env.DB_PROVIDERS);
  await reg.write({
    id: 'channel-feishu',
    kind: 'channel-adapter',
    interfaceVersion: 'channel-adapter/v1',
    endpoint: 'binding:FEISHU_PLUGIN',
    auth: { kind: 'platform-token' },
    requiredGrants: [{ resources: ['event://'], actions: ['write'] }],
    healthPath: '/healthz',
    enabled: true,
    ...over,
  });
}

beforeEach(async () => {
  await env.DB_PROVIDERS.prepare('DELETE FROM plugin_registrations').run();
});

describe('resolvePluginId', () => {
  it('defaults to channel-<adapter>', () => {
    expect(resolvePluginId(CH({ adapter: 'feishu' }))).toBe('channel-feishu');
    expect(resolvePluginId(CH({ adapter: 'slack' }))).toBe('channel-slack');
  });
  it('settings.pluginId overrides the convention', () => {
    expect(resolvePluginId(CH({ adapter: 'feishu', settings: { pluginId: 'my-feishu' } }))).toBe(
      'my-feishu',
    );
  });
});

describe('defaultPluginSender — binding 分发（真实 service binding 穿透）', () => {
  it('resolves channel-feishu and delivers via service binding → ok + channelMessageId', async () => {
    await registerFeishuPlugin();
    const sender = defaultPluginSender(env);
    const res = await sender.send(CH(), MSG(), { requestId: 'evt-1', traceId: 't1' });
    expect(res.ok).toBe(true);
    expect(res.channelMessageId).toBe('om-evt-1'); // fake 回显 X-Watt-Request-Id（幂等键透传）
    expect(res.skipped).toBeUndefined();
  });

  it('retryable plugin failure → retryable=true (queue retry)', async () => {
    await registerFeishuPlugin();
    const sender = defaultPluginSender(env);
    const res = await sender.send(CH(), MSG('RETRY'), { requestId: 'evt-2' });
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(true);
  });

  it('non-retryable plugin failure → retryable=false (ack)', async () => {
    await registerFeishuPlugin();
    const sender = defaultPluginSender(env);
    const res = await sender.send(CH(), MSG('REJECT'), { requestId: 'evt-3' });
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(false);
  });

  it('no plugin registered → skipped', async () => {
    const sender = defaultPluginSender(env);
    const res = await sender.send(CH(), MSG(), { requestId: 'evt-4' });
    expect(res.skipped).toBe(true);
    expect(res.ok).toBe(false);
  });

  it('disabled plugin → skipped', async () => {
    await registerFeishuPlugin({ enabled: false });
    const sender = defaultPluginSender(env);
    const res = await sender.send(CH(), MSG(), { requestId: 'evt-5' });
    expect(res.skipped).toBe(true);
  });

  it('settings.pluginId routes to the overridden plugin id', async () => {
    const reg = new PluginRegistry(env.DB_PROVIDERS);
    await reg.write({
      id: 'my-feishu',
      kind: 'channel-adapter',
      interfaceVersion: 'channel-adapter/v1',
      endpoint: 'binding:FEISHU_PLUGIN',
      auth: { kind: 'platform-token' },
      requiredGrants: [],
      healthPath: '/healthz',
      enabled: true,
    });
    const sender = defaultPluginSender(env);
    const res = await sender.send(CH({ settings: { pluginId: 'my-feishu' } }), MSG(), {
      requestId: 'evt-6',
    });
    expect(res.ok).toBe(true);
  });

  it('unbound binding name → skipped', async () => {
    await registerFeishuPlugin({ endpoint: 'binding:NOPE_PLUGIN' });
    const sender = defaultPluginSender(env);
    const res = await sender.send(CH(), MSG(), { requestId: 'evt-7' });
    expect(res.skipped).toBe(true);
  });
});

describe('defaultPluginSender — HTTPS 分发（注入 fetch 断言请求形状）', () => {
  it('posts {tool:Send} with Bearer platform-token + X-Watt-Request-Id to the plugin endpoint', async () => {
    await registerFeishuPlugin({ endpoint: 'https://plugin.example.dev/' });
    const captured: { url?: string; headers?: Headers; body?: unknown } = {};
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = String(url);
      captured.headers = new Headers(init?.headers);
      captured.body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, channelMessageId: 'om-https' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const sender = defaultPluginSender(env, fetchImpl);
    const res = await sender.send(CH(), MSG(), { requestId: 'evt-8', traceId: 'tr-8' });

    expect(res.ok).toBe(true);
    expect(res.channelMessageId).toBe('om-https');
    expect(captured.url).toBe('https://plugin.example.dev'); // 去尾斜杠，POST base
    expect(captured.headers?.get('authorization')).toMatch(/^Bearer .+/);
    expect(captured.headers?.get('x-watt-request-id')).toBe('evt-8');
    expect(captured.headers?.get('x-watt-trace')).toBe('tr-8');
    const body = captured.body as { tool: string; arguments: { message: OutboundMessage } };
    expect(body.tool).toBe('Send');
    expect(body.arguments.message.target).toBe('oc_room');
  });

  it('network error → retryable', async () => {
    await registerFeishuPlugin({ endpoint: 'https://plugin.example.dev/' });
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const sender = defaultPluginSender(env, fetchImpl);
    const res = await sender.send(CH(), MSG(), { requestId: 'evt-9' });
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(true);
  });
});
