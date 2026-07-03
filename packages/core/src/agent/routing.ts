import type { Event } from '../types.ts';
import type { CorrelationTable, GenIdFn, Waiter } from './correlation.ts';
import type { AgentFailedPayload } from './types.ts';

/**
 * §3.4 六条路由规则的纯判定 + 超时/终止代发事件构造——无 I/O。
 *
 * routeAgentEvent 输入一个 agent.result/agent.failed 事件，查 CorrelationTable 得判定：
 *   规则 1/2 定向回送 → deliver（带 waiter，投给 Send 调用者 / 父实例）；
 *   规则 5 等待方消失 → drop-no-waiter（到达后无记录，丢弃记审计）；
 *   规则 6 结果去重 → drop-duplicate（同 correlationId 已 settled，丢弃记审计）；
 *   无 correlationId → not-correlated（不属此路由，走普通订阅匹配）。
 *
 * 规则 3 幂等锁定：超时代发时 expire() 已把 correlation 标记 settled；真实结果晚到 →
 *   resolve 返回 null → drop-duplicate（测试锁定）。
 */

/** routeAgentEvent 的判定结果。 */
export type RouteDecision =
  | { kind: 'deliver'; waiter: Waiter } // 规则 1/2：定向回送给等待方
  | { kind: 'drop-no-waiter' } // 规则 5：等待方已消失（无记录）
  | { kind: 'drop-duplicate' } // 规则 6：同 correlationId 已 settled
  | { kind: 'not-correlated' }; // 无 correlationId：走普通订阅匹配

/** agent.result / agent.failed 的规范事件类型（§1 L108 / §3.4）。 */
const AGENT_RESULT_TYPE = 'agent.result';
const AGENT_FAILED_TYPE = 'agent.failed';

/**
 * 从 agent.result/agent.failed 事件读 correlationId。
 * 非这两类事件、或 payload 无 correlationId 字段 → undefined（判为 not-correlated）。
 */
function readCorrelationId(event: Event): string | undefined {
  if (event.type !== AGENT_RESULT_TYPE && event.type !== AGENT_FAILED_TYPE) {
    return undefined;
  }
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const cid = (payload as { correlationId?: unknown }).correlationId;
  return typeof cid === 'string' && cid.length > 0 ? cid : undefined;
}

/**
 * 六规则的纯判定（规则 1/2/5/6 + not-correlated）。
 * 对带 correlationId 的 result/failed 查表 resolve：
 *   - 之前不存在记录（等待方先消失或从未登记）→ drop-no-waiter（规则 5）；
 *   - 已 settled（重复结果 / 超时后真实结果晚到）→ drop-duplicate（规则 6、规则 3 幂等）；
 *   - 首次命中 → deliver（规则 1/2）。
 * nowMs 参数保留以对齐 gateway 调用签名（超时判定在 expire()，此处不用但不移除以稳定接口）。
 */
export function routeAgentEvent(
  event: Event,
  table: CorrelationTable,
  _nowMs: number,
): RouteDecision {
  const correlationId = readCorrelationId(event);
  if (correlationId === undefined) {
    return { kind: 'not-correlated' };
  }
  // resolve 对「从未登记」与「已 settled」都返回 null，需先 hasPending 探测以区分：
  //   无记录（等待方先消失被清理 / 伪造 correlationId）→ drop-no-waiter（规则 5）；
  //   有记录但 resolve 为 null（已 settled）→ drop-duplicate（规则 6、规则 3 幂等）。
  if (!table.hasPending(correlationId)) {
    return { kind: 'drop-no-waiter' };
  }
  const waiter = table.resolve(correlationId);
  if (waiter === null) {
    return { kind: 'drop-duplicate' };
  }
  return { kind: 'deliver', waiter };
}

// ─── 超时/终止代发事件构造 ───────────────────────────────────────────────

/** 构造代发 failed 事件所需的注入依赖（id/时刻生成，保持纯逻辑决定性可测）。 */
export interface FailedEventDeps {
  genId: GenIdFn;
  nowIso: () => string;
  traceId: string;
}

/** 内部：构造一个 agent.failed 事件信封（source.kind='system'，平台代发）。 */
function buildFailedEvent(payload: AgentFailedPayload, deps: FailedEventDeps): Event {
  return {
    id: deps.genId(),
    source: { kind: 'system' },
    type: AGENT_FAILED_TYPE,
    payload,
    occurredAt: deps.nowIso(),
    traceId: deps.traceId,
  };
}

/**
 * 规则 3 超时代发：expect.timeoutMs 到期未见结果 → agent.failed(reason='timeout')。
 * 幂等由 CorrelationTable.expire 置 settled 保证（真实结果晚到 → drop-duplicate）。
 */
export function timeoutFailedEvent(
  correlationId: string,
  instanceId: string,
  deps: FailedEventDeps,
): Event {
  return buildFailedEvent({ correlationId, instanceId, reason: 'timeout' }, deps);
}

/**
 * 规则 4 终止即失败：等待中实例被 Terminate（含级联）→ agent.failed(reason='terminated')。
 */
export function terminatedFailedEvent(
  correlationId: string,
  instanceId: string,
  deps: FailedEventDeps,
): Event {
  return buildFailedEvent({ correlationId, instanceId, reason: 'terminated' }, deps);
}

/** 便于测试与调用方引用：规范事件类型常量（§1 L108 / §3.4）。 */
export const AGENT_EVENT_TYPES = {
  result: AGENT_RESULT_TYPE,
  failed: AGENT_FAILED_TYPE,
} as const;
