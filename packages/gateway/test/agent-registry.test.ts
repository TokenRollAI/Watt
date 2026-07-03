/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import type { AgentDefinition, Subscription } from '@watt/core';
import { describe, expect, it } from 'vitest';
import {
  AgentRegistry,
  type SubscriptionSink,
  subscribeAgentSubscriptions,
} from '../src/agent/agent-registry.ts';

/**
 * AgentRegistry D1 单测（Proto §3.1 四动词 + §2.3 规则 1 订阅联动）。
 * oracle 硬编码自 Proto §3.1（AgentDefinition 形状 / List/Get/Write/Update）、§0.2（Page/limit）、
 * §2.3（subscriptions[] → EventRouter.subscribe，(definition,match) 去重幂等）。
 *
 * 表在 test/apply-migrations.ts 由 migrations-providers（含 0002_agent_registry）建好。
 * 每个用例用唯一 name 前缀避免跨用例串扰（D1 库跨用例持久）。
 */

let counter = 0;
function uniqueName(base: string): string {
  return `${base}-${counter++}`;
}

const D = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name: 'triage',
  description: 'a triage agent',
  runtime: 'light',
  entry: { kind: 'do-class', className: 'AgentInstance' },
  grants: [{ resources: ['agent://triage'], actions: ['spawn'] }],
  contextNamespaces: ['feedback/bugs'],
  toolScopes: ['observability'],
  ...over,
});

/** 内存 fake router：记录 subscribe 调用，listSubscriptions 返回已记录的。 */
function fakeRouter(): SubscriptionSink & { calls: Subscription[] } {
  const calls: Subscription[] = [];
  return {
    calls,
    async subscribe(sub: Subscription) {
      const id = `sub-${calls.length}`;
      calls.push({ ...sub, id });
      return { subscriptionId: id };
    },
    async listSubscriptions() {
      return { items: calls };
    },
  };
}

describe('AgentRegistry write / get / list (§3.1 / §0.2)', () => {
  it('write persists a definition and get returns it', async () => {
    const reg = new AgentRegistry(env.DB_PROVIDERS);
    const name = uniqueName('reg-basic');
    const def = D({ name, model: { preferred: 'glm-5.2', fallback: ['minimax-m3'] } });
    await reg.write(def);
    const got = await reg.get(name);
    expect(got).toEqual(def);
  });

  it('write is an idempotent upsert (re-write replaces fields)', async () => {
    const reg = new AgentRegistry(env.DB_PROVIDERS);
    const name = uniqueName('reg-upsert');
    await reg.write(D({ name, description: 'v1' }));
    await reg.write(D({ name, description: 'v2' }));
    const got = (await reg.get(name)) as AgentDefinition;
    expect(got.description).toBe('v2');
  });

  it('get on a missing name returns not_found', async () => {
    const reg = new AgentRegistry(env.DB_PROVIDERS);
    const got = await reg.get('nope-does-not-exist');
    expect(got).toMatchObject({ code: 'not_found' });
  });

  it('list returns written definitions', async () => {
    const reg = new AgentRegistry(env.DB_PROVIDERS);
    const name = uniqueName('reg-list');
    await reg.write(D({ name }));
    const page = await reg.list({ limit: 200 });
    expect('code' in page).toBe(false);
    if (!('code' in page)) {
      expect(page.items.some((d) => d.name === name)).toBe(true);
    }
  });
});

describe('AgentRegistry update (§3.1 / §0.4)', () => {
  it('update patches an existing definition', async () => {
    const reg = new AgentRegistry(env.DB_PROVIDERS);
    const name = uniqueName('reg-update');
    await reg.write(D({ name, description: 'before' }));
    const updated = await reg.update(name, { description: 'after' });
    expect((updated as AgentDefinition).description).toBe('after');
    expect((updated as AgentDefinition).name).toBe(name);
  });

  it('update on missing name returns not_found', async () => {
    const reg = new AgentRegistry(env.DB_PROVIDERS);
    const got = await reg.update('missing-name', { description: 'x' });
    expect(got).toMatchObject({ code: 'not_found' });
  });

  it('update rejects unknown keys (strict patch)', async () => {
    const reg = new AgentRegistry(env.DB_PROVIDERS);
    const name = uniqueName('reg-strict');
    await reg.write(D({ name }));
    const got = await reg.update(name, { bogusKey: 1 } as never);
    expect(got).toMatchObject({ code: 'invalid_argument' });
  });
});

describe('AgentRegistry subscription linkage (§2.3 rule 1 / §3.1)', () => {
  const withSubs = (name: string): AgentDefinition =>
    D({
      name,
      subscriptions: [
        { match: { type: 'im.*', channel: 'feishu' }, instanceBy: 'session' },
        { match: { type: 'webhook.received' }, instanceBy: 'event' },
      ],
    });

  it('write with subscriptions calls router.subscribe for each (agent sink)', async () => {
    const reg = new AgentRegistry(env.DB_PROVIDERS);
    const router = fakeRouter();
    const name = uniqueName('reg-sub');
    await reg.write(withSubs(name), router);
    expect(router.calls).toHaveLength(2);
    expect(router.calls[0]?.sink).toEqual({
      kind: 'agent',
      definition: name,
      instanceBy: 'session',
    });
    expect(router.calls[0]?.match).toEqual({ type: 'im.*', channel: 'feishu' });
    expect(router.calls[1]?.sink).toEqual({ kind: 'agent', definition: name, instanceBy: 'event' });
  });

  it('re-write is idempotent — does not accumulate duplicate subscriptions ((definition,match) dedupe)', async () => {
    const reg = new AgentRegistry(env.DB_PROVIDERS);
    const router = fakeRouter();
    const name = uniqueName('reg-sub-dedupe');
    await reg.write(withSubs(name), router);
    await reg.write(withSubs(name), router); // 第二次 Write：应全部去重跳过
    expect(router.calls).toHaveLength(2);
  });

  it('write without router does not attempt subscription (pure persistence)', async () => {
    const reg = new AgentRegistry(env.DB_PROVIDERS);
    const name = uniqueName('reg-no-router');
    // 不传 router：不应抛（纯持久化路径）。
    await expect(reg.write(withSubs(name))).resolves.toBeDefined();
  });

  it('subscribeAgentSubscriptions is a no-op when definition has no subscriptions', async () => {
    const router = fakeRouter();
    await subscribeAgentSubscriptions(D({ name: 'no-subs' }), router);
    expect(router.calls).toHaveLength(0);
  });
});
