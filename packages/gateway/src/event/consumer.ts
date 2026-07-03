/**
 * Queue consumer（Proto §2.3 EventBus 分发 / Architecture M1）——watt-events 队列消费入口。
 *
 * 流程：batch 逐消息 →（先跑内置 system subscriber 规则，见下）→ EVENT_ROUTER.matchSubscriptions(event)
 * 拿命中的用户订阅 → 按 sink kind 分发：
 *   - webhook sink：fetch POST event JSON 到 sink.url。成功该消息 ack；失败 retry（重投）。
 *   - agent  sink：resolveSessionInstance 记 session↔实例映射（Session Mapper 铺垫）+ 占位日志。
 *                  真实投递到 Agent 实例留 Phase 4（AgentRuntime 未落地）。
 *   - task   sink：占位日志。真实 Workflow 触发留 Phase 5（TaskManager 未落地）。
 *
 * 内置 system subscriber 规则（Proto §1.1 / §2.3，不占用户订阅表，在 matchSubscriptions 之外独立分支）：
 *   - task.checkpoint（§1.1）：按 payload.notify 构造带 actions 的 outbound.message，Publish 回 bus
 *     （store.put + queue.send，系统路由不走 outbound Check——见 systemPublish 注释）。
 *   - im.action（§1.1）且 payload.signal 存在：调用 TaskSignaler 桩（Phase 5 由 Workflows 接上）。
 *   - im.bot_joined（§2.3 规则 2）：若该 channel 的 ChannelConfig.defaultAgent 已配置，为该 session
 *     建立指向 defaultAgent 的 instanceBy:'session' 订阅（按 (definition, session) 去重）。
 *   内置规则的失败不影响用户订阅分发的 ack/retry 判定（毒丸事件 console.error 后不阻塞）。
 *
 * 消息生命周期：一条消息命中多个 webhook sink 时，任一投递失败即 msg.retry()（整条重投，
 * 幂等由 dedupeKey + 下游 sink 保证）；全部成功或无 webhook sink → msg.ack()。
 *
 * webhook 投递做成可注入依赖（WebhookDeliverer）：workerd 内 global fetch 不便 mock，
 * consumer 测试注入一个内存 deliverer 断言收到/构造失败。生产用默认 fetchDeliverer。
 */

import {
  type Event,
  type EventInput,
  eventSchema,
  normalizeEvent,
  type OutboundMessage,
} from '@watt/core';
import type { Bindings } from '../env.ts';
import { ChannelStore } from './channel-store.ts';
import type { EventQueueSender } from './event-bus.ts';
import type { EventRouter } from './event-router.ts';
import { EventStore } from './event-store.ts';

// DurableObjectStub / MessageBatch 用 @cloudflare/workers-types ambient global（tsconfig types），
// 与 vitest-pool-workers 期望同源（见 env.ts 注释）。
// payload 形状用手写 type guard 校验（gateway 无直接 zod 依赖——引入 zod 会污染 global lib 类型，
// 见 toolchain-pitfalls；§1.1 的规范化 payload 形状小而稳，type guard 足够）。

