/**
 * Queue consumer（Proto §2.3 EventBus 分发 / Architecture M1）——watt-events 队列消费入口。
 *
 * 流程：batch 逐消息 → EVENT_ROUTER.matchSubscriptions(event) 拿命中订阅 → 按 sink kind 分发：
 *   - webhook sink：fetch POST event JSON 到 sink.url。成功该消息 ack；失败 retry（重投）。
 *   - agent  sink：resolveSessionInstance 记 session↔实例映射（Session Mapper 铺垫）+ 占位日志。
 *                  真实投递到 Agent 实例留 Phase 4（AgentRuntime 未落地）。
 *   - task   sink：占位日志。真实 Workflow 触发留 Phase 5（TaskManager 未落地）。
 *
 * 消息生命周期：一条消息命中多个 webhook sink 时，任一投递失败即 msg.retry()（整条重投，
 * 幂等由 dedupeKey + 下游 sink 保证）；全部成功或无 webhook sink → msg.ack()。
 *
 * webhook 投递做成可注入依赖（WebhookDeliverer）：workerd 内 global fetch 不便 mock，
 * consumer 测试注入一个内存 deliverer 断言收到/构造失败。生产用默认 fetchDeliverer。
 */

import { type Event, eventSchema } from '@watt/core';
import type { Bindings } from '../env.ts';
import type { EventRouter } from './event-router.ts';

// DurableObjectStub / MessageBatch 用 @cloudflare/workers-types ambient global（tsconfig types），
// 与 vitest-pool-workers 期望同源（见 env.ts 注释）。

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

/** consumer 的可注入依赖（webhook 投递 + 单例 router stub 解析）。 */
export interface ConsumerDeps {
  deliverer: WebhookDeliverer;
  /** 取全局单例 router stub（固定 idFromName('router')，量级扩展点见 event-router.ts）。 */
  router: () => DurableObjectStub<EventRouter>;
}

/** 生产依赖：默认 fetch 投递 + 单例 router。 */
export function defaultConsumerDeps(env: Bindings): ConsumerDeps {
  return {
    deliverer: fetchDeliverer,
    router: () => env.EVENT_ROUTER.get(env.EVENT_ROUTER.idFromName('router')),
  };
}

/**
 * 处理单条消息：匹配订阅并分发。任一 webhook sink 投递失败 → 返回 false（调用方 retry）。
 * agent/task sink 占位（不阻塞、不影响 ack），投递留 Phase 4/5。
 */
async function handleEvent(event: Event, deps: ConsumerDeps): Promise<boolean> {
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
