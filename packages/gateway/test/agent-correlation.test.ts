/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AgentCorrelation } from '../src/agent/agent-correlation.ts';

/**
 * AgentCorrelation DO 单测（Proto §3.4 correlation 等待表 + §3.2 实例索引）。
 * oracle 硬编码自 §3.4（register/resolve/hasPending/expire/failWaiter 状态机）、§3.2（实例索引/子树）。
 *
 * 每个用例用唯一 idFromName 取独立 DO 实例（DO storage 跨用例持久，避免串扰）。
 * expire/failWaiter 的代发（QUEUE_EVENTS.send）走真实队列 producer；此处断言状态机返回值
 * （settled 的 correlationId 列表）——代发事件的消费侧穿透在 runtime 集成测试验证。
 */

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
});
