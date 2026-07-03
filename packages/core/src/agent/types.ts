import { z } from 'zod';
import { uriSchema } from '../types.ts';

/**
 * Agent Runtime 类型层（Proto §3.1 AgentDefinition / §3.2 SpawnRequest·ExpectSpec /
 * §3.4 AgentResultPayload·AgentFailedPayload）——纯 zod，无 Cloudflare 绑定。
 * 复用 ../types.ts 的 uriSchema（§0.1）。
 */

// ─── AgentDefinition 最小面（§3.1 L318-339）──────────────────────────────
// entry 三态（do-class|container|endpoint）由 runtime 决定形态；Phase 4 只用 light(do-class)，
// 但 schema 承载全部三态以对齐规范。model?/subscriptions? 可选。
export const agentRuntimeSchema = z.enum(['light', 'heavy', 'external']);
export type AgentRuntimeKind = z.infer<typeof agentRuntimeSchema>;

export const agentEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('do-class'), className: z.string() }),
  z.object({
    kind: z.literal('container'),
    image: z.string(),
    cmd: z.array(z.string()).optional(),
    bindings: z.array(z.object({ name: z.string(), secretRef: z.string() })).optional(),
    workspace: z.object({ repo: z.string(), ref: z.string().optional() }).optional(),
  }),
  z.object({
    kind: z.literal('endpoint'),
    url: z.string(),
    protocol: z.enum(['htbp', 'mcp', 'http']),
  }),
]);
export type AgentEntry = z.infer<typeof agentEntrySchema>;

// grants 与 ../types.ts 的 grantSchema 同形（§3.1 L328）；此处独立声明避免跨文件耦合的循环。
const agentGrantSchema = z.object({
  resources: z.array(uriSchema),
  actions: z.array(z.string()),
});

// 声明式订阅（§3.1 L334-338 / §2.3）：match + instanceBy，Write 时平台自动建立。
const agentSubscriptionSchema = z.object({
  match: z.object({
    type: z.string().optional(),
    sourceKind: z.enum(['im', 'webhook', 'email', 'cron', 'agent', 'system']).optional(),
    channel: z.string().optional(),
    session: z.string().optional(),
  }),
  instanceBy: z.enum(['session', 'event', 'singleton']),
});

export const agentDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  runtime: agentRuntimeSchema,
  entry: agentEntrySchema,
  model: z.object({ preferred: z.string(), fallback: z.array(z.string()).optional() }).optional(),
  grants: z.array(agentGrantSchema),
  contextNamespaces: z.array(z.string()),
  toolScopes: z.array(z.string()),
  subscriptions: z.array(agentSubscriptionSchema).optional(),
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

// ─── ExpectSpec（§3.2 L374-382）──────────────────────────────────────────
// correlationId 缺省由平台生成回传；timeoutMs 超时代发（§3.4 规则 3）；
// schema 为 JSON Schema object，约束 agent.result.output 形状（§3.4 校验重试）。
export const expectSpecSchema = z.object({
  correlationId: z.string().optional(),
  timeoutMs: z.number().optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
});
export type ExpectSpec = z.infer<typeof expectSpecSchema>;

// ─── SpawnRequest（§3.2 L365-372）────────────────────────────────────────
// definition = AgentDefinition.name；instanceKey 幂等键（同键同实例，§3.2 L367）；
// ttl 秒到期自动 Terminate；expect 存在时 Spawn 必返 correlationId（子实例结果自动回父，规则 2）。
export const spawnRequestSchema = z.object({
  definition: z.string(),
  instanceKey: z.string().optional(),
  input: z.unknown().optional(),
  ttl: z.number().optional(),
  expect: expectSpecSchema.optional(),
});
export type SpawnRequest = z.infer<typeof spawnRequestSchema>;

// ─── AgentResultPayload（§3.4 L420-425）──────────────────────────────────
// Event.type = "agent.result"；output ≤1 MiB（更大放 Context，用 artifacts 引用）。
export const agentResultPayloadSchema = z.object({
  correlationId: z.string(),
  instanceId: z.string(),
  output: z.unknown(),
  artifacts: z.array(uriSchema).optional(),
});
export type AgentResultPayload = z.infer<typeof agentResultPayloadSchema>;

// ─── AgentFailedPayload（§3.4 L427-432）──────────────────────────────────
// Event.type = "agent.failed"；reason 五态；error 在 reason='error'/'invalid_output' 时携带。
export const agentFailedReasonSchema = z.enum([
  'error',
  'timeout',
  'terminated',
  'rejected',
  'invalid_output',
]);
export type AgentFailedReason = z.infer<typeof agentFailedReasonSchema>;

// error 复用 WattError 形状（§0.2）——此处用轻量 schema 承载，避免依赖 @watt/shared 的 zod 缺失。
const wattErrorShapeSchema = z.object({
  code: z.enum([
    'not_found',
    'permission_denied',
    'invalid_argument',
    'conflict',
    'unavailable',
    'rate_limited',
    'internal',
  ]),
  message: z.string(),
  retryable: z.boolean(),
});

export const agentFailedPayloadSchema = z.object({
  correlationId: z.string(),
  instanceId: z.string(),
  reason: agentFailedReasonSchema,
  error: wattErrorShapeSchema.optional(),
});
export type AgentFailedPayload = z.infer<typeof agentFailedPayloadSchema>;
