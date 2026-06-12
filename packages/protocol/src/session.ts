/**
 * Session 资源与直连会话消息契约。
 * 见 docs/protocol-v1.md「Session 资源」。
 *
 * 不变量：会话不是 Run。事件字段 run_id 与 session_id 互斥，
 * 由 events.ts 的 discriminated union 在 schema 层锁死。
 */
import { z } from 'zod';
import { AgentId, AgentVersionId, ResourceRef, SessionId } from './ids.js';

export const SessionStatus = z.enum(['active', 'archived']);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const Session = z.object({
  id: SessionId,
  agentId: AgentId,
  /** 创建时绑定的版本 */
  agentVersionId: AgentVersionId,
  title: z.string().optional(),
  createdAt: z.iso.datetime(),
  lastActiveAt: z.iso.datetime(),
  status: SessionStatus,
});
export type Session = z.infer<typeof Session>;

/** POST /agents/:agentId/sessions/:sessionId/messages */
export const SessionMessageRequest = z.object({
  message: z.string().min(1),
  /** 用户可把 artifact / checkpoint 拽进对话 */
  refs: z.array(ResourceRef).default([]),
});
export type SessionMessageRequest = z.infer<typeof SessionMessageRequest>;

export const SessionMessageResponse = z.object({
  reply: z.string(),
  usage: z.object({
    totalTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }),
  /** 会话内工具调用的审计摘要 */
  toolCalls: z
    .array(z.object({ tool: z.string(), status: z.enum(['ok', 'failed']) }))
    .optional(),
});
export type SessionMessageResponse = z.infer<typeof SessionMessageResponse>;
