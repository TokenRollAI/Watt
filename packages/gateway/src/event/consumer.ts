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
  type CheckpointDecision as Decision,
  type Event,
  type EventInput,
  eventSchema,
  normalizeEvent,
  type OutboundMessage,
  outboundMessageSchema,
  parseImActionSignal,
  parseTaskCheckpoint,
} from '@watt/core';
import type { Bindings } from '../env.ts';
import { defaultAgentDeliverer } from './agent-deliverer.ts';
import { ChannelStore } from './channel-store.ts';
import type { EventQueueSender } from './event-bus.ts';
import type { EventRouter } from './event-router.ts';
import { EventStore } from './event-store.ts';
import { type FeishuSender, feishuSenderFromEnv } from './feishu-sender.ts';

// DurableObjectStub / MessageBatch 用 @cloudflare/workers-types ambient global（tsconfig types），
// 与 vitest-pool-workers 期望同源（见 env.ts 注释）。
// task.checkpoint / im.action payload 的 type guard 已下沉 core（packages/core/src/task/checkpoint.ts，
// 语义与旧本地副本一致）——本文件 import 复用，不再维护副本（Phase 5 R20）。

/** im.bot_joined payload（§2.3 规则 2）——需 channel（查 ChannelConfig.defaultAgent）。 */
function parseBotJoinedChannel(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const channel = (payload as { channel?: unknown }).channel;
  return typeof channel === 'string' ? channel : null;
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
 * TaskSignaler（§1.1 规则 2）——im.action 且携带 signal 时的人类确认回调注入点。
 * signal(taskId, {checkpoint, decision}, principal?)：先 Check(context, task://<taskId>, 'signal')
 *   （principal 从事件取，见 handleImAction），再 TaskManager.Signal。principal 缺省 → 拒绝
 *   （人类确认必须有身份，permission_denied）。测试注入 fake 断言 Check/Signal 被调。
 */
export interface TaskSignaler {
  signal(
    taskId: string,
    args: { checkpoint: string; decision: Decision },
    principal?: string,
  ): Promise<void>;
}

/** Phase 2 no-op signaler（记 taskId/checkpoint/decision，真实 Signal 见 defaultTaskSignaler）。 */
export const noopSignaler: TaskSignaler = {
  async signal(taskId, args) {
    console.log('event consumer: im.action signal (noop signaler)', {
      taskId,
      checkpoint: args.checkpoint,
      decision: args.decision,
    });
  },
};

/**
 * AgentDeliverer（§3.2 agent sink 真实投递 + §3.4 结果路由）——Phase 4 接线点。
 * 注入以便 consumer 测试（fake deliverer 断言投递/路由，无需真实 DO/Runtime）。
 *  - routeResult(event)：agent.result/agent.failed 进 consumer 时先走 §3.4 定向回送
 *    （查 correlation：deliver 投等待方 / drop-duplicate·drop-no-waiter 记 console）。
 *  - deliverToAgent(sub, event)：agent 订阅命中 → resolveInstanceKey → Spawn/Send 实例（§2.3）。
 */
export interface AgentDeliverer {
  routeResult(event: Event): Promise<void>;
  deliverToAgent(definition: string, instanceBy: string, event: Event): Promise<void>;
}

/** Phase 4 前的 no-op agent deliverer（占位；生产由 defaultConsumerDeps 注入真实实现）。 */
export const noopAgentDeliverer: AgentDeliverer = {
  async routeResult() {},
  async deliverToAgent() {},
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
  /** agent sink 真实投递 + §3.4 结果路由（Phase 4）。 */
  agent: AgentDeliverer;
  /** 飞书出站投递（§2.1 出站接线 R24）——outbound.message 且渠道 adapter=feishu 时调飞书 REST。 */
  feishu: FeishuSender;
  /** 补齐 outbound.message 的 Omit 三字段（可注入以便测试）。 */
  genId: () => string;
  now: () => string;
  genTraceId: () => string;
}

/** 生产依赖：默认 fetch 投递 + 单例 router + EventStore/Queue/ChannelStore + 真实 TaskSignaler。 */
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
    signaler: defaultTaskSignaler(env),
    agent: defaultAgentDeliverer(env),
    feishu: feishuSenderFromEnv(env),
    genId: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
    genTraceId: () => crypto.randomUUID(),
  };
}

/**
 * 生产 TaskSignaler（§1.1 规则 2 闭环）——Check(context, task://<taskId>, 'signal') → TaskManager.Signal。
 * principal 从 im.action 事件取（event.principal，§2.3 平台补齐）；缺省 → permission_denied 拒绝
 *   （人类确认必须有身份，实现声明）。principal 的 roles 经 IdentityMapper.ResolvePrincipal 实时解析
 *   （§6.3），构造最小 TokenClaims 交 Authorizer.check。Signal conflict/not_found 由 TaskManager 判定，
 *   此处只记日志不重投（im.action 是即时人类动作，重投无意义）。
 */
