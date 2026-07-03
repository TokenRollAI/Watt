/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { describe, expect, it } from 'vitest';
import type { AgentCorrelation } from '../src/agent/agent-correlation.ts';
import type { AgentInstance, AgentInstanceRpc } from '../src/agent/agent-instance.ts';
import { EventStore } from '../src/event/event-store.ts';

/**
 * AgentCorrelation DO 单测（Proto §3.4 correlation 等待表 + §3.2 实例索引）。
 * oracle 硬编码自 §3.4（register/resolve/hasPending/expire/failWaiter 状态机）、§3.2（实例索引/子树）。
 *
 * 每个用例用唯一 idFromName 取独立 DO 实例（DO storage 跨用例持久，避免串扰）。
 * expire/failProducer 现直投等待方实例 onEvent（BLOCKER 修正，绕开 QUEUE→routeResult 自吞）+
 *   EventStore.put 留痕——用真实 idFromName('correlation') 单例断言端到端交付（waiter 收到 + 留痕）。
 */

async function instanceRpc(key: string): Promise<AgentInstanceRpc> {
  const stub = await getAgentByName<Cloudflare.Env, AgentInstance>(env.AGENT_INSTANCE, key);
  return stub as unknown as AgentInstanceRpc;
}

let counter = 0;
function freshCorrelation() {
  const id = env.AGENT_CORRELATION.idFromName(`corr-test-${counter++}`);
  return env.AGENT_CORRELATION.get(id);
}

const WAITER = { kind: 'agent' as const, id: 'parent-1' };

