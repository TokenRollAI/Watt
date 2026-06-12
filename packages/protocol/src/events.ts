/**
 * 事件契约：run 事件与 session 事件互斥（结构性强制，第二道防线，
 * 第一道是 ID 语法）。trace 字段进协议：平台没有原生分布式追踪，
 * run_id / 节点 id / 父 span 必须由每条消息透传。
 */
import { z } from 'zod';
import { RunId, SessionId, WorkspaceId } from './ids.js';

const base = z.object({
  workspaceId: WorkspaceId,
  /** 单调递增，重放/续传以此去重 */
  eventIndex: z.number().int().nonnegative(),
  at: z.iso.datetime(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});

/** Run 维度事件：有 runId、必无 sessionId */
export const RunEvent = base.extend({
  scope: z.literal('run'),
  runId: RunId,
});
export type RunEvent = z.infer<typeof RunEvent>;

/** Session 维度事件：有 sessionId、必无 runId */
export const SessionEvent = base.extend({
  scope: z.literal('session'),
  sessionId: SessionId,
});
export type SessionEvent = z.infer<typeof SessionEvent>;

export const WattEvent = z.discriminatedUnion('scope', [RunEvent, SessionEvent]);
export type WattEvent = z.infer<typeof WattEvent>;
