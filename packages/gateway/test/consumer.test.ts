/// <reference types="@cloudflare/vitest-pool-workers/types" />
import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
  runInDurableObject,
} from 'cloudflare:test';
import type { Event, Subscription } from '@watt/core';
import { describe, expect, it } from 'vitest';
import { ChannelStore } from '../src/event/channel-store.ts';
import {
  type AgentDeliverer,
  type ConsumerDeps,
  handleQueue,
  noopAgentDeliverer,
  type TaskSignaler,
  type WebhookDeliverer,
} from '../src/event/consumer.ts';
import type { EventQueueSender } from '../src/event/event-bus.ts';
import type { EventRouter } from '../src/event/event-router.ts';
import { EventStore } from '../src/event/event-store.ts';

// DurableObjectStub 用 ambient global（与 env.EVENT_ROUTER.get 返回同源）。

/**
 * Queue consumer 单测（真实 EVENT_ROUTER DO stub + 注入 webhook deliverer）。
 * batch 用 createMessageBatch 构造，ack/retry 经 getQueueResult 断言。
 * oracle 硬编码自 Proto §2.3（订阅匹配后分发：webhook 投递、agent/task 占位）
 * 与 §1.1（human-in-the-loop 内置路由）/§2.3 规则 2（im.bot_joined 自动订阅）。
 */

const QUEUE = 'watt-events';

let counter = 0;
function freshRouterStub(): DurableObjectStub<EventRouter> {
  const id = env.EVENT_ROUTER.idFromName(`consumer-test-${counter++}`);
  return env.EVENT_ROUTER.get(id);
}

/** 内存 webhook deliverer：记录投递；可配置为对某 URL 抛错模拟失败。 */
function memDeliverer(
  failUrls: Set<string> = new Set(),
): WebhookDeliverer & { delivered: Array<{ url: string; event: Event }> } {
  return {
    delivered: [],
    async deliver(url: string, event: Event) {
      if (failUrls.has(url)) throw new Error('sink down');
      this.delivered.push({ url, event });
    },
  };
}

/** 内存 queue sender：记录 systemPublish 送出的事件（内置 task.checkpoint 规则断言用）。 */
function memQueue(): EventQueueSender & { sent: Event[] } {
  return {
    sent: [],
    async send(event: Event) {
      this.sent.push(event);
    },
  };
}

/** 记录 TaskSignaler 调用（im.action 规则断言用）。 */
function recordingSignaler(): TaskSignaler & {
  calls: Array<{ taskId: string; checkpoint: string; decision: string }>;
} {
  return {
    calls: [],
    async signal(taskId, args) {
      this.calls.push({ taskId, checkpoint: args.checkpoint, decision: args.decision });
    },
  };
}

/**
 * 组装 ConsumerDeps：deliverer/router 必填，其余内置规则依赖有确定性默认值
 * （genId/now/genTraceId 固定，便于断言 systemPublish 产出的事件字段）。
 */
function makeDeps(over: {
  deliverer: WebhookDeliverer;
  router: () => DurableObjectStub<EventRouter>;
  queue?: EventQueueSender;
  channels?: ChannelStore;
  signaler?: TaskSignaler;
  agent?: AgentDeliverer;
}): ConsumerDeps {
  return {
    deliverer: over.deliverer,
    router: over.router,
    store: new EventStore(env.DB_EVENTS),
    queue: over.queue ?? memQueue(),
    channels: over.channels ?? new ChannelStore(env.DB_EVENTS),
    signaler: over.signaler ?? recordingSignaler(),
    agent: over.agent ?? noopAgentDeliverer,
    genId: () => 'gen-id',
    now: () => '2026-07-03T00:00:00.000Z',
    genTraceId: () => 'gen-trace',
  };
}

const E = (over: Partial<Event> = {}): Event => ({
  id: 'e1',
  source: { kind: 'webhook', channel: 'feishu' },
  type: 'webhook.received',
  session: 's1',
  payload: { hello: 'world' },
  occurredAt: '2026-07-03T00:00:00.000Z',
  traceId: 't1',
  ...over,
});