/** decision 三态（§1 ActionButton.signal / §1.1）。 */
type Decision = 'approve' | 'reject' | 'custom';
const DECISIONS = new Set<Decision>(['approve', 'reject', 'custom']);
function isDecision(v: unknown): v is Decision {
  return typeof v === 'string' && DECISIONS.has(v as Decision);
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** TaskCheckpointPayload（§1.1）——task.checkpoint 事件的 payload 形状。 */
interface TaskCheckpointPayload {
  taskId: string;
  checkpoint: string;
  prompt: string;
  options: Decision[];
  notify: { channel: string; target: string };
}
function parseTaskCheckpoint(payload: unknown): TaskCheckpointPayload | null {
  if (!isRecord(payload)) return null;
  const { taskId, checkpoint, prompt, options, notify } = payload;
  if (typeof taskId !== 'string' || typeof checkpoint !== 'string' || typeof prompt !== 'string') {
    return null;
  }
  if (!Array.isArray(options) || options.length === 0 || !options.every(isDecision)) return null;
  if (
    !isRecord(notify) ||
    typeof notify.channel !== 'string' ||
    typeof notify.target !== 'string'
  ) {
    return null;
  }
  return {
    taskId,
    checkpoint,
    prompt,
    options,
    notify: { channel: notify.channel, target: notify.target },
  };
}

/** ImActionPayload（§1.1）——im.action 事件的 payload 形状（signal 可选）。 */
interface ImActionSignal {
  taskId: string;
  checkpoint: string;
  decision: Decision;
}
function parseImActionSignal(payload: unknown): ImActionSignal | null {
  if (!isRecord(payload)) return null;
  const signal = payload.signal;
  if (!isRecord(signal)) return null; // 无 signal 或形状不符 → 非人类确认闭环。
  if (typeof signal.taskId !== 'string' || typeof signal.checkpoint !== 'string') return null;
  if (!isDecision(signal.decision)) return null;
  return { taskId: signal.taskId, checkpoint: signal.checkpoint, decision: signal.decision };
}

/** im.bot_joined payload（§2.3 规则 2）——需 channel（查 ChannelConfig.defaultAgent）。 */
function parseBotJoinedChannel(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.channel !== 'string') return null;
  return payload.channel;
}

/** webhook sink 投递抽象（可注入，便于测试）。投递失败抛错 → 触发消息 retry。 */
export interface WebhookDeliverer {
  deliver(url: string, event: Event): Promise<void>;
}

/** 生产用 webhook 投递：POST event JSON 到 url；非 2xx 视为失败（抛错触发 retry）。 */
export const fetchDeliverer: WebhookDeliverer = {
  async deliver(url: string, event: Event): Promise<void> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      throw new Error(`webhook sink returned ${res.status}`);
    }
  },
};

/**
 * TaskSignaler（§1.1 规则 2 桩）——im.action 且携带 signal 时回调 TaskManager.Signal 的注入点。
 * Phase 2 无 TaskManager/Workflows（Phase 5 落地），生产注入 noopSignaler（仅记日志）；
 * Phase 5 由 Workflows 侧实现真实 Signal。
 */
export interface TaskSignaler {
  signal(taskId: string, args: { checkpoint: string; decision: Decision }): Promise<void>;
}

/** Phase 2 no-op signaler（记 taskId/checkpoint/decision，真实 Signal 留 Phase 5）。 */
export const noopSignaler: TaskSignaler = {
  async signal(taskId, args) {
    console.log('event consumer: im.action signal (TaskManager.Signal deferred to Phase 5)', {
      taskId,
      checkpoint: args.checkpoint,
      decision: args.decision,
    });
  },
};

/** consumer 的可注入依赖（webhook 投递 + 单例 router stub 解析）。 */
export interface ConsumerDeps {
  deliverer: WebhookDeliverer;
  /** 取全局单例 router stub（固定 idFromName('router')，量级扩展点见 event-router.ts）。 */
  router: () => DurableObjectStub<EventRouter>;
  /** EventStore（§2.4 留痕）——内置 task.checkpoint 规则 Publish 回 bus 用。 */
  store: EventStore;
  /** Queue sender（QUEUE_EVENTS.send）——内置 task.checkpoint 规则 Publish 回 bus 用。 */
  queue: EventQueueSender;
  /** ChannelStore（§2.2）——内置 im.bot_joined 规则查 defaultAgent 用。 */
  channels: ChannelStore;
  /** im.action signal 桩（§1.1 规则 2）。 */
  signaler: TaskSignaler;
  /** 补齐 outbound.message 的 Omit 三字段（可注入以便测试）。 */
  genId: () => string;
  now: () => string;
  genTraceId: () => string;
}

