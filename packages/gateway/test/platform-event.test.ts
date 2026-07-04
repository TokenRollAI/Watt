/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, SELF } from 'cloudflare:test';
import { importPrivateJwk, signUserToken, type TokenMeta } from '@watt/core';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetSeedGuardForTests } from '../src/authz/seed.ts';
import { PLATFORM_KID } from '../src/env.ts';
import type { EventRouter } from '../src/event/event-router.ts';
import {
  TEST_ADMIN_PRINCIPAL,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  TEST_PRIVATE_JWK,
} from './fixtures/test-key.ts';

/**
 * Platform API 事件/渠道端点服务端契约测试（HTTP 进 → EventStore/ChannelStore/EventRouter DO 出，
 * vitest-pool-workers 真实 workerd）。CLI 单测全 mock fetch，跨包契约无真实验证——本文件经 SELF.fetch
 * 真实打路由，锁 §2.2/§2.3/§11.3a 的形状与规约（尤其 Publish 的 source.kind='webhook' 规约）。
 * token/种子模式参照 platform.test.ts；DO 接线参照 integration-event-flow.test.ts。
 */

const META: TokenMeta = { issuer: TEST_JWT_ISSUER, audience: TEST_JWT_AUDIENCE };
const BASE = 'https://gateway.test';

let signAdmin: () => Promise<string>;
let signPlugin: (pluginId: string) => Promise<string>;

beforeAll(async () => {
  const { priv } = await importPrivateJwk(TEST_PRIVATE_JWK, PLATFORM_KID);
  signAdmin = () =>
    signUserToken({ principal: TEST_ADMIN_PRINCIPAL, roles: ['admin'], trace: 'tr-a' }, priv, META);
  // pluginToken 形状同 PluginRegistry.Write 签发（principal=plugin:<id>、roles=[]）。
  signPlugin = (pluginId: string) =>
    signUserToken({ principal: `plugin:${pluginId}`, roles: [], trace: 'tr-p' }, priv, META);
});

/** 单例 router stub（与生产 consumer/routes 的 idFromName('router') 同源）。 */
function routerStub(): DurableObjectStub<EventRouter> {
  return env.EVENT_ROUTER.get(env.EVENT_ROUTER.idFromName('router'));
}

async function clearDb() {
  await env.DB_EVENTS.prepare('DELETE FROM events').run();
  await env.DB_EVENTS.prepare('DELETE FROM channels').run();
  await env.DB_POLICIES.prepare('DELETE FROM policies').run();
  await env.DB_POLICIES.prepare('DELETE FROM identity_mappings').run();
}

/** 清空单例 router 订阅（DO 单例存活整个 isolate，跨用例隔离）。 */
async function clearSubscriptions() {
  const stub = routerStub();
  const page = await stub.listSubscriptions();
  for (const sub of page.items) {
    if (sub.id !== undefined) await stub.unsubscribe(sub.id);
  }
}

beforeEach(async () => {
  await clearDb();
  await clearSubscriptions();
  resetSeedGuardForTests();
});

/** POST 到 platform 端点的便捷封装。 */
async function post(path: string, token: string | null, call: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return SELF.fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(call) });
}