describe('AgentCorrelation state machine (§3.4)', () => {
  it('register → resolve returns waiter once, then null (rule 6 dedupe)', async () => {
    const stub = freshCorrelation();
    await runInDurableObject(stub, (c: AgentCorrelation) =>
      c.register('cid-1', WAITER, 'child-1', Date.now() + 60_000, 'trace-1'),
    );
    const first = await runInDurableObject(stub, (c: AgentCorrelation) => c.resolve('cid-1'));
    expect(first).toEqual(WAITER);
    const second = await runInDurableObject(stub, (c: AgentCorrelation) => c.resolve('cid-1'));
    expect(second).toBeNull();
  });

  it('peekForDelivery + confirmDelivery: settle only after successful delivery (rule 6 idempotent)', async () => {
    const stub = freshCorrelation();
    await runInDurableObject(stub, (c: AgentCorrelation) =>
      c.register('cid-peek', WAITER, 'child-1', Date.now() + 60_000, 'trace-1'),
    );
    // peek 置 delivering 并得 waiter；此时第二个 peek 返 null（并发去重）。
    const first = await runInDurableObject(stub, (c: AgentCorrelation) =>
      c.peekForDelivery('cid-peek'),
    );
    expect(first).toEqual(WAITER);
    const concurrent = await runInDurableObject(stub, (c: AgentCorrelation) =>
      c.peekForDelivery('cid-peek'),
    );
    expect(concurrent).toBeNull();
    // confirm → 终态 settled；其后 resolve/peek 均 null。
    await runInDurableObject(stub, (c: AgentCorrelation) => c.confirmDelivery('cid-peek'));
    expect(
      await runInDurableObject(stub, (c: AgentCorrelation) => c.resolve('cid-peek')),
    ).toBeNull();
  });

  it('peekForDelivery + rollbackDelivery: failed delivery returns correlation to pending (re-peekable)', async () => {
    const stub = freshCorrelation();
    await runInDurableObject(stub, (c: AgentCorrelation) =>
      c.register('cid-roll', WAITER, 'child-1', Date.now() + 60_000, 'trace-1'),
    );
    const first = await runInDurableObject(stub, (c: AgentCorrelation) =>
      c.peekForDelivery('cid-roll'),
    );
    expect(first).toEqual(WAITER);
    // 投递失败 → rollback 回 pending → 再次 peek 仍能命中（消息 retry 重放不丢结果）。
    await runInDurableObject(stub, (c: AgentCorrelation) => c.rollbackDelivery('cid-roll'));
    const retry = await runInDurableObject(stub, (c: AgentCorrelation) =>
      c.peekForDelivery('cid-roll'),
    );
    expect(retry).toEqual(WAITER);
  });

  it('hasPending distinguishes registered vs never-seen (rule 5)', async () => {
    const stub = freshCorrelation();
    await runInDurableObject(stub, (c: AgentCorrelation) =>
      c.register('cid-2', WAITER, 'child-1', Date.now() + 60_000, 'trace-1'),
    );
    expect(await runInDurableObject(stub, (c: AgentCorrelation) => c.hasPending('cid-2'))).toBe(
      true,
    );
    expect(await runInDurableObject(stub, (c: AgentCorrelation) => c.hasPending('never'))).toBe(
      false,
    );
  });

  it('expireNow settles overdue correlations (rule 3 timeout dispatch)', async () => {
    const stub = freshCorrelation();
    const past = Date.now() - 1000;
    await runInDurableObject(stub, (c: AgentCorrelation) =>
      c.register('cid-exp', WAITER, 'child-1', past, 'trace-1'),
    );
    const expired = await runInDurableObject(stub, (c: AgentCorrelation) =>
      c.expireNow(
        Date.now(),
        () => 'gen',
        () => '2026-07-03T00:00:00.000Z',
      ),
    );
    expect(expired).toEqual(['cid-exp']);
    // 超时后 resolve → null（幂等：真实结果晚到 drop-duplicate，§3.4 规则 3）。
    const late = await runInDurableObject(stub, (c: AgentCorrelation) => c.resolve('cid-exp'));
    expect(late).toBeNull();
  });

  it('expireNow does not settle not-yet-overdue correlations', async () => {
    const stub = freshCorrelation();
    await runInDurableObject(stub, (c: AgentCorrelation) =>
      c.register('cid-future', WAITER, 'child-1', Date.now() + 60_000, 'trace-1'),
    );
    const expired = await runInDurableObject(stub, (c: AgentCorrelation) =>
      c.expireNow(
        Date.now(),
        () => 'gen',
        () => 'now',
      ),
    );
    expect(expired).toEqual([]);
  });

  it('failProducer settles all pending correlations of a terminated producer (rule 4 terminated)', async () => {
    const stub = freshCorrelation();
    await runInDurableObject(stub, async (c: AgentCorrelation) => {
      await c.register('cid-a', WAITER, 'producer-X', Date.now() + 60_000, 't');
      await c.register('cid-b', WAITER, 'producer-X', Date.now() + 60_000, 't');
      await c.register('cid-c', WAITER, 'producer-Y', Date.now() + 60_000, 't');
    });
    const failed = await runInDurableObject(stub, (c: AgentCorrelation) =>
      c.failProducer(
        'producer-X',
        () => 'gen',
        () => 'now',
      ),
    );
    expect(failed.sort()).toEqual(['cid-a', 'cid-b']);
    // producer-Y 的 correlation 未受影响。
    expect(await runInDurableObject(stub, (c: AgentCorrelation) => c.resolve('cid-c'))).toEqual(
      WAITER,
    );
  });
});

