/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from 'cloudflare:test';
import type { Event, Subscription } from '@watt/core';
import { describe, expect, it } from 'vitest';
import type { EventRouter } from '../src/event/event-router.ts';

/**
 * EventRouter DO 单测（真实 workerd DO，vitest-pool-workers runInDurableObject）。
 * oracle 硬编码自 Proto §2.3（Subscribe/Unsubscribe/ListSubscriptions、订阅匹配 AND/通配/session、
 * instanceBy 三态 Session Mapper）/ §0.2（Page、limit 默认 50 钳 200）。
 *
 * 每个用例用唯一 idFromName 取独立 DO 实例（DO storage 跨用例持久，避免串扰）。
 */

let counter = 0;
function freshRouter() {
  const id = env.EVENT_ROUTER.idFromName(`router-test-${counter++}`);
  return env.EVENT_ROUTER.get(id);
}

const E = (over: Partial<Event> & { channel?: string } = {}): Event => {
  const { channel, ...rest } = over;
  return {
    id: 'e1',
    source: { kind: 'webhook', channel: channel ?? 'feishu' },
    type: 'webhook.received',
    session: 's1',
    payload: {},
    occurredAt: '2026-07-03T00:00:00.000Z',
    traceId: 't1',
    ...rest,
  };
};

const webhookSub = (match: Subscription['match']): Subscription => ({
  match,
  sink: { kind: 'webhook', url: 'https://sink.test/hook' },
});

describe('EventRouter subscribe / unsubscribe / listSubscriptions (§2.3 / §0.2)', () => {
  it('subscribe generates an id and listSubscriptions returns it', async () => {
    const stub = freshRouter();
    const { subscriptionId } = await runInDurableObject(stub, (instance: EventRouter) =>
      instance.subscribe(webhookSub({ type: 'im.*' })),
    );
    expect(typeof subscriptionId).toBe('string');
    expect(subscriptionId.length).toBeGreaterThan(0);

    const page = await runInDurableObject(stub, (instance: EventRouter) =>
      instance.listSubscriptions(),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe(subscriptionId);
    expect(page.items[0]?.match).toEqual({ type: 'im.*' });
  });

  it('unsubscribe removes the subscription (missing id is a no-op)', async () => {
    const stub = freshRouter();
    const { subscriptionId } = await runInDurableObject(stub, (instance: EventRouter) =>
      instance.subscribe(webhookSub({})),
    );
    await runInDurableObject(stub, (instance: EventRouter) => {
      instance.unsubscribe('does-not-exist'); // 幂等 no-op
      instance.unsubscribe(subscriptionId);
    });
    const page = await runInDurableObject(stub, (instance: EventRouter) =>
      instance.listSubscriptions(),
    );
    expect(page.items).toHaveLength(0);
  });

  it('listSubscriptions clamps limit to the 200 max (§0.2)', async () => {
    const stub = freshRouter();
    await runInDurableObject(stub, (instance: EventRouter) => {
      instance.subscribe(webhookSub({ type: 'a' }));
      instance.subscribe(webhookSub({ type: 'b' }));
    });
    const page = await runInDurableObject(stub, (instance: EventRouter) =>
      instance.listSubscriptions({ limit: 9999 }),
    );
    expect(page.items).toHaveLength(2);
  });
});

describe('EventRouter matchSubscriptions (§2.3 匹配语义)', () => {
  it('matches by type suffix wildcard (im.*)', async () => {
    const stub = freshRouter();
    await runInDurableObject(stub, (instance: EventRouter) => {
      instance.subscribe(webhookSub({ type: 'im.*' }));
      instance.subscribe(webhookSub({ type: 'webhook.*' }));
    });
    const hits = await runInDurableObject(stub, (instance: EventRouter) =>
      instance.matchSubscriptions(E({ type: 'im.message' })),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.match.type).toBe('im.*');
  });

  it('matches with AND semantics across type + channel + session', async () => {
    const stub = freshRouter();
    await runInDurableObject(stub, (instance: EventRouter) => {
      // 全部条件 AND：type + channel + session 都要命中。
      instance.subscribe(webhookSub({ type: 'im.*', channel: 'feishu', session: 's1' }));
      // channel 不同 → 不命中。
      instance.subscribe(webhookSub({ type: 'im.*', channel: 'slack', session: 's1' }));
    });
    const hits = await runInDurableObject(stub, (instance: EventRouter) =>
      instance.matchSubscriptions(E({ type: 'im.message', channel: 'feishu', session: 's1' })),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.match.channel).toBe('feishu');
  });

  it('empty match subscribes to everything', async () => {
    const stub = freshRouter();
    await runInDurableObject(stub, (instance: EventRouter) => instance.subscribe(webhookSub({})));
    const hits = await runInDurableObject(stub, (instance: EventRouter) =>
      instance.matchSubscriptions(E({ type: 'anything.at.all' })),
    );
    expect(hits).toHaveLength(1);
  });
});

describe('EventRouter resolveSessionInstance (§2.3 / §3.1 Session Mapper)', () => {
  it('session instanceBy maps the same session to the same instance key and persists it', async () => {
    const stub = freshRouter();
    const sink: Subscription['sink'] = {
      kind: 'agent',
      definition: 'triage',
      instanceBy: 'session',
    };
    const first = await runInDurableObject(stub, (instance: EventRouter) =>
      instance.resolveSessionInstance(sink, E({ session: 'chat-42' })),
    );
    const second = await runInDurableObject(stub, (instance: EventRouter) =>
      instance.resolveSessionInstance(sink, E({ session: 'chat-42' })),
    );
    expect('instanceKey' in first).toBe(true);
    if (!('instanceKey' in first) || !('instanceKey' in second)) {
      throw new Error('expected instanceKey');
    }
    expect(first.instanceKey).toBe(second.instanceKey);
    expect(first.instanceKey).toContain('agent:triage');
    expect(first.instanceKey).toContain('session:chat-42');
  });

  it('returns an error for agent session sink when event.session is absent', async () => {
    const stub = freshRouter();
    const sink: Subscription['sink'] = {
      kind: 'agent',
      definition: 'triage',
      instanceBy: 'session',
    };
    const res = await runInDurableObject(stub, (instance: EventRouter) =>
      instance.resolveSessionInstance(sink, E({ session: undefined })),
    );
    expect('error' in res).toBe(true);
  });

  it('returns an error for non-agent (webhook) sink', async () => {
    const stub = freshRouter();
    const res = await runInDurableObject(stub, (instance: EventRouter) =>
      instance.resolveSessionInstance({ kind: 'webhook', url: 'https://x.test' }, E()),
    );
    expect('error' in res).toBe(true);
  });
});
