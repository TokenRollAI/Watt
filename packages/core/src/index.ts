// @watt/core — 平台核心纯逻辑（判定算法 + Event 信封 + JWT 签发/验签）。无 Cloudflare 绑定、无 I/O。

// Agent Runtime 纯逻辑（§3.1 / §3.2 / §3.4）——resolveInstanceKey 已由 eventbus 段导出，
// agent 桶不重复转出（其内部复用同一函数）。
export {
  AGENT_EVENT_TYPES,
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
  type CorrelationTable,
  DEFAULT_MAX_ATTEMPTS,
  type ExpectSpec,
  expectSpecSchema,
  type FailedEventDeps,
  type GenIdFn,
  genCorrelationId,
  InMemoryCorrelationTable,
  invalidOutputFailure,
  type RouteDecision,
  routeAgentEvent,
  type SchemaViolation,
  type SpawnRequest,
  shouldRetry,
  spawnRequestSchema,
  terminatedFailedEvent,
  timeoutFailedEvent,
  type ValidateOutcome,
  validateAgentOutput,
  validateCorrelationId,
  type Waiter,
} from './agent/index.ts';
// 设备授权 device flow（§6.5d，RFC 8628 最小子集）
export {
  type CreateDeviceGrantInput,
  type CreateDeviceGrantResult,
  createDeviceGrant,
  DEVICE_CODE_EXPIRES_IN_SEC,
  DEVICE_CODE_INTERVAL_SEC,
  DEVICE_GRANT_TYPE,
  type DeviceAuthorizeResponse,
  type DeviceGrant,
  type DeviceGrantStatus,
  evaluateTokenExchange,
  generateDeviceCode,
  generateUserCode,
  isDeviceGrantExpired,
  type NowSecFn,
  normalizeUserCode,
  type OAuthErrorBody,
  type OAuthErrorCode,
  oauthError,
  type RandomBytesFn,
  type TokenExchangeOutcome,
} from './auth/device-flow.ts';
// JWT（§6.4a / §6.5a / §11.2）
export {
  buildJwks,
  DEFAULT_AGENT_TOKEN_TTL_SEC,
  DEFAULT_USER_TOKEN_TTL_SEC,
  exportJWK,
  type IssueAgentTokenInput,
  type IssueUserTokenInput,
  importPrivateJwk,
  importPublicJwk,
  type JWK,
  JWT_ALG,
  JWT_CRV,
  type NowFn,
  type PrivateKeyMaterial,
  type PublicKeyMaterial,
  type SigningKey,
  signAgentToken,
  signUserToken,
  type TokenMeta,
  type VerifiedToken,
  verifyToken,
} from './auth/jwt.ts';
// 判定算法（§6.4c）
export { type AuthorizeInput, authorize } from './authz/authorize.ts';
export {
  actionMatches,
  grantsCover,
  policyAllows,
  resourceMatches,
  subjectMatches,
} from './authz/match.ts';
export { toolActionFor } from './authz/tool-action.ts';
// Context Layer 纯逻辑（§4.1 ContextProvider / §4.2 ContextRegistry）
export * from './context/index.ts';
export {
  DEFAULT_DEDUPE_WINDOW_MS,
  type DedupeRecord,
  type DedupeResult,
  type DedupeStore,
  InMemoryDedupeStore,
  type ResolveDedupeInput,
  resolveDedupe,
} from './event/dedupe.ts';

// Event 信封（§1 / §2.3）
export {
  EVENT_MAX_BYTES,
  eventByteSize,
  type NormalizeDeps,
  normalizeEvent,
  validateEventSize,
} from './event/envelope.ts';
export {
  type BodyBytes,
  computeSignature,
  timingSafeEqual,
  verifySignature,
} from './eventbus/hmac.ts';
// Event Gateway（§2.1–2.3）：订阅匹配 / instanceBy 路由 / 入站管线 / 出站鉴权
export { WATT_HMAC } from './eventbus/hmac-constants.ts';
export {
  type InboundAdapter,
  type InboundResult,
  processInbound,
  type RawInbound,
} from './eventbus/inbound.ts';
export { type InstanceKeyResult, resolveInstanceKey } from './eventbus/instance-key.ts';
export { matchesSubscription } from './eventbus/matches.ts';
export {
  authorizeOutbound,
  type OutboundAccessRequest,
  type OutboundRequestResult,
  outboundAccessRequest,
} from './eventbus/outbound.ts';
export {
  type ActionButton,
  actionButtonSchema,
  type ChannelConfig,
  channelConfigSchema,
  type InstanceBy,
  instanceBySchema,
  type MessageContent,
  messageContentSchema,
  type OutboundMessage,
  outboundMessageSchema,
  type Subscription,
  type SubscriptionMatch,
  type SubscriptionSink,
  subscriptionMatchSchema,
  subscriptionSchema,
  subscriptionSinkSchema,
} from './eventbus/types.ts';
// 类型层
export * from './types.ts';
