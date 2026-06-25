/**
 * SessionStore 的内存实现。
 *
 * 互斥保证：appendEvent 用 SessionEventSchema.parse，RunEvent（scope === 'run'）
 * 在此被拒；sessionId 用 SessionId 校验，run id 语法天然不通过。
 *
 * 消息幂等：以 idempotencyKeyForSessionMessage(sessionId, messageSeq) 为去重键。
 * 同 key 已存在则返回已有消息，不重复追加（同 Session 单飞，命令重发安全）。
 */
import type { SessionEvent } from '@watt/protocol';
import {
  SessionEvent as SessionEventSchema,
  idempotencyKeyForSessionMessage,
} from '@watt/protocol';
import { conflict, notFound } from '../errors.js';
import type {
  AppendMessageInput,
  CreateSessionInput,
  SessionMessage,
  SessionRecord,
  SessionStatus,
  SessionStore,
} from '../session-store.js';
import { assertSessionId } from '../session-store.js';

interface SessionCell {
  record: SessionRecord;
  messages: SessionMessage[];
  /** 幂等 key -> 已写入消息，去重用 */
  byKey: Map<string, SessionMessage>;
  events: SessionEvent[];
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionCell>();

  private cell(sessionId: string): SessionCell {
    const id = assertSessionId(sessionId);
    const cell = this.sessions.get(id);
    if (!cell) throw notFound(`session not found: ${id}`);
    return cell;
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const sessionId = assertSessionId(input.sessionId);
    if (this.sessions.has(sessionId)) throw conflict(`session already exists: ${sessionId}`);
    const now = new Date().toISOString();
    const record: SessionRecord = {
      sessionId,
      agentId: input.agentId,
      agentVersionId: input.agentVersionId,
      status: 'active',
      createdAt: now,
      lastActiveAt: now,
      ...(input.title ? { title: input.title } : {}),
    };
    this.sessions.set(sessionId, { record, messages: [], byKey: new Map(), events: [] });
    return { ...record };
  }

  async getSession(sessionId: string): Promise<SessionRecord> {
    return { ...this.cell(sessionId).record };
  }

  async listSessions(agentId?: string): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .map((c) => c.record)
      .filter((r) => agentId === undefined || r.agentId === agentId)
      .map((r) => ({ ...r }));
  }

  async updateSessionStatus(sessionId: string, status: SessionStatus): Promise<SessionRecord> {
    const cell = this.cell(sessionId);
    cell.record = { ...cell.record, status, lastActiveAt: new Date().toISOString() };
    return { ...cell.record };
  }

  async appendMessage(input: AppendMessageInput): Promise<SessionMessage> {
    const sessionId = assertSessionId(input.sessionId);
    const cell = this.cell(sessionId);
    const key = idempotencyKeyForSessionMessage(sessionId, input.messageSeq);
    // 幂等：同 key 已写入则返回已有，不重复追加。
    const existing = cell.byKey.get(key);
    if (existing) return { ...existing };
    // 单调：messageSeq 必须等于当前长度。
    const expected = cell.messages.length;
    if (input.messageSeq !== expected) {
      throw conflict(
        `messageSeq must be strictly monotonic: expected ${expected}, got ${input.messageSeq}`,
      );
    }
    const message: SessionMessage = {
      sessionId,
      messageSeq: input.messageSeq,
      role: input.role,
      content: input.content,
      idempotencyKey: key,
      createdAt: new Date().toISOString(),
    };
    cell.messages.push(message);
    cell.byKey.set(key, message);
    cell.record = { ...cell.record, lastActiveAt: message.createdAt };
    return { ...message };
  }

  async readMessages(sessionId: string, fromSeq = 0, toSeq?: number): Promise<SessionMessage[]> {
    const cell = this.cell(sessionId);
    const end = toSeq ?? cell.messages.length;
    return cell.messages.slice(Math.max(0, fromSeq), Math.max(0, end)).map((m) => ({ ...m }));
  }

  async messageCount(sessionId: string): Promise<number> {
    return this.cell(sessionId).messages.length;
  }

  async appendEvent(sessionId: string, event: SessionEvent): Promise<void> {
    const id = assertSessionId(sessionId);
    const cell = this.cell(id);
    // 断言形状：scope === 'session'（RunEvent 在此被拒）。
    const parsed = SessionEventSchema.parse(event);
    if (parsed.sessionId !== id) {
      throw conflict(`event.sessionId ${parsed.sessionId} != target session ${id}`);
    }
    const expected = cell.events.length;
    if (parsed.eventIndex !== expected) {
      throw conflict(
        `eventIndex must be strictly monotonic: expected ${expected}, got ${parsed.eventIndex}`,
      );
    }
    cell.events.push(parsed);
  }

  async readEvents(sessionId: string, fromIndex = 0, toIndex?: number): Promise<SessionEvent[]> {
    const cell = this.cell(sessionId);
    const end = toIndex ?? cell.events.length;
    return cell.events.slice(Math.max(0, fromIndex), Math.max(0, end));
  }

  async eventCount(sessionId: string): Promise<number> {
    return this.cell(sessionId).events.length;
  }
}
