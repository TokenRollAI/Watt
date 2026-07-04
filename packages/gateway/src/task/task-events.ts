/**
 * Task 引擎的事件发布助手（Proto §1.1 task.checkpoint / §3.4 task waiter 回送）——Workflow 侧调用。
 *
 * publishTaskCheckpoint：Task 进 waiting_human 时 Publish task.checkpoint（§1.1）——system 路由，
 *   normalizeEvent 补齐 id/traceId/occurredAt → EventStore.put 留痕 → QUEUE_EVENTS.send（consumer
 *   的内置 handleTaskCheckpoint 转带 actions 的 outbound.message 确认卡片）。与 consumer.systemPublish
 *   同语义（system subscriber 不走出站 Check），但从 Workflow env 侧发起。
 *
 * deliverTaskResult：consumer.routeResult 命中 task waiter 时（§3.4 规则 1），把 agent.result/failed
 *   归并投递到 Workflow 实例的 waitForEvent——env.WATT_TASK.get(taskId).sendEvent({ type:
 *   agentResultEventName(cid), payload:{ status, output?, error? } })。归并原因见 core event-names.ts。
 */

import {
  agentResultEventName,
  type Event,
  type EventInput,
  normalizeEvent,
  type TaskCheckpointPayload,
} from '@watt/core';
import type { Bindings } from '../env.ts';

/** Workflow 发布 task.checkpoint 所需的最小 env 面。 */
type TaskEventEnv = Pick<Bindings, 'DB_EVENTS' | 'QUEUE_EVENTS'>;

/**
 * Publish task.checkpoint（§1.1）。source.kind='system'（平台内置路由，非 Agent 出站，不走 Check）。
 * 留痕 + 送队列，consumer 侧转确认卡片。EventStore 动态 import 避免 Workflow 模块顶层耦合 DO/store 链。
 */
export async function publishTaskCheckpoint(
  env: TaskEventEnv,
  payload: TaskCheckpointPayload,
): Promise<void> {
  const input: EventInput = {
    source: { kind: 'system' },
    type: 'task.checkpoint',
    payload,
  };
  const event = normalizeEvent(input, {
    genId: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
    genTraceId: () => crypto.randomUUID(),
  });
  const { EventStore } = await import('../event/event-store.ts');
  await new EventStore(env.DB_EVENTS).put(event);
  await env.QUEUE_EVENTS.send(event);
}

/**
 * Publish Task 的出站通知（R30，E2E-2 判据④汇总送达）——outbound.message 走 system 路由
 *   （与 checkpoint 卡片同管道：consumer handleOutboundMessage → 渠道 adapter 投递）。
 *   带确定性 dedupeKey（重放/重投不重复下发，对齐 consumer.systemPublish 语义——Workflow step.do
 *   已保证单次执行，dedupeKey 是队列 at-least-once 面的第二道保险）。
 */
export async function publishTaskOutbound(
  env: TaskEventEnv,
  msg: { channel: string; target: string; text: string },
): Promise<void> {
  const input: EventInput = {
    source: { kind: 'system' },
    type: 'outbound.message',
    payload: { channel: msg.channel, target: msg.target, content: { text: msg.text } },
    dedupeKey: `task:outbound:${msg.channel}:${msg.target}:${msg.text.slice(0, 40)}`,
  };
  const event = normalizeEvent(input, {
    genId: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
    genTraceId: () => crypto.randomUUID(),
  });
  const { EventStore } = await import('../event/event-store.ts');
  await new EventStore(env.DB_EVENTS).put(event);
  await env.QUEUE_EVENTS.send(event);
}

/**
 * 把 agent.result/agent.failed 归并投递到 Task 的 Workflow 实例 waitForEvent（§3.4 规则 1，task waiter）。
 * type = agentResultEventName(correlationId)（result/failed 归并）；payload 带 status 区分，
 * output（result）/ error（failed）由 Workflow 步骤代码分支。correlationId 非法（净化后超长）→ 抛错
 *   （register 时已保证合法，此处防御）。
 */
export async function deliverTaskResult(
  env: Pick<Bindings, 'WATT_TASK'>,
  taskId: string,
  correlationId: string,
  result: { status: 'result' | 'failed'; output?: unknown; error?: unknown },
): Promise<void> {
  const type = agentResultEventName(correlationId);
  if (typeof type !== 'string') {
    throw new Error(`invalid agent-result event name: ${type.message}`);
  }
  const instance = await env.WATT_TASK.get(taskId);
  await instance.sendEvent({ type, payload: result });
}

/**
 * agent.result/failed 事件 → deliverTaskResult 的归并 payload（consumer.routeResult 用）。
 * failed 分支保留 AgentFailedPayload.reason（五态：error/timeout/terminated/rejected/invalid_output，
 *   core types.ts）——error 仅在 reason='error'/'invalid_output' 时携带，reason 是唯一恒在的失败原因，
 *   丢掉它 Workflow 侧就只剩笼统 'failed'。作为独立 reason 字段并入（非塞进 error，保留 error 的
 *   WattError 形状语义），consumer 侧 watt-task-workflow.ts 的 AgentResultEventPayload 同步声明。
 */
export function toMergedResultPayload(event: Event): {
  status: 'result' | 'failed';
  output?: unknown;
  error?: unknown;
  reason?: string;
} {
  const p = (event.payload ?? {}) as { output?: unknown; error?: unknown; reason?: unknown };
  if (event.type === 'agent.failed') {
    return {
      status: 'failed',
      error: p.error,
      reason: typeof p.reason === 'string' ? p.reason : undefined,
    };
  }
  return { status: 'result', output: p.output };
}
