/// <reference types="@cloudflare/vitest-pool-workers/types" />
import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
  runInDurableObject,
} from 'cloudflare:test';
import type { ChannelConfig, Event, OutboundMessage, Subscription } from '@watt/core';
import { getAgentByName } from 'agents';
import { describe, expect, it, vi } from 'vitest';
import type { AgentInstance, AgentInstanceRpc } from '../src/agent/agent-instance.ts';
import { PolicyStore } from '../src/authz/policy-store.ts';
import { defaultAgentDeliverer } from '../src/event/agent-deliverer.ts';
import { ChannelStore } from '../src/event/channel-store.ts';
import {
  type AgentDeliverer,
  type ConsumerDeps,
  defaultTaskSignaler,
  handleQueue,
  noopAgentDeliverer,
  type TaskSignaler,
  type WebhookDeliverer,
} from '../src/event/consumer.ts';
import type { EventQueueSender } from '../src/event/event-bus.ts';
import type { EventRouter } from '../src/event/event-router.ts';
import { EventStore } from '../src/event/event-store.ts';
import type { OutboundDispatchResult, PluginSender } from '../src/event/plugin-sender.ts';
import { TaskStore } from '../src/task/task-store.ts';

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

/** 记录 TaskSignaler 调用（im.action 规则断言用；含 principal 透传断言）。 */
function recordingSignaler(): TaskSignaler & {
  calls: Array<{ taskId: string; checkpoint: string; decision: string; principal?: string }>;
} {
  return {
    calls: [],
    async signal(taskId, args, principal) {
      this.calls.push({ taskId, checkpoint: args.checkpoint, decision: args.decision, principal });
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
  sender?: PluginSender;
}): ConsumerDeps {
  return {
    deliverer: over.deliverer,
    router: over.router,
    store: new EventStore(env.DB_EVENTS),
    queue: over.queue ?? memQueue(),
    channels: over.channels ?? new ChannelStore(env.DB_EVENTS),
    signaler: over.signaler ?? recordingSignaler(),
    agent: over.agent ?? noopAgentDeliverer,
    sender: over.sender ?? recordingSender(),
    genId: () => 'gen-id',
    now: () => '2026-07-03T00:00:00.000Z',
    genTraceId: () => 'gen-trace',
  };
}

/** 内存出站分发器：记录 (channel,message,opts)；可配置返回结果。 */
function recordingSender(
  result: OutboundDispatchResult = { ok: true, channelMessageId: 'om-1' },
): PluginSender & {
  sent: Array<{
    channel: ChannelConfig;
    message: OutboundMessage;
    opts: { requestId: string; traceId?: string };
  }>;
} {
  return {
    sent: [],
    async send(channel, message, opts) {
      this.sent.push({ channel, message, opts });
      return result;
    },
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
    expect(signaler.calls[0]).toMatchObject({
      taskId: 'task-1',
      checkpoint: 'confirm-release',
      decision: 'approve',
    });
  });

  it('im.action passes event.principal through to the signaler (§2.3 平台补齐)', async () => {
    const stub = freshRouterStub();
    const signaler = recordingSignaler();
    const deps = makeDeps({ deliverer: memDeliverer(), router: () => stub, signaler });

    const batch = createMessageBatch(QUEUE, [
      {
        id: 'a3',
        timestamp: new Date(),
        body: E({
          type: 'im.action',
          principal: 'user:alice',
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
    await getQueueResult(batch, ctx);

    // principal 从 event.principal 取并透传给 signaler（defaultTaskSignaler 据此做 Check + Signal）。
    expect(signaler.calls).toHaveLength(1);
    expect(signaler.calls[0]?.principal).toBe('user:alice');
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

/**
 * §3.4 定向回送在 consumer 层的接线（真实 AgentDeliverer，非 noop）——handleQueue 处理 agent.result
 * → routeResult 查真实 correlation 单例 → 投递等待方实例；投递失败 → msg.retry() 重放（MAJOR 修正）。
 */
async function instanceRpc(key: string): Promise<AgentInstanceRpc> {
  const stub = await getAgentByName<Cloudflare.Env, AgentInstance>(env.AGENT_INSTANCE, key);
  return stub as unknown as AgentInstanceRpc;
}

function realCorrelationStub() {
  return env.AGENT_CORRELATION.get(env.AGENT_CORRELATION.idFromName('correlation'));
}

const resultEvt = (correlationId: string, instanceId: string): Event => ({
  id: `res-${correlationId}`,
  source: { kind: 'agent', ref: instanceId },
  type: 'agent.result',
  payload: { correlationId, instanceId, output: { ok: true } },
  occurredAt: '2026-07-03T00:00:00.000Z',
  traceId: 't',
});

let corrSeq = 0;

describe('Queue consumer real AgentDeliverer wiring (§3.4)', () => {
  it('handleQueue routes an agent.result through the real deliverer to the waiter instance, then acks', async () => {
    const corr = realCorrelationStub();
    const waiterKey = `consumer-waiter-${corrSeq++}`;
    const waiter = await instanceRpc(waiterKey);
    await waiter.initInstance({
      definition: 'p',
      harness: 'echo',
      nowIso: '2020-01-01T00:00:00.000Z',
    });
    const cid = `cid-consumer-${corrSeq}`;
    await corr.register(
      cid,
      { kind: 'agent', id: waiterKey },
      'producer',
      Date.now() + 60_000,
      't',
    );

    const stub = freshRouterStub();
    const deps = makeDeps({
      deliverer: memDeliverer(),
      router: () => stub,
      agent: defaultAgentDeliverer(env),
    });
    const batch = createMessageBatch(QUEUE, [
      { id: 'r1', timestamp: new Date(), body: resultEvt(cid, 'producer'), attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);

    // 投递成功 → 消息 ack；waiter 实例 onEvent 被触达（lastActiveAt 推进）；correlation settled。
    expect(result.explicitAcks).toContain('r1');
    expect((await waiter.getInfo()).lastActiveAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(await corr.resolve(cid)).toBeNull();
  });

  it('retries the message (and rolls correlation back to pending) when waiter delivery throws', async () => {
    // fake AgentDeliverer：routeResult 抛错 → consumer 返回 false → msg.retry()（不吞错 ack）。
    const throwingAgent: AgentDeliverer = {
      async routeResult() {
        throw new Error('waiter onEvent failed');
      },
      async deliverToAgent() {},
    };
    const stub = freshRouterStub();
    const deps = makeDeps({ deliverer: memDeliverer(), router: () => stub, agent: throwingAgent });
    const batch = createMessageBatch(QUEUE, [
      { id: 'r2', timestamp: new Date(), body: resultEvt('cid-x', 'producer'), attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);

    expect(result.retryMessages.map((r: { msgId: string }) => r.msgId)).toContain('r2');
    expect(result.explicitAcks).not.toContain('r2');
  });
});

/**
 * defaultTaskSignaler 生产实现（§1.1 规则 2 闭环）——真实 Authorizer/PolicyStore/IdentityMapper/
 * TaskManager 路径。此前 consumer 测试全注入 recordingSignaler 且丢弃 principal，生产四条分支零覆盖：
 *   ① principal 缺省 → 拒绝，不调 TaskManager.Signal；
 *   ② Check deny（无匹配 allow policy，默认 deny）→ 拒绝，不调 Signal；
 *   ③ Check allow → 调 TaskManager.Signal（用不存在的 taskId：signal 内 getDetail 先返 not_found，
 *      不碰 WATT_TASK.sendEvent；据 'rejected by TaskManager' 日志证明 Signal 确被调用到）；
 *   ④ principal 透传见上方 recordingSignaler 用例（consumer 把 event.principal 传给 signaler）。
 * 分支判定用 console.error 日志（defaultTaskSignaler 各分支消息互斥）+ D1 policy 副作用交叉验证。
 */
describe('defaultTaskSignaler production wiring (§1.1 规则 2, four branches)', () => {
  async function clearPolicies(): Promise<void> {
    await env.DB_POLICIES.prepare('DELETE FROM policies').run();
    await env.DB_POLICIES.prepare('DELETE FROM identity_mappings').run();
  }

  it('denies (and does not call Signal) when principal is undefined', async () => {
    await clearPolicies();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const signaler = defaultTaskSignaler(env);
      await signaler.signal(
        'any-task',
        { checkpoint: 'confirm-release', decision: 'approve' },
        undefined,
      );
      // principal 缺省分支：记 'no principal'，未走到 authorizer/manager。
      const denied = spy.mock.calls.find((c) =>
        String(c[0]).includes('im.action signal denied (no principal)'),
      );
      expect(denied).toBeDefined();
      // 未走到 authorizer/TaskManager 分支（无这些日志）。
      expect(spy.mock.calls.some((c) => String(c[0]).includes('denied by authorizer'))).toBe(false);
      expect(spy.mock.calls.some((c) => String(c[0]).includes('rejected by TaskManager'))).toBe(
        false,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('denies when the authorizer denies (no matching allow policy → default deny)', async () => {
    await clearPolicies(); // 无 policy → Authorizer 默认 deny。
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const signaler = defaultTaskSignaler(env);
      await signaler.signal(
        'task-deny',
        { checkpoint: 'confirm-release', decision: 'approve' },
        'user:nobody',
      );
      // Check deny 分支：记 'denied by authorizer'，未走到 TaskManager。
      expect(
        spy.mock.calls.some((c) => String(c[0]).includes('im.action signal denied by authorizer')),
      ).toBe(true);
      expect(spy.mock.calls.some((c) => String(c[0]).includes('rejected by TaskManager'))).toBe(
        false,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('calls TaskManager.Signal when the authorizer allows (Check → Signal reached)', async () => {
    await clearPolicies();
    // allow policy：user:alice 对 task://* 的 signal 动作放行（subject 直接匹配 principal）。
    await new PolicyStore(env.DB_POLICIES).write({
      id: 'allow-signal',
      subject: 'user:alice',
      resource: 'task://*',
      actions: ['signal'],
      effect: 'allow',
    });
    // 确保目标任务不存在 → TaskManager.signal 内 getDetail 返 not_found（不碰 WATT_TASK.sendEvent）。
    await env.DB_EVENTS.prepare('DELETE FROM tasks WHERE task_id = ?').bind('task-allow').run();

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const signaler = defaultTaskSignaler(env);
      await signaler.signal(
        'task-allow',
        { checkpoint: 'confirm-release', decision: 'approve' },
        'user:alice',
      );
      // Check allow → 未记 'denied by authorizer'；确实调到 TaskManager.signal（not_found → 记
      // 'rejected by TaskManager' code=not_found），证明 Check 通过后 Signal 被调。
      expect(spy.mock.calls.some((c) => String(c[0]).includes('denied by authorizer'))).toBe(false);
      const rejected = spy.mock.calls.find((c) =>
        String(c[0]).includes('im.action signal rejected by TaskManager'),
      );
      expect(rejected).toBeDefined();
      expect((rejected?.[1] as { code?: string }).code).toBe('not_found');
    } finally {
      spy.mockRestore();
    }
  });

  it('reaches TaskManager.Signal and resumes a real waiting task (Check allow → conflict-free Signal)', async () => {
    await clearPolicies();
    await new PolicyStore(env.DB_POLICIES).write({
      id: 'allow-signal-2',
      subject: 'user:alice',
      resource: 'task://*',
      actions: ['signal'],
      effect: 'allow',
    });
    // 建一个 waiting_human task（不启 Workflow）+ 匹配 checkpoint：signal 走 checkpoint 校验后到
    // sendEvent；此处只断言"Check 通过 + Signal 被调进 TaskManager"——用 checkpoint mismatch 让
    // signal 在 sendEvent 之前返 invalid_argument（不碰不存在的 WATT_TASK 实例）。
    const store = new TaskStore(env.DB_EVENTS);
    const taskId = 'task-waiting-signal';
    await env.DB_EVENTS.prepare('DELETE FROM tasks WHERE task_id = ?').bind(taskId).run();
    await store.create({
      taskId,
      definition: 'auto-delivery-lite',
      state: 'running',
      createdBy: 'user:alice',
      now: '2026-07-03T00:00:00.000Z',
    });
    await store.setCheckpoint(
      taskId,
      { checkpoint: 'confirm-release', prompt: 'p', requestedAt: '2026-07-03T00:00:00.000Z' },
      '2026-07-03T00:00:00.000Z',
    );

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const signaler = defaultTaskSignaler(env);
      // checkpoint 不符 → TaskManager.signal 返 invalid_argument（在 sendEvent 之前，不碰 Workflow）。
      await signaler.signal(
        taskId,
        { checkpoint: 'wrong-checkpoint', decision: 'approve' },
        'user:alice',
      );
      expect(spy.mock.calls.some((c) => String(c[0]).includes('denied by authorizer'))).toBe(false);
      const rejected = spy.mock.calls.find((c) =>
        String(c[0]).includes('im.action signal rejected by TaskManager'),
      );
      expect(rejected).toBeDefined();
      // Signal 被调进 TaskManager 且走到 checkpoint 校验（invalid_argument）——非 not_found，证明
      // getDetail 命中了真实 waiting_human 行。
      expect((rejected?.[1] as { code?: string }).code).toBe('invalid_argument');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Queue consumer outbound.message → 通用出站分发器 (§2.1/§11.4 P1)', () => {
  async function seedFeishuChannel(id: string, adapter = 'feishu'): Promise<void> {
    const channels = new ChannelStore(env.DB_EVENTS);
    await channels.write({ id, adapter, enabled: true, settings: {} });
  }

  const outboundEvent = (channel: string, content: OutboundMessage['content']): Event =>
    E({
      type: 'outbound.message',
      source: { kind: 'system' },
      session: 'feishu:chat:oc_room',
      payload: { channel, target: 'oc_room', content } satisfies OutboundMessage,
    });

  it('配置渠道时调出站分发器投递（传 ChannelConfig + requestId=event.id）', async () => {
    await env.DB_EVENTS.prepare('DELETE FROM channels').run();
    await seedFeishuChannel('feishu');
    const stub = freshRouterStub();
    const sender = recordingSender();
    const deps = makeDeps({ deliverer: memDeliverer(), router: () => stub, sender });

    const batch = createMessageBatch(QUEUE, [
      {
        id: 'o1',
        timestamp: new Date(),
        body: outboundEvent('feishu', { text: 'hello' }),
        attempts: 1,
      },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.channel.adapter).toBe('feishu');
    expect(sender.sent[0]?.message.target).toBe('oc_room');
    expect(sender.sent[0]?.message.content.text).toBe('hello');
    expect(sender.sent[0]?.opts.requestId).toBe('e1'); // = event.id（plugin 幂等键）
    // 出站是内置 system 规则，成功投递后消息 ack（无用户订阅命中）。
    expect(result.explicitAcks).toContain('o1');
  });

  it('分发器返回 skipped（渠道未接 enabled channel-adapter plugin）→ ack', async () => {
    await env.DB_EVENTS.prepare('DELETE FROM channels').run();
    await seedFeishuChannel('hook', 'webhook');
    const stub = freshRouterStub();
    const sender = recordingSender({ ok: false, skipped: true });
    const deps = makeDeps({ deliverer: memDeliverer(), router: () => stub, sender });

    const batch = createMessageBatch(QUEUE, [
      { id: 'o2', timestamp: new Date(), body: outboundEvent('hook', { text: 'x' }), attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toContain('o2');
  });

  it('渠道未配置 → 跳过（不调分发器）', async () => {
    await env.DB_EVENTS.prepare('DELETE FROM channels').run();
    const stub = freshRouterStub();
    const sender = recordingSender();
    const deps = makeDeps({ deliverer: memDeliverer(), router: () => stub, sender });

    const batch = createMessageBatch(QUEUE, [
      {
        id: 'o3',
        timestamp: new Date(),
        body: outboundEvent('feishu', { text: 'x' }),
        attempts: 1,
      },
    ]);
    const ctx = createExecutionContext();
    await handleQueue(batch, deps);
    await getQueueResult(batch, ctx);
    expect(sender.sent).toHaveLength(0);
  });

  it('分发器非 retryable 失败 → 留痕（不阻塞 ack；内置规则失败不触发 retry）', async () => {
    await env.DB_EVENTS.prepare('DELETE FROM channels').run();
    await seedFeishuChannel('feishu');
    const stub = freshRouterStub();
    const sender = recordingSender({ ok: false, error: 'business reject' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deps = makeDeps({ deliverer: memDeliverer(), router: () => stub, sender });
      const batch = createMessageBatch(QUEUE, [
        {
          id: 'o4',
          timestamp: new Date(),
          body: outboundEvent('feishu', { text: 'x' }),
          attempts: 1,
        },
      ]);
      const ctx = createExecutionContext();
      await handleQueue(batch, deps);
      const result = await getQueueResult(batch, ctx);
      expect(sender.sent).toHaveLength(1);
      expect(result.explicitAcks).toContain('o4'); // 非 retryable 失败仅留痕，消息仍 ack
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('畸形 outbound.message payload → 丢弃留痕', async () => {
    await env.DB_EVENTS.prepare('DELETE FROM channels').run();
    await seedFeishuChannel('feishu');
    const stub = freshRouterStub();
    const sender = recordingSender();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deps = makeDeps({ deliverer: memDeliverer(), router: () => stub, sender });
      const bad = E({
        type: 'outbound.message',
        source: { kind: 'system' },
        payload: { channel: 'feishu' },
      });
      const batch = createMessageBatch(QUEUE, [
        { id: 'o5', timestamp: new Date(), body: bad, attempts: 1 },
      ]);
      const ctx = createExecutionContext();
      await handleQueue(batch, deps);
      await getQueueResult(batch, ctx);
      expect(sender.sent).toHaveLength(0);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('Queue consumer 出站可靠性 + system 规则重投幂等 (R27 关门 C2/C3)', () => {
  async function seedFeishuChannel2(id: string): Promise<void> {
    const channels = new ChannelStore(env.DB_EVENTS);
    await channels.write({ id, adapter: 'feishu', enabled: true, settings: {} });
  }

  it('出站 retryable 失败 → 消息 retry（不静默 ack 丢消息）；requestId=event.id 传给分发器', async () => {
    await env.DB_EVENTS.prepare('DELETE FROM channels').run();
    await seedFeishuChannel2('feishu');
    const stub = freshRouterStub();
    const sentOpts: Array<{ requestId: string }> = [];
    const sender: PluginSender = {
      async send(_channel, _message, opts) {
        sentOpts.push({ requestId: opts.requestId });
        return { ok: false, retryable: true, error: 'network blip' };
      },
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deps = makeDeps({ deliverer: memDeliverer(), router: () => stub, sender });
      const ev = E({
        id: 'ob-retry-1',
        type: 'outbound.message',
        source: { kind: 'system' },
        payload: {
          channel: 'feishu',
          target: 'oc_room',
          content: { text: 'x' },
        } satisfies OutboundMessage,
      });
      const batch = createMessageBatch(QUEUE, [
        { id: 'or1', timestamp: new Date(), body: ev, attempts: 1 },
      ]);
      const ctx = createExecutionContext();
      await handleQueue(batch, deps);
      const result = await getQueueResult(batch, ctx);
      expect(result.retryMessages.map((r: { msgId: string }) => r.msgId)).toContain('or1');
      expect(result.explicitAcks).not.toContain('or1');
      // 幂等键 = 事件 id（X-Watt-Request-Id → plugin 侧 uuid 服务端去重，重投不重复发消息）。
      expect(sentOpts[0]?.requestId).toBe('ob-retry-1');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('task.checkpoint 重投（同源事件）→ dedupeKey 短路，确认卡片只下发一次', async () => {
    const stub = freshRouterStub();
    const queue = memQueue();
    const deps = makeDeps({ deliverer: memDeliverer(), router: () => stub, queue });
    const ev = E({
      id: 'ck-redeliver-1',
      type: 'task.checkpoint',
      session: 'feishu:chat:oc_room',
      payload: {
        taskId: 'task-rd',
        checkpoint: 'confirm-release',
        prompt: '上线确认：批准发布？',
        options: ['approve', 'reject'],
        notify: { channel: 'feishu', target: 'oc_room' },
      },
    });
    const ctx = createExecutionContext();
    // 第一次投递：产出一条 outbound.message。
    await handleQueue(
      createMessageBatch(QUEUE, [{ id: 'ck1', timestamp: new Date(), body: ev, attempts: 1 }]),
      deps,
    );
    // 队列 at-least-once 重投同一事件：dedupeKey=system:checkpoint:<源事件 id> 窗内命中 → 短路。
    await handleQueue(
      createMessageBatch(QUEUE, [{ id: 'ck2', timestamp: new Date(), body: ev, attempts: 2 }]),
      deps,
    );
    await getQueueResult(
      createMessageBatch(QUEUE, [{ id: 'ck3', timestamp: new Date(), body: E(), attempts: 1 }]),
      ctx,
    ).catch(() => {});
    expect(queue.sent.filter((e) => e.type === 'outbound.message')).toHaveLength(1);
  });
});