describe('AgentCorrelation instance index (§3.2 ListInstances / tree)', () => {
  it('registerInstance + getInstance', async () => {
    const stub = freshCorrelation();
    await runInDurableObject(stub, (c: AgentCorrelation) =>
      c.registerInstance({ instanceId: 'i-1', definition: 'triage', createdAt: '2026-07-03' }),
    );
    const row = await runInDurableObject(stub, (c: AgentCorrelation) => c.getInstance('i-1'));
    expect(row).toMatchObject({ instance_id: 'i-1', definition: 'triage', state: 'idle' });
  });

  it('subtree returns root + descendants (BFS over parent_id)', async () => {
    const stub = freshCorrelation();
    await runInDurableObject(stub, async (c: AgentCorrelation) => {
      c.registerInstance({ instanceId: 'root', definition: 'master', createdAt: '1' });
      c.registerInstance({ instanceId: 'c1', definition: 'sub', parentId: 'root', createdAt: '2' });
      c.registerInstance({ instanceId: 'c2', definition: 'sub', parentId: 'root', createdAt: '3' });
      c.registerInstance({ instanceId: 'g1', definition: 'sub', parentId: 'c1', createdAt: '4' });
      c.registerInstance({ instanceId: 'other', definition: 'x', createdAt: '5' });
    });
    const tree = await runInDurableObject(stub, (c: AgentCorrelation) => c.subtree('root'));
    const ids = tree.map((r) => r.instance_id).sort();
    expect(ids).toEqual(['c1', 'c2', 'g1', 'root']);
  });

  it('childrenOf returns direct children only', async () => {
    const stub = freshCorrelation();
    await runInDurableObject(stub, async (c: AgentCorrelation) => {
      c.registerInstance({ instanceId: 'p', definition: 'm', createdAt: '1' });
      c.registerInstance({ instanceId: 'ch', definition: 's', parentId: 'p', createdAt: '2' });
    });
    const kids = await runInDurableObject(stub, (c: AgentCorrelation) => c.childrenOf('p'));
    expect(kids).toEqual(['ch']);
  });

  it('setInstanceState updates state (terminate index sync)', async () => {
    const stub = freshCorrelation();
    await runInDurableObject(stub, (c: AgentCorrelation) =>
      c.registerInstance({ instanceId: 'i-t', definition: 'd', createdAt: '1' }),
    );
    await runInDurableObject(stub, (c: AgentCorrelation) =>
      c.setInstanceState('i-t', 'terminated'),
    );
    const row = await runInDurableObject(stub, (c: AgentCorrelation) => c.getInstance('i-t'));
    expect(row?.state).toBe('terminated');
  });

  it('subtree returns the full cascade beyond the 200-row list cap (no truncation)', async () => {
    // 回归 BLOCKER 邻近的 MAJOR：subtree 曾走 listInstances(200) 全量拉 → 深/宽子树被截断。
    // 构造 250 个直接子 + 一条 5 层深链，断言全部覆盖（>200，逐层查不漏）。
    const stub = freshCorrelation();
    await runInDurableObject(stub, async (c: AgentCorrelation) => {
      c.registerInstance({ instanceId: 'big-root', definition: 'm', createdAt: '0' });
      for (let i = 0; i < 250; i++) {
        c.registerInstance({
          instanceId: `wide-${i}`,
          definition: 's',
          parentId: 'big-root',
          createdAt: `w${i}`,
        });
      }
      // 深链：big-root → deep-0 → deep-1 → ... → deep-4（deep-0 挂 big-root 下）。
      let parent = 'big-root';
      for (let d = 0; d < 5; d++) {
        c.registerInstance({
          instanceId: `deep-${d}`,
          definition: 's',
          parentId: parent,
          createdAt: `d${d}`,
        });
        parent = `deep-${d}`;
      }
    });
    const tree = await runInDurableObject(stub, (c: AgentCorrelation) => c.subtree('big-root'));
    const ids = new Set(tree.map((r) => r.instance_id));
    // root + 250 宽 + 5 深 = 256 个节点，全覆盖（未被 200 截断）。
    expect(tree).toHaveLength(256);
    expect(ids.has('wide-249')).toBe(true);
    expect(ids.has('deep-4')).toBe(true);
  });
});

/**
 * BLOCKER 端到端（§3.4 规则 3/4）：代发的 agent.failed 必须真正送达等待方实例 + 留痕，
 * 不能被自身 settle + QUEUE→routeResult 自吞。用真实 idFromName('correlation') 单例（生产同源）：
 * emitFailed 直投 waiter.onEvent（AGENT_INSTANCE stub）+ EventStore.put。
 */
function realCorrelation() {
  return env.AGENT_CORRELATION.get(env.AGENT_CORRELATION.idFromName('correlation'));
}

let waiterSeq = 0;