export function defaultTaskSignaler(env: Bindings): TaskSignaler {
  return {
    async signal(taskId, args, principal) {
      if (principal === undefined) {
        console.error('event consumer: im.action signal denied (no principal)', {
          taskId,
          checkpoint: args.checkpoint,
        });
        return;
      }
      const { newAuthorizer } = await import('../audit/audit-sink.ts');
      const { IdentityMapper } = await import('../authz/identity-mapper.ts');
      const { TaskManager, defaultManagerDeps } = await import('../task/task-manager.ts');
      const resolved = await new IdentityMapper(env.DB_POLICIES).resolvePrincipal(principal);
      const claims = { sub: principal, roles: resolved.roles };
      const authorizer = newAuthorizer(env);
      const decision = await authorizer.check(claims, `task://${taskId}`, 'signal');
      if (!decision.allow) {
        console.error('event consumer: im.action signal denied by authorizer', {
          taskId,
          principal,
          reason: decision.reason,
        });
        return;
      }
      const manager = new TaskManager(defaultManagerDeps(env));
      const res = await manager.signal(taskId, {
        checkpoint: args.checkpoint,
        decision: args.decision,
      });
      if (res && 'code' in res) {
        console.error('event consumer: im.action signal rejected by TaskManager', {
          taskId,
          checkpoint: args.checkpoint,
          code: res.code,
        });
      }
    },
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
    case 'outbound.message':
      await handleOutboundMessage(event, deps);
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
 * §1.1 规则 2：im.action 且 payload.signal 存在 → Check(task://<taskId>,'signal') → TaskManager.Signal。
 * principal 从 event.principal 取（§2.3 平台补齐）并传给 signaler（其内做 Check + Signal，见
 *   defaultTaskSignaler）。payload 不合形状 / 无 signal → 静默跳过（非人类确认闭环）。
 */
async function handleImAction(event: Event, deps: ConsumerDeps): Promise<void> {
  const signal = parseImActionSignal(event.payload);
  if (signal === null) return; // 无 signal 的 im.action / 形状不符：非人类确认闭环，不触发 Signal。
  await deps.signaler.signal(
    signal.taskId,
    { checkpoint: signal.checkpoint, decision: signal.decision },
    event.principal,
  );
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
 * §2.1 出站接线（R24）：outbound.message → 若目标渠道 adapter=feishu，调飞书 REST 投递。
 * payload 经 outboundMessageSchema 校验（畸形 → console.error 后返回，毒丸不重投）。
 * 渠道解析：ChannelStore.get(payload.channel) 拿 ChannelConfig；adapter!=feishu / channel 不存在
 *   → 跳过（本轮只接飞书；其他渠道出站留后续轮）。投递失败 console.error 留痕（不阻塞 ack/retry
 *   判定——出站是内置 system 规则，与用户订阅分发解耦；重投由队列层不覆盖此路径，失败仅留痕）。
 */
async function handleOutboundMessage(event: Event, deps: ConsumerDeps): Promise<void> {
  const parsed = outboundMessageSchema.safeParse(event.payload);
  if (!parsed.success) {
    console.error('event consumer: outbound.message malformed payload (dropped)', {
      eventId: event.id,
    });
    return;
  }
  const outbound = parsed.data;
  const config = await deps.channels.get(outbound.channel);
  if ('code' in config) return; // 渠道未配置 → 跳过（无投递目标）
  if (config.adapter !== 'feishu') return; // 本轮只接飞书出站

  const result = await deps.feishu.send(outbound);
  if (!result.ok) {
    console.error('event consumer: feishu outbound delivery failed', {
      eventId: event.id,
      channel: outbound.channel,
      target: outbound.target,
      error: result.error,
    });
  }
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
  // §3.4 定向回送：带 correlationId 的 agent.result/agent.failed 不进通用订阅匹配（规则 1），
  // 由 AgentDeliverer 查 correlation 表投给等待方 / drop-duplicate / drop-no-waiter。
  if (event.type === 'agent.result' || event.type === 'agent.failed') {
    try {
      await deps.agent.routeResult(event);
    } catch (err) {
      // 投递失败（等待方实例 onEvent 抛错）→ correlation 已回滚到 pending，msg.retry() 重放
      // （与 webhook sink 一致；不吞错 ack，否则结果永久丢失，2026-07-03 MAJOR）。
      console.error('event consumer: agent result routing failed, will retry', {
        eventId: event.id,
        err: String(err),
      });
      return false;
    }
    // 结果事件已定向路由（EventStore 已在 publish 时留痕）；不再进订阅匹配。
    return true;
  }

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
        // §2.3 规则 1/2：agent 订阅命中 → resolveInstanceKey → Spawn（幂等复用）+ Send 投递（§3.2）。
        // Session Mapper 映射仍记（会话粘性可视化）；真实投递由 AgentDeliverer 执行。
        await router.resolveSessionInstance(sub.sink, event);
        try {
          await deps.agent.deliverToAgent(sub.sink.definition, sub.sink.instanceBy, event);
        } catch (err) {
          console.error('event consumer: agent sink delivery failed', {
            eventId: event.id,
            definition: sub.sink.definition,
            err: String(err),
          });
        }
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