describe('POST /htbp/platform/event (§2.3)', () => {
  it('rejects a request with no token: 401', async () => {
    const res = await post('/htbp/platform/event', null, { tool: 'List', arguments: {} });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('permission_denied');
  });

  it('rejects an unknown tool with invalid_argument (400)', async () => {
    const token = await signAdmin();
    const res = await post('/htbp/platform/event', token, { tool: 'Frobnicate', arguments: {} });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_argument');
  });

  it('rejects Publish with an empty event as invalid_argument (400), not a 500', async () => {
    const token = await signAdmin();
    const res = await post('/htbp/platform/event', token, {
      tool: 'Publish',
      arguments: { event: {} },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; retryable: boolean };
    expect(body.code).toBe('invalid_argument');
    expect(body.retryable).toBe(false);
  });

  it('Publish a valid event → 200 {eventId}, and the stored event source.kind is coerced to webhook (§2.3)', async () => {
    const token = await signAdmin();
    // 调用方自报 source.kind='system'——§2.3 规约要求覆写为 'webhook'。
    const res = await post('/htbp/platform/event', token, {
      tool: 'Publish',
      arguments: {
        event: {
          source: { kind: 'system', channel: 'ext-sys' },
          type: 'external.ping',
          payload: { n: 1 },
        },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { eventId: string };
    expect(typeof body.eventId).toBe('string');
    expect(body.eventId.length).toBeGreaterThan(0);

    // 用 Get 读回，断言落库事件 source.kind 已被规约为 'webhook'（channel 保留）。
    const got = await post('/htbp/platform/event', token, {
      tool: 'Get',
      arguments: { eventId: body.eventId },
    });
    expect(got.status).toBe(200);
    const gotBody = (await got.json()) as {
      event: { source: { kind: string; channel?: string }; type: string };
    };
    expect(gotBody.event.source.kind).toBe('webhook');
    expect(gotBody.event.source.channel).toBe('ext-sys');
    expect(gotBody.event.type).toBe('external.ping');

    // List 也应能读回同一事件。
    const list = await post('/htbp/platform/event', token, {
      tool: 'List',
      arguments: { opts: {} },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { items: { id: string; source: { kind: string } }[] };
    const found = listBody.items.find((e) => e.id === body.eventId);
    expect(found).toBeDefined();
    expect(found?.source.kind).toBe('webhook');
  });

  it('Publish from an enabled channel-adapter plugin token keeps source.kind=im (§2.1 push 豁免, C5)', async () => {
    const admin = await signAdmin();
    // 授权 plugin 主体 Publish（platform://event manage）——pluginToken roles=[] 需显式策略。
    const pol = await post('/htbp/platform/policy', admin, {
      tool: 'Write',
      arguments: {
        policy: {
          id: 'pol-plugin-feishu-event',
          subject: 'plugin:channel-feishu',
          resource: 'platform://event',
          actions: ['manage'],
          effect: 'allow',
        },
      },
    });
    expect(pol.status).toBe(200);

    // channel-feishu 是内置种子 plugin（enabled）；以其 pluginToken Publish 一条 im 规约事件。
    const token = await signPlugin('channel-feishu');
    const res = await post('/htbp/platform/event', token, {
      tool: 'Publish',
      arguments: {
        event: {
          source: { kind: 'im', channel: 'feishu' },
          type: 'im.message',
          session: 'feishu:chat:oc_1',
          channelUser: { channel: 'feishu', userId: 'ou_x' },
          payload: { text: 'hi' },
        },
      },
    });
    expect(res.status).toBe(200);
    const { eventId } = (await res.json()) as { eventId: string };
    const got = await post('/htbp/platform/event', admin, {
      tool: 'Get',
      arguments: { eventId },
    });
    const gotBody = (await got.json()) as { event: { source: { kind: string } } };
    // push 型 adapter 自行规约（字段义务同 Decode）→ 保留 kind='im'，sourceKind:'im' 订阅可命中。
    expect(gotBody.event.source.kind).toBe('im');
  });

  it('Publish self-reporting kind=im from a non-plugin token is still coerced to webhook (§2.3)', async () => {
    const token = await signAdmin();
    const res = await post('/htbp/platform/event', token, {
      tool: 'Publish',
      arguments: {
        event: {
          source: { kind: 'im', channel: 'feishu' },
          type: 'im.message',
          payload: { text: 'spoof' },
        },
      },
    });
    expect(res.status).toBe(200);
    const { eventId } = (await res.json()) as { eventId: string };
    const got = await post('/htbp/platform/event', token, {
      tool: 'Get',
      arguments: { eventId },
    });
    const gotBody = (await got.json()) as { event: { source: { kind: string } } };
    expect(gotBody.event.source.kind).toBe('webhook');
  });

  it('Publish resolves channelUser to the mapped principal when principal is absent (§1 IdentityMapper.Resolve)', async () => {
    const token = await signAdmin();
    // 先绑定渠道身份（§6.3 写入口，挂 policy 端点的 MapIdentity）。
    const bind = await post('/htbp/platform/policy', token, {
      tool: 'MapIdentity',
      arguments: { channel: 'feishu-main', channelUserId: 'ou_alice', principal: 'user:alice' },
    });
    expect(bind.status).toBe(200);

    // channelUser 存在且 principal 缺省 → Publish 前应经 IdentityMapper.Resolve 补齐。
    const res = await post('/htbp/platform/event', token, {
      tool: 'Publish',
      arguments: {
        event: {
          source: { kind: 'webhook', channel: 'feishu-main' },
          type: 'im.message',
          channelUser: { channel: 'feishu-main', userId: 'ou_alice' },
          payload: { text: 'hello' },
        },
      },
    });
    expect(res.status).toBe(200);
    const { eventId } = (await res.json()) as { eventId: string };

    const got = await post('/htbp/platform/event', token, {
      tool: 'Get',
      arguments: { eventId },
    });
    expect(got.status).toBe(200);
    const gotBody = (await got.json()) as { event: { principal?: string } };
    expect(gotBody.event.principal).toBe('user:alice');
  });

  it('Publish resolves an unmapped channelUser to user:anonymous (§6.3)', async () => {
    const token = await signAdmin();
    const res = await post('/htbp/platform/event', token, {
      tool: 'Publish',
      arguments: {
        event: {
          source: { kind: 'webhook', channel: 'feishu-main' },
          type: 'im.message',
          channelUser: { channel: 'feishu-main', userId: 'ou_stranger' },
          payload: { text: 'hi' },
        },
      },
    });
    expect(res.status).toBe(200);
    const { eventId } = (await res.json()) as { eventId: string };

    const got = await post('/htbp/platform/event', token, {
      tool: 'Get',
      arguments: { eventId },
    });
    const gotBody = (await got.json()) as { event: { principal?: string } };
    expect(gotBody.event.principal).toBe('user:anonymous');
  });

  it('Get with a missing eventId → invalid_argument (400)', async () => {
    const token = await signAdmin();
    const res = await post('/htbp/platform/event', token, { tool: 'Get', arguments: {} });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_argument');
  });

  it('Subscribe → 200 {subscriptionId}; ListSubscriptions returns a Page; Unsubscribe → {deleted:true}', async () => {
    const token = await signAdmin();
    const sub = await post('/htbp/platform/event', token, {
      tool: 'Subscribe',
      arguments: {
        subscription: {
          match: { type: 'external.*' },
          sink: { kind: 'webhook', url: 'https://sink.test/hook' },
        },
      },
    });
    expect(sub.status).toBe(200);
    const subBody = (await sub.json()) as { subscriptionId: string };
    expect(typeof subBody.subscriptionId).toBe('string');

    const listSubs = await post('/htbp/platform/event', token, {
      tool: 'ListSubscriptions',
      arguments: { opts: {} },
    });
    expect(listSubs.status).toBe(200);
    const listSubsBody = (await listSubs.json()) as { items: { id?: string }[] };
    expect(Array.isArray(listSubsBody.items)).toBe(true);
    expect(listSubsBody.items.some((s) => s.id === subBody.subscriptionId)).toBe(true);

    const unsub = await post('/htbp/platform/event', token, {
      tool: 'Unsubscribe',
      arguments: { subscriptionId: subBody.subscriptionId },
    });
    expect(unsub.status).toBe(200);
    const unsubBody = (await unsub.json()) as { deleted: boolean };
    expect(unsubBody.deleted).toBe(true);
  });

  it('Subscribe with a malformed subscription (bad sink kind) → invalid_argument (400)', async () => {
    const token = await signAdmin();
    const res = await post('/htbp/platform/event', token, {
      tool: 'Subscribe',
      arguments: { subscription: { match: {}, sink: { kind: 'bogus' } } },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_argument');
  });

  it('Unsubscribe with a missing subscriptionId → invalid_argument (400)', async () => {
    const token = await signAdmin();
    const res = await post('/htbp/platform/event', token, {
      tool: 'Unsubscribe',
      arguments: {},
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_argument');
  });
});

describe('POST /htbp/platform/channel (§2.2)', () => {
  const CHANNEL = {
    id: 'ch-1',
    adapter: 'webhook',
    enabled: true,
    settings: { verifySecretRef: 'SOME_SECRET' },
  };

  it('rejects a request with no token: 401', async () => {
    const res = await post('/htbp/platform/channel', null, { tool: 'List', arguments: {} });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown tool with invalid_argument (400)', async () => {
    const token = await signAdmin();
    const res = await post('/htbp/platform/channel', token, { tool: 'Delete', arguments: {} });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_argument');
  });

  it('Write → 200 {channel}; Get reads it back; List includes it; Update mutates it (§2.2 four verbs)', async () => {
    const token = await signAdmin();
    const write = await post('/htbp/platform/channel', token, {
      tool: 'Write',
      arguments: { channel: CHANNEL },
    });
    expect(write.status).toBe(200);
    const writeBody = (await write.json()) as { channel: { id: string; adapter: string } };
    expect(writeBody.channel.id).toBe('ch-1');
    expect(writeBody.channel.adapter).toBe('webhook');

    const get = await post('/htbp/platform/channel', token, {
      tool: 'Get',
      arguments: { channelId: 'ch-1' },
    });
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as { channel: { id: string; enabled: boolean } };
    expect(getBody.channel.id).toBe('ch-1');
    expect(getBody.channel.enabled).toBe(true);

    const list = await post('/htbp/platform/channel', token, {
      tool: 'List',
      arguments: { opts: {} },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { items: { id: string }[] };
    expect(listBody.items.some((ch) => ch.id === 'ch-1')).toBe(true);

    const update = await post('/htbp/platform/channel', token, {
      tool: 'Update',
      arguments: { channelId: 'ch-1', patch: { enabled: false } },
    });
    expect(update.status).toBe(200);
    const updateBody = (await update.json()) as { channel: { enabled: boolean } };
    expect(updateBody.channel.enabled).toBe(false);
  });

  it('Write with a malformed config (missing required fields) → invalid_argument (400)', async () => {
    const token = await signAdmin();
    const res = await post('/htbp/platform/channel', token, {
      tool: 'Write',
      arguments: { channel: { id: 'bad', enabled: 'yes' } },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_argument');
  });

  it('Get with a missing channelId → invalid_argument (400)', async () => {
    const token = await signAdmin();
    const res = await post('/htbp/platform/channel', token, { tool: 'Get', arguments: {} });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_argument');
  });
});