/** 生产依赖：默认 fetch 投递 + 单例 router + EventStore/Queue/ChannelStore + no-op signaler。 */
export function defaultConsumerDeps(env: Bindings): ConsumerDeps {
  return {
    deliverer: fetchDeliverer,
    router: () => env.EVENT_ROUTER.get(env.EVENT_ROUTER.idFromName('router')),
    store: new EventStore(env.DB_EVENTS),
    queue: {
      send: async (event: Event) => {
        await env.QUEUE_EVENTS.send(event);
      },
    },
    channels: new ChannelStore(env.DB_EVENTS),
    signaler: noopSignaler,
    genId: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
    genTraceId: () => crypto.randomUUID(),
  };
}

/**
 * 内置 system subscriber 规则（§1.1 / §2.3）——在用户订阅分发之前跑，不占用户订阅表。
 * 返回值不参与消息 ack/retry 判定：内置规则的失败（畸形 payload 等）console.error 后不阻塞，
 * 由用户订阅分发独立决定 ack/retry。毒丸事件（payload 不合形状）不触发 retry（重投无意义）。
 */
async function runSystemSubscribers(event: Event, deps: ConsumerDeps): Promise<void> {
  switch (event.type) {
    case 'task.checkpoint':
      await handleTaskCheckpoint(event, deps);
      break;
    case 'im.action':
      await handleImAction(event, deps);
      break;
    case 'im.bot_joined':
      await handleBotJoined(event, deps);
      break;
    default:
      break;
  }
}

/**
 * §1.1 规则 1：task.checkpoint → 构造带 actions 的 outbound.message 并 Publish 回 bus。
 * 每个 option 一个 ActionButton，内嵌 signal:{taskId, checkpoint, decision:option}。
 * target/channel 取 payload.notify。payload 不合形状 → console.error 后返回（毒丸不重投）。
 */
async function handleTaskCheckpoint(event: Event, deps: ConsumerDeps): Promise<void> {
  const p = parseTaskCheckpoint(event.payload);
  if (p === null) {
    console.error('event consumer: task.checkpoint malformed payload (dropped)', {
      eventId: event.id,
    });
    return;
  }
  const outbound: OutboundMessage = {
    channel: p.notify.channel,
    target: p.notify.target,
    content: {
      text: p.prompt,
      actions: p.options.map((option) => ({
        id: `${p.checkpoint}:${option}`,
        label: option,
        signal: { taskId: p.taskId, checkpoint: p.checkpoint, decision: option },
      })),
    },
  };
  await systemPublish(
    {
      source: { kind: 'system' },
      type: 'outbound.message',
      session: event.session,
      payload: outbound,
    },
    event,
    deps,
  );
}

/**
 * §1.1 规则 2：im.action 且 payload.signal 存在 → 调 TaskSignaler 桩。
 * 权限校验点 Check(context, task://<taskId>, 'signal')：Phase 2 无 TaskManager 无从校验，
 * TODO——Signal 真实接上（Phase 5）时一并做。payload 不合形状 / 无 signal → 静默跳过。
 */
async function handleImAction(event: Event, deps: ConsumerDeps): Promise<void> {
  const signal = parseImActionSignal(event.payload);
  if (signal === null) return; // 无 signal 的 im.action / 形状不符：非人类确认闭环，不触发 Signal。
  // TODO(Phase 5): Check(context, task://<signal.taskId>, 'signal') 后再调 Signal。
  await deps.signaler.signal(signal.taskId, {
    checkpoint: signal.checkpoint,
    decision: signal.decision,
  });
}

/**
 * §2.3 规则 2：im.bot_joined → 若该 channel 的 ChannelConfig.defaultAgent 已配置，
 * 为 event.session 建立指向 defaultAgent 的 instanceBy:'session' 订阅。
 * 按 (definition, session) 去重（先查 router 现有订阅，已存在同键则跳过——规则 1 优先）。
 * 无 defaultAgent / 无 channel / 无 session → 不建。
 */
