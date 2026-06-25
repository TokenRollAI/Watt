import { describe, expect, it } from 'vitest';
import {
  newAgentId,
  newAgentVersionId,
  newSessionId,
  newRunId,
  newTaskId,
  newWorkspaceId,
  idempotencyKeyForSessionMessage,
  type SessionEvent,
} from '@watt/protocol';
import { InMemorySessionStore, type SessionMessage } from '../src/index.js';

const at = () => new Date().toISOString();

function makeSessionStore() {
  const store = new InMemorySessionStore();
  const agentId = newAgentId();
  const agentVersionId = newAgentVersionId(agentId, 1);
  const sessionId = newSessionId(agentId);
  const workspaceId = newWorkspaceId();
  return { store, agentId, agentVersionId, sessionId, workspaceId };
}

async function withSession() {
  const ctx = makeSessionStore();
  await ctx.store.createSession({
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    agentVersionId: ctx.agentVersionId,
  });
  return ctx;
}

describe('SessionStore Session 记录', () => {
  it('创建 / 取 / 列表 / 状态', async () => {
    const ctx = await withSession();
    const got = await ctx.store.getSession(ctx.sessionId);
    expect(got.status).toBe('active');
    expect(got.agentId).toBe(ctx.agentId);

    const list = await ctx.store.listSessions(ctx.agentId);
    expect(list).toHaveLength(1);

    const archived = await ctx.store.updateSessionStatus(ctx.sessionId, 'archived');
    expect(archived.status).toBe('archived');
  });

  it('坏 sessionId 抛错；run id 无法通过 session 校验', async () => {
    const { store, agentId, agentVersionId } = makeSessionStore();
    const runId = newRunId(newTaskId());
    // run id 语法不通过 SessionId 校验（结构防线第一道）。
    await expect(
      store.createSession({ sessionId: runId, agentId, agentVersionId }),
    ).rejects.toThrow();
  });
});

describe('SessionStore 消息单调 + 幂等', () => {
  it('消息序号严格单调', async () => {
    const ctx = await withSession();
    await ctx.store.appendMessage({
      sessionId: ctx.sessionId,
      messageSeq: 0,
      role: 'user',
      content: 'hi',
    });
    await ctx.store.appendMessage({
      sessionId: ctx.sessionId,
      messageSeq: 1,
      role: 'assistant',
      content: 'hello',
    });
    expect(await ctx.store.messageCount(ctx.sessionId)).toBe(2);
    // 跳号被拒。
    await expect(
      ctx.store.appendMessage({
        sessionId: ctx.sessionId,
        messageSeq: 3,
        role: 'user',
        content: 'x',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('幂等 key 重复写不重复追加', async () => {
    const ctx = await withSession();
    const first = await ctx.store.appendMessage({
      sessionId: ctx.sessionId,
      messageSeq: 0,
      role: 'user',
      content: 'hi',
    });
    // 同 messageSeq 重发：返回已有那条，count 不增。
    const dup = await ctx.store.appendMessage({
      sessionId: ctx.sessionId,
      messageSeq: 0,
      role: 'user',
      content: 'hi (resend)',
    });
    expect(dup.idempotencyKey).toBe(first.idempotencyKey);
    expect(dup.content).toBe('hi'); // 保留首次内容，不被重发覆盖
    expect(await ctx.store.messageCount(ctx.sessionId)).toBe(1);
    expect(first.idempotencyKey).toBe(
      idempotencyKeyForSessionMessage(ctx.sessionId, 0),
    );
  });

  it('读消息区间半开 [from, to)', async () => {
    const ctx = await withSession();
    for (let i = 0; i < 4; i++) {
      await ctx.store.appendMessage({
        sessionId: ctx.sessionId,
        messageSeq: i,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `m${i}`,
      });
    }
    const slice = await ctx.store.readMessages(ctx.sessionId, 1, 3);
    expect(slice.map((m: SessionMessage) => m.content)).toEqual(['m1', 'm2']);
  });
});

describe('SessionStore 与 Run 互斥（第三道防线）', () => {
  it('RunEvent 投进 SessionStore 被拒（scope 不符）', async () => {
    const ctx = await withSession();
    const runEvent = {
      scope: 'run',
      workspaceId: ctx.workspaceId,
      runId: newRunId(newTaskId()),
      eventIndex: 0,
      at: at(),
      type: 'test',
      payload: {},
    } as unknown as SessionEvent;
    await expect(ctx.store.appendEvent(ctx.sessionId, runEvent)).rejects.toThrow();
  });

  it('SessionEvent 正常 append，单调约束生效', async () => {
    const ctx = await withSession();
    const ev = (eventIndex: number): SessionEvent => ({
      scope: 'session',
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      eventIndex,
      at: at(),
      type: 'test',
      payload: {},
    });
    await ctx.store.appendEvent(ctx.sessionId, ev(0));
    await ctx.store.appendEvent(ctx.sessionId, ev(1));
    expect(await ctx.store.eventCount(ctx.sessionId)).toBe(2);
    await expect(ctx.store.appendEvent(ctx.sessionId, ev(0))).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('event.sessionId 与目标不一致被拒', async () => {
    const ctx = await withSession();
    const otherSession = newSessionId(newAgentId());
    const ev: SessionEvent = {
      scope: 'session',
      workspaceId: ctx.workspaceId,
      sessionId: otherSession,
      eventIndex: 0,
      at: at(),
      type: 'test',
      payload: {},
    };
    await expect(ctx.store.appendEvent(ctx.sessionId, ev)).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});

/**
 * 类型层互斥的编译期证据：AppendMessageInput / SessionMessage / CreateSessionInput
 * 的签名里不存在 runId 字段。下方断言确保接口形状不含任何 run 成分。
 * 若未来有人给 SessionStore 加 runId，这些 @ts-expect-error 会失效从而被发现。
 */
describe('SessionStore 类型层无 RunId', () => {
  it('消息/会话输入不接受 runId 字段', async () => {
    const ctx = await withSession();
    const bad: Parameters<typeof ctx.store.appendMessage>[0] = {
      sessionId: ctx.sessionId,
      messageSeq: 0,
      role: 'user',
      content: 'x',
      // @ts-expect-error SessionStore 接口绝不接受 runId
      runId: newRunId(newTaskId()),
    };
    expect(bad.sessionId).toBe(ctx.sessionId);
  });
});
