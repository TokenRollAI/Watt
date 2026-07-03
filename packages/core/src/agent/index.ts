// Agent Runtime 纯逻辑（Proto §3.1 AgentRegistry / §3.2 AgentRuntime / §3.4 完成协议）——
// 无 Cloudflare 绑定、无 I/O。gateway 以 DO/Agents SDK 实现，复用本目录的判定/状态机/校验。

// Spawn 幂等键：复用 eventbus 的 resolveInstanceKey（§3.2 L367 幂等键；不复制实现）。
// SpawnRequest.instanceKey 显式给时直接用；缺省从订阅 sink.instanceBy 推导即经此函数。
export { type InstanceKeyResult, resolveInstanceKey } from '../eventbus/instance-key.ts';

// correlationId 校验 + correlation 等待表状态机（§3.4）
export {
  type CorrelationTable,
  type GenIdFn,
  genCorrelationId,
  InMemoryCorrelationTable,
  validateCorrelationId,
  type Waiter,
} from './correlation.ts';
// ExpectSpec.schema 校验 + 重试策略（§3.2 / §3.4）
export {
  DEFAULT_MAX_ATTEMPTS,
  invalidOutputFailure,
  type SchemaViolation,
  shouldRetry,
  type ValidateOutcome,
  validateAgentOutput,
} from './expect-schema.ts';
// §3.4 六规则路由判定 + 超时/终止代发事件构造
export {
  AGENT_EVENT_TYPES,
  type FailedEventDeps,
  type RouteDecision,
  routeAgentEvent,
  terminatedFailedEvent,
  timeoutFailedEvent,
} from './routing.ts';
// 类型层（§3.1 / §3.2 / §3.4）
export {
  type AgentDefinition,
  type AgentEntry,
  type AgentFailedPayload,
  type AgentFailedReason,
  type AgentResultPayload,
  type AgentRuntimeKind,
  agentDefinitionSchema,
  agentEntrySchema,
  agentFailedPayloadSchema,
  agentFailedReasonSchema,
  agentResultPayloadSchema,
  agentRuntimeSchema,
  type ExpectSpec,
  expectSpecSchema,
  type SpawnRequest,
  spawnRequestSchema,
} from './types.ts';
