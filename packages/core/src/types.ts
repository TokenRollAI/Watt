import { z } from 'zod';

/**
 * 平台核心类型层（Proto §0.1–0.3 / §1 / §3.1 / §6 / §7）。
 * 全部以 zod schema 定义、推导 TS 类型（LOOP 纪律 4：校验用 zod）。
 * Phase 1 只承载判定算法 + Event 信封所需的最小面。
 */

// ─── URI / Timestamp（§0.2）───────────────────────────────────────────────
export const uriSchema = z.string();
export const timestampSchema = z.string(); // ISO 8601 UTC

// ─── PrincipalRef（§0.3 L73）──────────────────────────────────────────────
// "user:alice" | "service:ci" | "agent:finance"（定义级）。实例身份走 claims.agent_inst，不作 principal。
export const principalRefSchema = z.string();
export type PrincipalRef = z.infer<typeof principalRefSchema>;

// ─── AgentChainRef（§0.3 L75–80）─────────────────────────────────────────
// chain = 根→当前的链段序列：实例 ID，或系统段 "cron:<jobId>"。
export const agentChainRefSchema = z.object({
  instanceId: z.string(),
  chain: z.array(z.string()),
});
export type AgentChainRef = z.infer<typeof agentChainRefSchema>;

// ─── CallContext（§0.3 L65–72）───────────────────────────────────────────
export const callContextSchema = z.object({
  principal: principalRefSchema,
  roles: z.array(z.string()),
  agent: agentChainRefSchema.optional(),
  traceId: z.string(),
});
export type CallContext = z.infer<typeof callContextSchema>;

// ─── Grant（§3.1 L328 / §7 L757）─────────────────────────────────────────
// AgentDefinition.grants 与 CronJob.action(script).grants 同形。
export const grantSchema = z.object({
  resources: z.array(uriSchema),
  actions: z.array(z.string()),
});
export type Grant = z.infer<typeof grantSchema>;

// ─── AgentDefinition 最小面（§3.1，Phase 1 只需 grants 相关）──────────────
export const agentDefinitionSchema = z.object({
  name: z.string(),
  grants: z.array(grantSchema),
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

// ─── CronJob 最小面（§7 L741–761，判定需要 enabled + action.kind/grants）──
export const cronActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('publish'),
    event: z.object({
      type: z.string(),
      payload: z.unknown().optional(),
      session: z.string().optional(),
    }),
  }),
  z.object({
    kind: z.literal('agent'),
    definition: z.string(),
    input: z.unknown().optional(),
    instanceBy: z.enum(['singleton', 'event']).optional(),
  }),
  z.object({
    kind: z.literal('script'),
    scriptRef: uriSchema,
    grants: z.array(grantSchema),
  }),
]);
export type CronAction = z.infer<typeof cronActionSchema>;

export const cronJobSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  action: cronActionSchema,
});
export type CronJob = z.infer<typeof cronJobSchema>;

// ─── Policy（§6.2 L651–658）──────────────────────────────────────────────
export const policyEffectSchema = z.enum(['allow', 'deny']);
export type PolicyEffect = z.infer<typeof policyEffectSchema>;

export const policySchema = z.object({
  id: z.string(),
  subject: z.string(), // "user:" | "service:" | "role:" | "agent:" | "agent-instance:" | "*"
  resource: z.string(), // URI pattern，前缀通配 "tool://finance/*"
  actions: z.array(z.string()), // ["*"] = 全动作
  effect: policyEffectSchema,
  condition: z.record(z.string(), z.string()).optional(),
});
export type Policy = z.infer<typeof policySchema>;

// ─── AccessRequest / AccessDecision（§6.1 L625–636）──────────────────────
export const accessDecisionSchema = z.object({
  allow: z.boolean(),
  reason: z.string().optional(),
  obligations: z.array(z.enum(['require_confirm', 'audit_verbose'])).optional(),
});
export type AccessDecision = z.infer<typeof accessDecisionSchema>;

// ─── Token claims（§6.4a L681–692）───────────────────────────────────────
// Agent Token 有 agent_def/agent_inst/chain；user token 无这三段（§6.5a）。
export const tokenClaimsSchema = z.object({
  sub: principalRefSchema,
  roles: z.array(z.string()),
  agent_def: z.string().optional(),
  agent_inst: z.string().optional(),
  chain: z.array(z.string()).optional(),
  trace: z.string().optional(),
});
export type TokenClaims = z.infer<typeof tokenClaimsSchema>;

// ─── EventSource（§1 L129–133）───────────────────────────────────────────
export const eventSourceSchema = z.object({
  kind: z.enum(['im', 'webhook', 'email', 'cron', 'agent', 'system']),
  channel: z.string().optional(),
  ref: z.string().optional(),
});
export type EventSource = z.infer<typeof eventSourceSchema>;

export const channelUserSchema = z.object({
  channel: z.string(),
  userId: z.string(),
});
export type ChannelUser = z.infer<typeof channelUserSchema>;

// ─── Event 信封（§1 L103–124）────────────────────────────────────────────
export const eventSchema = z.object({
  id: z.string(), // 平台生成，全局唯一
  source: eventSourceSchema,
  type: z.string(), // 开放集合，点分命名
  session: z.string().optional(),
  principal: principalRefSchema.optional(),
  channelUser: channelUserSchema.optional(),
  dedupeKey: z.string().optional(),
  payload: z.unknown(),
  raw: z.unknown().optional(),
  occurredAt: timestampSchema,
  traceId: z.string(),
});
export type Event = z.infer<typeof eventSchema>;

// ─── Publish 入参（§2.3 L259）────────────────────────────────────────────
// Publish(event: Omit<Event, 'id'|'traceId'|'occurredAt'>): { eventId: string }
// 平台补齐这三字段。principal 不在 Omit 但仍由平台在 channelUser 存在时覆写（doc-gap #10）。
export type EventInput = Omit<Event, 'id' | 'traceId' | 'occurredAt'>;