async function seedSub(stub: DurableObjectStub<EventRouter>, sub: Subscription): Promise<void> {
  await stub.subscribe(sub);
}

describe('Queue consumer webhook sink (§2.3)', () => {
  it('delivers a matching event to the webhook sink and acks the message', async () => {
    const stub = freshRouterStub();
    await seedSub(stub, {
      match: { type: 'webhook.*' },
      sink: { kind: 'webhook', url: 'https://sink.test/a' },
    });
    const deliverer = memDeliverer();
    const deps = makeDeps({ deliverer, router: () => stub });

    const batch = createMessageBatch(QUEUE, [
      { id: 'm1', timestamp: new Date(), body: E(), attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);

    expect(deliverer.delivered).toHaveLength(1);
    expect(deliverer.delivered[0]?.url).toBe('https://sink.test/a');
    expect(result.explicitAcks).toContain('m1');
  });

  it('retries the message when the webhook sink delivery fails', async () => {
    const stub = freshRouterStub();
    await seedSub(stub, { match: {}, sink: { kind: 'webhook', url: 'https://sink.test/down' } });
    const deliverer = memDeliverer(new Set(['https://sink.test/down']));
    const deps = makeDeps({ deliverer, router: () => stub });

    const batch = createMessageBatch(QUEUE, [
      { id: 'm2', timestamp: new Date(), body: E(), attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);

    expect(result.retryMessages.map((r: { msgId: string }) => r.msgId)).toContain('m2');
    expect(result.explicitAcks).not.toContain('m2');
  });

  it('acks when no subscription matches (nothing to deliver)', async () => {
    const stub = freshRouterStub();
    await seedSub(stub, {
      match: { type: 'im.*' },
      sink: { kind: 'webhook', url: 'https://sink.test/a' },
    });
    const deliverer = memDeliverer();
    const deps = makeDeps({ deliverer, router: () => stub });

    const batch = createMessageBatch(QUEUE, [
      { id: 'm3', timestamp: new Date(), body: E({ type: 'webhook.received' }), attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);

    expect(deliverer.delivered).toHaveLength(0);
    expect(result.explicitAcks).toContain('m3');
  });
});

describe('Queue consumer agent / task sink placeholders (§2.3, delivery deferred)', () => {
  it('acks an agent sink event and persists the sticky session→instance mapping', async () => {
    const stub = freshRouterStub();
    await seedSub(stub, {
      match: { type: 'webhook.*' },
      sink: { kind: 'agent', definition: 'triage', instanceBy: 'session' },
    });
    const deliverer = memDeliverer();
    const deps = makeDeps({ deliverer, router: () => stub });

    const batch = createMessageBatch(QUEUE, [
      { id: 'm4', timestamp: new Date(), body: E({ session: 'chat-1' }), attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);

    // agent sink 占位不抛错、不阻塞 → 消息 ack；webhook deliverer 未被触碰。
    expect(deliverer.delivered).toHaveLength(0);
    expect(result.explicitAcks).toContain('m4');

    // 粘性映射真的落库（防 agent 分支被删成 no-op 测试仍绿）：查 session_instances 表。
    const rows = await runInDurableObject(stub, (_instance: EventRouter, state) =>
      state.storage.sql
        .exec('SELECT instance_key, definition, session FROM session_instances')
        .toArray(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.definition).toBe('triage');
    expect(rows[0]?.session).toBe('chat-1');
  });

  it('acks a task sink event (delivery deferred to Phase 5)', async () => {
    const stub = freshRouterStub();
    await seedSub(stub, { match: {}, sink: { kind: 'task', workflow: 'wf-1' } });
    const deliverer = memDeliverer();
    const deps = makeDeps({ deliverer, router: () => stub });

    const batch = createMessageBatch(QUEUE, [
      { id: 'm5', timestamp: new Date(), body: E(), attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toContain('m5');
  });
});

describe('Queue consumer malformed message (defensive)', () => {
  it('drops (acks) a message whose body is not a valid Event', async () => {
    const stub = freshRouterStub();
    const deliverer = memDeliverer();
    const deps = makeDeps({ deliverer, router: () => stub });

    const batch = createMessageBatch(QUEUE, [
      { id: 'm6', timestamp: new Date(), body: { not: 'an-event' }, attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toContain('m6');
  });
});

describe('Queue consumer multi-sink partial failure (§2.3 消息生命周期)', () => {
  it('retries the message when one of two webhook sinks fails, and the healthy sink still received it once', async () => {
    const stub = freshRouterStub();
    // 两个 webhook sink 都匹配同一事件：一个健康、一个宕机。
    await seedSub(stub, { match: {}, sink: { kind: 'webhook', url: 'https://sink.test/ok' } });
    await seedSub(stub, { match: {}, sink: { kind: 'webhook', url: 'https://sink.test/down' } });
    const deliverer = memDeliverer(new Set(['https://sink.test/down']));
    const deps = makeDeps({ deliverer, router: () => stub });

    const batch = createMessageBatch(QUEUE, [
      { id: 'm7', timestamp: new Date(), body: E(), attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);

    // 任一 sink 失败 → 整条 retry（consumer.ts 注释声明的语义）；健康 sink 已收到 1 次。
    expect(result.retryMessages.map((r: { msgId: string }) => r.msgId)).toContain('m7');
    expect(result.explicitAcks).not.toContain('m7');
    expect(deliverer.delivered.filter((d) => d.url === 'https://sink.test/ok')).toHaveLength(1);
  });
});

describe('Queue consumer HITL 内置路由 (§1.1 system subscriber)', () => {
  const checkpointPayload = {
    taskId: 'task-1',
    checkpoint: 'confirm-release',
    prompt: '上线确认：批准发布？',
    options: ['approve', 'reject'] as const,
    notify: { channel: 'feishu', target: 'oc_room' },
  };

  it('task.checkpoint → publishes an outbound.message with one action button per option (each carrying signal)', async () => {
    const stub = freshRouterStub();
    const deliverer = memDeliverer();
    const queue = memQueue();
    const deps = makeDeps({ deliverer, router: () => stub, queue });

    const batch = createMessageBatch(QUEUE, [
      {
        id: 'c1',
        timestamp: new Date(),
        body: E({
          type: 'task.checkpoint',
          session: 'feishu:chat:oc_room',
          payload: checkpointPayload,
        }),
        attempts: 1,
      },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);

    // 内置规则不影响 ack（无用户订阅命中 → 事件本身 ack）。
    expect(result.explicitAcks).toContain('c1');
    // systemPublish 送出一条 outbound.message 回 bus。
    expect(queue.sent).toHaveLength(1);
    const out = queue.sent[0]!;
    expect(out.type).toBe('outbound.message');
    const payload = out.payload as {
      channel: string;
      target: string;
      content: { text?: string; actions?: Array<{ label: string; signal?: unknown }> };
    };
    expect(payload.channel).toBe('feishu');
    expect(payload.target).toBe('oc_room');
    expect(payload.content.text).toBe('上线确认：批准发布？');
    // 每个 option 一个按钮，内嵌 signal:{taskId, checkpoint, decision}。
    expect(payload.content.actions).toHaveLength(2);
    expect(payload.content.actions?.map((a) => a.label)).toEqual(['approve', 'reject']);
    expect(payload.content.actions?.[0]?.signal).toEqual({
      taskId: 'task-1',
      checkpoint: 'confirm-release',
      decision: 'approve',
    });
  });

  it('task.checkpoint with malformed payload is dropped (no outbound published), message still acked', async () => {
    const stub = freshRouterStub();
    const queue = memQueue();
    const deps = makeDeps({ deliverer: memDeliverer(), router: () => stub, queue });

    const batch = createMessageBatch(QUEUE, [
      {
        id: 'c2',
        timestamp: new Date(),
        body: E({ type: 'task.checkpoint', payload: { taskId: 'x' } }), // 缺 notify/options/prompt
        attempts: 1,
      },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);

    expect(queue.sent).toHaveLength(0);
    expect(result.explicitAcks).toContain('c2'); // 毒丸不重投
  });

  it('im.action with a signal → invokes TaskSignaler with taskId/checkpoint/decision', async () => {
    const stub = freshRouterStub();
    const signaler = recordingSignaler();
    const deps = makeDeps({ deliverer: memDeliverer(), router: () => stub, signaler });

    const batch = createMessageBatch(QUEUE, [
      {
        id: 'a1',
        timestamp: new Date(),
        body: E({
          type: 'im.action',
          payload: {
            actionId: 'confirm-release:approve',
            signal: { taskId: 'task-1', checkpoint: 'confirm-release', decision: 'approve' },
          },
        }),
        attempts: 1,
      },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toContain('a1');
    expect(signaler.calls).toHaveLength(1);
    expect(signaler.calls[0]).toEqual({
      taskId: 'task-1',
      checkpoint: 'confirm-release',
      decision: 'approve',
    });
  });

  it('im.action without a signal does not invoke the signaler', async () => {
    const stub = freshRouterStub();
    const signaler = recordingSignaler();
    const deps = makeDeps({ deliverer: memDeliverer(), router: () => stub, signaler });

    const batch = createMessageBatch(QUEUE, [
      {
        id: 'a2',
        timestamp: new Date(),
        body: E({ type: 'im.action', payload: { actionId: 'plain-button' } }),
        attempts: 1,
      },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toContain('a2');
    expect(signaler.calls).toHaveLength(0);
  });
});

describe('Queue consumer im.bot_joined 自动订阅 (§2.3 规则 2)', () => {
  async function seedChannel(id: string, defaultAgent?: string): Promise<void> {
    const channels = new ChannelStore(env.DB_EVENTS);
    await channels.write({
      id,
      adapter: 'feishu',
      enabled: true,
      settings: {},
      ...(defaultAgent !== undefined ? { defaultAgent } : {}),
    });
  }

  const botJoined = (channel: string, session: string): Event =>
    E({ type: 'im.bot_joined', session, payload: { channel } });

  it('establishes a session-sticky agent subscription to the channel defaultAgent', async () => {
    await env.DB_EVENTS.prepare('DELETE FROM channels').run();
    const stub = freshRouterStub();
    await seedChannel('feishu-main', 'recorder');
    const deps = makeDeps({ deliverer: memDeliverer(), router: () => stub });

    const batch = createMessageBatch(QUEUE, [
      {
        id: 'b1',
        timestamp: new Date(),
        body: botJoined('feishu-main', 'feishu:chat:oc_x'),
        attempts: 1,
      },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    await getQueueResult(batch, ctx);

    const page = await stub.listSubscriptions();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.match.session).toBe('feishu:chat:oc_x');
    expect(page.items[0]?.sink).toEqual({
      kind: 'agent',
      definition: 'recorder',
      instanceBy: 'session',
    });
  });

  it('is idempotent by (definition, session): a second bot_joined does not create a duplicate', async () => {
    await env.DB_EVENTS.prepare('DELETE FROM channels').run();
    const stub = freshRouterStub();
    await seedChannel('feishu-main', 'recorder');
    const deps = makeDeps({ deliverer: memDeliverer(), router: () => stub });

    for (const id of ['b2', 'b3']) {
      const batch = createMessageBatch(QUEUE, [
        {
          id,
          timestamp: new Date(),
          body: botJoined('feishu-main', 'feishu:chat:oc_x'),
          attempts: 1,
        },
      ]);
      const ctx = createExecutionContext();
      await handleQueue(batch, deps);
      await getQueueResult(batch, ctx);
    }

    const page = await stub.listSubscriptions();
    expect(page.items).toHaveLength(1); // 去重：同 (definition, session) 不重复建立
  });

  it('does not establish a subscription when the channel has no defaultAgent', async () => {
    await env.DB_EVENTS.prepare('DELETE FROM channels').run();
    const stub = freshRouterStub();
    await seedChannel('feishu-main'); // 无 defaultAgent
    const deps = makeDeps({ deliverer: memDeliverer(), router: () => stub });

    const batch = createMessageBatch(QUEUE, [
      {
        id: 'b4',
        timestamp: new Date(),
        body: botJoined('feishu-main', 'feishu:chat:oc_x'),
        attempts: 1,
      },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    await getQueueResult(batch, ctx);

    const page = await stub.listSubscriptions();
    expect(page.items).toHaveLength(0);
  });
});
