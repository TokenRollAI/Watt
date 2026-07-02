import { z } from 'zod';
import { eventSourceSchema } from '../types.ts';

/**
 * Event Gateway 类型层（Proto §2.1–2.3）——EventBus 的 Subscription / ChannelConfig /
 * OutboundMessage 形状。全部以 zod 定义、推导 TS 类型（LOOP 纪律 4：校验用 zod）。
 * 复用 ../types.ts 的 Event / EventSource（§1）。
 */

// ─── SubscriptionMatch（§2.3 L272-284）───────────────────────────────────
// 全部条件 AND；缺省字段不参与匹配。type 支持后缀通配 "im.*"。
// sourceKind ↔ event.source.kind；channel ↔ event.source.channel；session ↔ event.session。
export const subscriptionMatchSchema = z.object({
  type: z.string().optional(),
  sourceKind: eventSourceSchema.shape.kind.optional(),
  channel: z.string().optional(),
  session: z.string().optional(),
});
export type SubscriptionMatch = z.infer<typeof subscriptionMatchSchema>;

// ─── instanceBy（§2.3 L279-283 / §3.1 L332-335）──────────────────────────
// 'session' → 同一 session 路由到同一 Agent 实例；'event' → 一事一实例；'singleton' → 全局唯一。
export const instanceBySchema = z.enum(['session', 'event', 'singleton']);
export type InstanceBy = z.infer<typeof instanceBySchema>;

// ─── SubscriptionSink（§2.3 L279-281）────────────────────────────────────
// 三种 sink kind：agent{definition,instanceBy} / task{workflow} / webhook{url}。
export const subscriptionSinkSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('agent'),
    definition: z.string(),
    instanceBy: instanceBySchema,
  }),
  z.object({
    kind: z.literal('task'),
    workflow: z.string(),
  }),
  z.object({
    kind: z.literal('webhook'),
    url: z.string(),
  }),
]);
export type SubscriptionSink = z.infer<typeof subscriptionSinkSchema>;

// ─── Subscription（§2.3 L271-283）────────────────────────────────────────
export const subscriptionSchema = z.object({
  id: z.string().optional(),
  match: subscriptionMatchSchema,
  sink: subscriptionSinkSchema,
});
export type Subscription = z.infer<typeof subscriptionSchema>;

// ─── ChannelConfig（§2.2 L242-249）───────────────────────────────────────
export const channelConfigSchema = z.object({
  id: z.string(),
  adapter: z.string(),
  enabled: z.boolean(),
  settings: z.record(z.string(), z.unknown()),
  defaultAgent: z.string().optional(),
});
export type ChannelConfig = z.infer<typeof channelConfigSchema>;

// ─── OutboundMessage / MessageContent（§1 L139-158）──────────────────────
// 出站鉴权点（§2.3）需校验 payload 形状：channel + target 决定 event://<channel>/<target>。
export const actionButtonSchema = z.object({
  id: z.string(),
  label: z.string(),
  signal: z
    .object({
      taskId: z.string(),
      checkpoint: z.string(),
      decision: z.enum(['approve', 'reject', 'custom']),
    })
    .optional(),
});
export type ActionButton = z.infer<typeof actionButtonSchema>;

export const messageContentSchema = z.object({
  text: z.string().optional(),
  blocks: z.array(z.unknown()).optional(),
  actions: z.array(actionButtonSchema).optional(),
});
export type MessageContent = z.infer<typeof messageContentSchema>;

export const outboundMessageSchema = z.object({
  channel: z.string(),
  target: z.string(),
  content: messageContentSchema,
  replyTo: z.string().optional(),
});
export type OutboundMessage = z.infer<typeof outboundMessageSchema>;
