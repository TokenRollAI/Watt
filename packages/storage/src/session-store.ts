/**
 * SessionStore：Session 记录与消息历史（直连会话路径，docs 决策见执行模型）。
 *
 * 三道结构防线的第三道（存储隔离）在本接口体现为：
 * - 接口签名上不出现 RunId 类型——任何带 run 语义的东西在类型层面就进不来。
 * - appendEvent 只接受 SessionEvent（scope === 'session'）；RunEvent 被拒
 *   （运行时校验 + 类型签名双重保证）。
 * - sessionId 由 SessionId schema 校验，run id 语法无法通过（结构防线第一道）。
 *
 * 消息历史语义：
 * - 消息序号 messageSeq 严格单调（期望 = 当前长度）。
 * - 幂等 key 用 @watt/protocol 的 idempotencyKeyForSessionMessage（session_id +
 *   messageSeq 派生）。同 key 重复写返回已有结果而非重复追加（同 Session 单飞，
 *   重发安全）。
 */
import type { SessionEvent } from '@watt/protocol';
import { SessionId, idempotencyKeyForSessionMessage } from '@watt/protocol';

export type SessionStatus = 'active' | 'archived';

export interface SessionRecord {
  sessionId: string;
  agentId: string;
  agentVersionId: string;
  title?: string;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
}

export interface CreateSessionInput {
  sessionId: string;
  agentId: string;
  agentVersionId: string;
  title?: string;
}

export type SessionMessageRole = 'user' | 'assistant';

/** 一条会话消息。绝不含 runId——会话历史不进 Run 路径。 */
export interface SessionMessage {
  sessionId: string;
  /** 单调序号，= 在历史中的位置 */
  messageSeq: number;
  role: SessionMessageRole;
  content: string;
  /** 由 session_id + messageSeq 派生的幂等 key，重发去重用 */
  idempotencyKey: string;
  createdAt: string;
}

export interface AppendMessageInput {
  sessionId: string;
  /** 期望写入位置；必须等于当前历史长度，否则抛 conflict */
  messageSeq: number;
  role: SessionMessageRole;
  content: string;
}

export interface SessionStore {
  /** 创建 Session 记录。sessionId 必须通过 SessionId 校验；重复抛 conflict。 */
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  getSession(sessionId: string): Promise<SessionRecord>;
  listSessions(agentId?: string): Promise<SessionRecord[]>;
  updateSessionStatus(sessionId: string, status: SessionStatus): Promise<SessionRecord>;

  /**
   * 追加一条消息。约束：
   * - messageSeq 必须严格等于当前历史长度（单调，无跳号）。
   * - 幂等 key 由 session_id + messageSeq 派生；若该 key 已存在则返回已有消息
   *   而不重复追加（重发安全）。注意：这意味着对同一 messageSeq 重复 append
   *   返回已有那条，不抛 conflict——这是幂等而非冲突。
   */
  appendMessage(input: AppendMessageInput): Promise<SessionMessage>;

  /** 读消息历史区间 [fromSeq, toSeq)（半开），省略到末尾。越界收敛。 */
  readMessages(sessionId: string, fromSeq?: number, toSeq?: number): Promise<SessionMessage[]>;

  /** 当前消息数（= 下一个合法 messageSeq）。 */
  messageCount(sessionId: string): Promise<number>;

  /**
   * append 一条会话事件。约束：
   * - event 必须是 SessionEvent（scope === 'session'），RunEvent 被拒。
   * - event.sessionId 必须等于参数 sessionId。
   * - event.eventIndex 严格等于当前事件日志长度（单调，重复/跳号抛 conflict）。
   */
  appendEvent(sessionId: string, event: SessionEvent): Promise<void>;
  readEvents(sessionId: string, fromIndex?: number, toIndex?: number): Promise<SessionEvent[]>;
  eventCount(sessionId: string): Promise<number>;
}

export const assertSessionId = (id: string): string => SessionId.parse(id);

/** 重新导出协议的幂等 key 派生，供实现与调用方使用同一语义。 */
export { idempotencyKeyForSessionMessage };