async function handleBotJoined(event: Event, deps: ConsumerDeps): Promise<void> {
  const channel = parseBotJoinedChannel(event.payload);
  if (channel === null || event.session === undefined) return;
  const config = await deps.channels.get(channel);
  if ('code' in config) return; // channel 不存在
  const defaultAgent = config.defaultAgent;
  if (defaultAgent === undefined) return; // 未配置 defaultAgent → 不建（规则 2 死配置守卫）

  const router = deps.router();
  const existing = await router.listSubscriptions();
  const dup = existing.items.some(
    (sub) =>
      sub.sink.kind === 'agent' &&
      sub.sink.definition === defaultAgent &&
      sub.match.session === event.session,
  );
  if (dup) return; // (definition, session) 已存在（规则 1 优先）→ 去重跳过

  await router.subscribe({
    match: { session: event.session },
    sink: { kind: 'agent', definition: defaultAgent, instanceBy: 'session' },
  });
}

/**
 * 系统内置路由的 Publish：直接 store.put + queue.send，**不走 outbound Check**。
 * 依据 §1.1「system subscriber」语义——平台内置路由是系统行为（非 Agent 主动出站），
 * 出站鉴权 Check(event://<channel>/<target>,'write') 收敛的是「Agent 能否向渠道发消息」
 * （§2.3 L259-262），不适用于系统自身的确认卡片投递。此为 Phase 2 实现声明（供回写 doc-gaps）。
 */
async function systemPublish(input: EventInput, source: Event, deps: ConsumerDeps): Promise<void> {
  const event = normalizeEvent(input, {
    genId: deps.genId,
    now: deps.now,
    genTraceId: deps.genTraceId,
    traceId: source.traceId, // 链路透传（§0.3）
  });
  await deps.store.put(event);
  await deps.queue.send(event);
}

/**
 * 处理单条消息：先跑内置 system subscriber 规则（§1.1/§2.3，不影响 ack/retry），
 * 再匹配用户订阅并分发。任一 webhook sink 投递失败 → 返回 false（调用方 retry）。
 * agent/task sink 占位（不阻塞、不影响 ack），投递留 Phase 4/5。
 */
async function handleEvent(event: Event, deps: ConsumerDeps): Promise<boolean> {
  // 内置 system subscriber 规则（不占用户订阅表；失败不阻塞用户订阅分发）。
  await runSystemSubscribers(event, deps);

  const router = deps.router();
  const hits = await router.matchSubscriptions(event);
  let ok = true;
  for (const sub of hits) {
    switch (sub.sink.kind) {
      case 'webhook': {
        try {
          await deps.deliverer.deliver(sub.sink.url, event);
        } catch (err) {
          console.error('event consumer: webhook sink delivery failed', {
            eventId: event.id,
            url: sub.sink.url,
            err: String(err),
          });
          ok = false;
        }
        break;
      }
      case 'agent': {
        // Session Mapper 记映射（Phase 4 真实 spawn 铺垫）；投递占位。
        const mapping = await router.resolveSessionInstance(sub.sink, event);
        console.log('event consumer: agent sink (delivery deferred to Phase 4)', {
          eventId: event.id,
          definition: sub.sink.definition,
          instance: 'instanceKey' in mapping ? mapping.instanceKey : `error:${mapping.error}`,
        });
        break;
      }
      case 'task': {
        // TaskManager/Workflows 未落地（Phase 5）；占位日志。
        console.log('event consumer: task sink (delivery deferred to Phase 5)', {
          eventId: event.id,
          workflow: sub.sink.workflow,
        });
        break;
      }
    }
  }
  return ok;
}

/**
 * Queue handler（ExportedHandler.queue）。逐消息处理：成功 ack，webhook 投递失败 retry。
 * 消息 body 经 eventSchema 校验（防御畸形；正常路径来自 EventBus.publish 的完整 Event）。
 * 解析失败的消息 ack（畸形消息重投无意义，避免毒消息卡队列）。
 */
export async function handleQueue(batch: MessageBatch<unknown>, deps: ConsumerDeps): Promise<void> {
  for (const msg of batch.messages) {
    const parsed = eventSchema.safeParse(msg.body);
    if (!parsed.success) {
      console.error('event consumer: malformed queue message dropped', {
        id: msg.id,
        error: parsed.error.message,
      });
      msg.ack();
      continue;
    }
    const ok = await handleEvent(parsed.data, deps);
    if (ok) {
      msg.ack();
    } else {
      msg.retry();
    }
  }
}