describe('AgentCorrelation platform-issued failed delivery (§3.4 BLOCKER 端到端)', () => {
  it('expireNow: waiter instance actually receives timeout failed + EventStore leaves a trace', async () => {
    const corr = realCorrelation();
    const waiterKey = `wait-timeout-${waiterSeq++}`;
    // 先 init 等待方实例（idle），记录初始 lastActiveAt。
    const waiter = await instanceRpc(waiterKey);
    const initState = await waiter.initInstance({
      definition: 'parent',
      harness: 'echo',
      nowIso: '2020-01-01T00:00:00.000Z',
    });
    expect(initState.lastActiveAt).toBe('2020-01-01T00:00:00.000Z');

    const cid = `cid-timeout-${waiterSeq}`;
    await corr.register(
      cid,
      { kind: 'agent', id: waiterKey },
      'producer-x',
      Date.now() - 1000,
      'tr',
    );
    const settled = await corr.expireNow(Date.now());
    expect(settled).toContain(cid);

    // 等待方实例的 onEvent 被触达（收到 failed）→ lastActiveAt 已从初始值推进。
    const after = await waiter.getInfo();
    expect(after.lastActiveAt).not.toBe('2020-01-01T00:00:00.000Z');

    // EventStore 留痕：一条 agent.failed（reason=timeout, correlationId 匹配）。
    const store = new EventStore(env.DB_EVENTS);
    const page = await store.list({ filter: { type: 'agent.failed' } });
    if ('code' in page) throw new Error(page.message);
    const trace = page.items.find(
      (e) => (e.payload as { correlationId?: string }).correlationId === cid,
    );
    expect(trace).toBeDefined();
    expect((trace?.payload as { reason?: string }).reason).toBe('timeout');

    // 幂等：真实结果晚到 → resolve 返 null（已 settled，规则 3）。
    expect(await corr.resolve(cid)).toBeNull();
  });

  it('failProducer: waiter receives terminated failed + trace, and settles (rule 4)', async () => {
    const corr = realCorrelation();
    const waiterKey = `wait-term-${waiterSeq++}`;
    const waiter = await instanceRpc(waiterKey);
    await waiter.initInstance({
      definition: 'parent',
      harness: 'echo',
      nowIso: '2020-01-01T00:00:00.000Z',
    });

    const cid = `cid-term-e2e-${waiterSeq}`;
    const producer = `producer-term-${waiterSeq}`;
    await corr.register(cid, { kind: 'agent', id: waiterKey }, producer, Date.now() + 60_000, 'tr');
    const failed = await corr.failProducer(producer);
    expect(failed).toContain(cid);

    const after = await waiter.getInfo();
    expect(after.lastActiveAt).not.toBe('2020-01-01T00:00:00.000Z');

    const store = new EventStore(env.DB_EVENTS);
    const page = await store.list({ filter: { type: 'agent.failed' } });
    if ('code' in page) throw new Error(page.message);
    const trace = page.items.find(
      (e) => (e.payload as { correlationId?: string }).correlationId === cid,
    );
    expect((trace?.payload as { reason?: string }).reason).toBe('terminated');
    expect(await corr.resolve(cid)).toBeNull();
  });

  it('failProducer also settles correlations where the terminated instance is the waiter (MINOR)', async () => {
    // 被终止实例作为 waiter 的未 settled correlation：等待方消失（规则 5）→ 直接 settle，不代发。
    const corr = realCorrelation();
    const terminatedWaiter = `term-as-waiter-${waiterSeq++}`;
    const cid = `cid-waiter-gone-${waiterSeq}`;
    await corr.register(
      cid,
      { kind: 'agent', id: terminatedWaiter },
      'some-producer',
      Date.now() + 60_000,
      'tr',
    );
    // failProducer(terminatedWaiter)：该实例名下作为 producer 无 correlation，但作为 waiter 有 → settle。
    await corr.failProducer(terminatedWaiter);
    expect(await corr.resolve(cid)).toBeNull(); // 已 settled（等待方消失，不代发）。
  });
});
