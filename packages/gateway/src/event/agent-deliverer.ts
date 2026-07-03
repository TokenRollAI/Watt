/**
 * AgentDeliverer 生产实现（Proto §3.4 结果路由 + §2.3 agent sink 投递）——consumer 接线。
 *
 * routeResult（§3.4 定向回送）：agent.result/agent.failed 进队列被 consumer 消费时，先查
 *   AgentCorrelation DO：
 *     - 无记录（从未登记 / 等待方先消失）→ drop-no-waiter（记 console 审计，规则 5）；
 *     - 已 settled（重复结果 / 超时后晚到）→ drop-duplicate（记 console，规则 6 / 规则 3 幂等）；
 *     - 首次命中 → resolve 得 waiter：kind='agent' → 投递该实例 onEvent（规则 1/2 定向回送）；
 *       kind='task' → Phase 5 Workflows waitForEvent（此处占位记 console）。
 *
 * deliverToAgent（§2.3 规则 1/2 agent 订阅）：agent sink 命中 → resolveInstanceKey 求实例键 →
 *   AgentRuntime.spawn（复用 = 幂等）+ send 投递事件（无 expect，即发即忘；有订阅语义的结果回送
 *   由后续 agent.result 走 routeResult）。
 */

import { type Event, resolveInstanceKey } from '@watt/core';
import { getAgentByName } from 'agents';
import type { AgentCorrelation } from '../agent/agent-correlation.ts';
import type { AgentInstance, AgentInstanceRpc } from '../agent/agent-instance.ts';
import { AgentRuntime, defaultRuntimeDeps } from '../agent/agent-runtime.ts';
import type { Bindings } from '../env.ts';
import type { AgentDeliverer } from './consumer.ts';

const AGENT_RESULT_TYPE = 'agent.result';
const AGENT_FAILED_TYPE = 'agent.failed';

/** 从 agent.result/failed 事件读 correlationId（非这两类 / 无 correlationId → undefined）。 */
function readCorrelationId(event: Event): string | undefined {
  if (event.type !== AGENT_RESULT_TYPE && event.type !== AGENT_FAILED_TYPE) return undefined;
  const p = event.payload;
  if (typeof p !== 'object' || p === null) return undefined;
  const cid = (p as { correlationId?: unknown }).correlationId;
  return typeof cid === 'string' && cid.length > 0 ? cid : undefined;
}

function correlationStub(env: Bindings): DurableObjectStub<AgentCorrelation> {
  return env.AGENT_CORRELATION.get(env.AGENT_CORRELATION.idFromName('correlation'));
}

async function instanceRpc(env: Bindings, key: string): Promise<AgentInstanceRpc> {
  const stub = await getAgentByName<Cloudflare.Env, AgentInstance>(env.AGENT_INSTANCE, key);
  return stub as unknown as AgentInstanceRpc;
}

/** 生产 AgentDeliverer：真实 AgentCorrelation DO + AgentInstance + AgentRuntime。 */
export function defaultAgentDeliverer(env: Bindings): AgentDeliverer {
  return {
    async routeResult(event: Event): Promise<void> {
      const correlationId = readCorrelationId(event);
      if (correlationId === undefined) return; // not-correlated：走普通订阅（此处不处理）。
      const corr = correlationStub(env);
      const has = await corr.hasPending(correlationId);
      if (!has) {
        console.log('agent deliverer: drop-no-waiter (rule 5)', {
          correlationId,
          eventId: event.id,
        });
        return;
      }
      const waiter = await corr.resolve(correlationId);
      if (waiter === null) {
        console.log('agent deliverer: drop-duplicate (rule 6 / rule 3 idempotent)', {
          correlationId,
          eventId: event.id,
        });
        return;
      }
      if (waiter.kind === 'agent') {
        // 规则 1/2：定向回送给等待方实例（其 onEvent 收到 result/failed，无二次 expect）。
        const stub = await instanceRpc(env, waiter.id);
        await stub.onEvent({ event });
      } else {
        // Task 等待方 → Phase 5 Workflows waitForEvent（占位）。
        console.log('agent deliverer: task waiter delivery deferred to Phase 5', {
          correlationId,
          waiter: waiter.id,
        });
      }
    },

    async deliverToAgent(definition: string, instanceBy: string, event: Event): Promise<void> {
      const key = resolveInstanceKey(
        { kind: 'agent', definition, instanceBy: instanceBy as 'session' | 'event' | 'singleton' },
        event,
      );
      if ('error' in key) {
        console.error('agent deliverer: resolveInstanceKey failed', {
          definition,
          instanceBy,
          error: key.error.message,
        });
        return;
      }
      const runtime = new AgentRuntime(defaultRuntimeDeps(env));
      // Spawn 幂等（同键复用）——订阅投递用 instanceKey=解析键；无 expect（订阅语义结果走 result 事件）。
      const spawn = await runtime.spawn({ definition, instanceKey: key.key });
      if ('code' in spawn) {
        console.error('agent deliverer: spawn failed', { definition, error: spawn.message });
        return;
      }
      await runtime.send(key.key, event);
    },
  };
}
