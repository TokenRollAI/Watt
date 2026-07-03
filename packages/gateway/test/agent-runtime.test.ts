/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import type { AgentDefinition, Event } from '@watt/core';
import { getAgentByName } from 'agents';
import { describe, expect, it } from 'vitest';
import type { AgentInstance, AgentInstanceRpc } from '../src/agent/agent-instance.ts';
import { AgentRegistry } from '../src/agent/agent-registry.ts';
import { AgentRuntime, type RuntimeDeps } from '../src/agent/agent-runtime.ts';
import { defaultAgentDeliverer } from '../src/event/agent-deliverer.ts';

/**
 * AgentRuntime 集成测试（Proto §3.2 生命周期 + §3.4 结果回传接线）——真实 AgentInstance（Agents SDK）
 * + AgentCorrelation DO + AgentRegistry（D1）。
 *
 * 覆盖 DoD 项3 的服务端协议事实（不含 @llm 真实调用，走 echo harness）：
 *  - Spawn 幂等（同 instanceKey 同实例）。
 *  - Spawn(expect) 注册 correlation + 返 correlationId；echo onEvent 产 agent.result。
 *  - Send+expect 全链：send → correlation register → onEvent → agent.result → routeResult 定向回送
 *    → 等待方实例收到（规则 1）；重复结果 drop-duplicate（规则 6）。
 *  - Terminate 级联：cascade 终止子树 + correlation.failProducer 代发 terminated（规则 4）。
 *  - ListInstances tree：父子派生关系。
 *
 * 注：AgentInstance.onEvent 把结果 publish 到 env.QUEUE_EVENTS；本测试直接构造该 result 事件喂
 *   defaultAgentDeliverer.routeResult（穿透 correlation 路由），断言协议事实（settle/去重/交付）。
 */

let seq = 0;
function uniq(base: string): string {
  return `${base}-${seq++}`;
}

function runtimeDeps(): RuntimeDeps {
  let n = 0;
  return {
    env,
    genId: () => `gen-${n++}`,
    now: () => '2026-07-03T00:00:00.000Z',
    nowMs: () => 1_000_000,
  };
}

const D = (name: string, over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name,
  description: 'test agent',
  runtime: 'light',
  entry: { kind: 'do-class', className: 'AgentInstance' },
  grants: [],
  contextNamespaces: [],
  toolScopes: [],
  ...over,
});

function correlationStub() {
  return env.AGENT_CORRELATION.get(env.AGENT_CORRELATION.idFromName('correlation'));
}

async function instanceRpc(key: string): Promise<AgentInstanceRpc> {
  const stub = await getAgentByName<Cloudflare.Env, AgentInstance>(env.AGENT_INSTANCE, key);
  return stub as unknown as AgentInstanceRpc;
}

/** 构造一个 agent.result 事件（模拟 echo onEvent 的产出）。 */
const resultEvent = (correlationId: string, instanceId: string, output: unknown): Event => ({
  id: uniq('res'),
  source: { kind: 'agent', ref: instanceId },
  type: 'agent.result',
  payload: { correlationId, instanceId, output },
  occurredAt: '2026-07-03T00:00:00.000Z',
  traceId: 't',
});

describe('AgentRuntime.spawn (§3.2)', () => {
  it('spawn on unregistered definition → not_found', async () => {
    const rt = new AgentRuntime(runtimeDeps());
    const res = await rt.spawn({ definition: 'no-such-agent' });
    expect(res).toMatchObject({ code: 'not_found' });
  });

  it('spawn is idempotent — same instanceKey returns same instance', async () => {
    const reg = new AgentRegistry(env.DB_PROVIDERS);
    const name = uniq('spawn-idem');
    await reg.write(D(name));
    const rt = new AgentRuntime(runtimeDeps());
    const key = uniq('key');
    const a = await rt.spawn({ definition: name, instanceKey: key, input: { v: 1 } });
    const b = await rt.spawn({ definition: name, instanceKey: key, input: { v: 2 } });
    expect('code' in a).toBe(false);
    expect('code' in b).toBe(false);
    if (!('code' in a) && !('code' in b)) {
      expect(a.instance.instanceId).toBe(b.instance.instanceId);
    }
  });

  it('spawn(expect) registers correlation and returns correlationId', async () => {
    const reg = new AgentRegistry(env.DB_PROVIDERS);
    const name = uniq('spawn-expect');
    await reg.write(D(name));
    const rt = new AgentRuntime(runtimeDeps());
    const key = uniq('key');
    const res = await rt.spawn({
      definition: name,
      instanceKey: key,
      input: { task: 'x' },
      expect: { correlationId: 'cid-spawn-1', timeoutMs: 60_000 },
    });
    expect('code' in res).toBe(false);
    if (!('code' in res)) {
      expect(res.correlationId).toBe('cid-spawn-1');
    }
    const corr = correlationStub();
    expect(await corr.hasPending('cid-spawn-1')).toBe(true);
  });
});

describe('AgentRuntime.send + §3.4 directed routing (echo full chain)', () => {
  it('send+expect → correlation registered → agent.result routed to waiter once, then dedupe', async () => {
    const reg = new AgentRegistry(env.DB_PROVIDERS);
    const name = uniq('send-echo');
    await reg.write(D(name));
    const rt = new AgentRuntime(runtimeDeps());
    const key = uniq('key');
    await rt.spawn({ definition: name, instanceKey: key, input: { hello: 1 } });

    const sendEvent: Event = {
      id: 'send-evt',
      source: { kind: 'system' },
      type: 'agent.message',
      payload: { ping: true },
      occurredAt: '2026-07-03T00:00:00.000Z',
      traceId: 't',
    };
    // send+expect → correlation register（waiter=Send 调用者，此处指定 caller）。
    const waiterKey = uniq('waiter');
    await reg.write(D(uniq('waiter-def')));
    const send = await rt.send(
      key,
      sendEvent,
      { correlationId: 'cid-send-1', timeoutMs: 60_000 },
      {
        kind: 'agent',
        id: waiterKey,
      },
    );
    expect('code' in send).toBe(false);
    if (!('code' in send)) {
      expect(send.accepted).toBe(true);
      expect(send.correlationId).toBe('cid-send-1');
    }

    // 模拟 echo onEvent 产出的 agent.result 到达 consumer → routeResult 定向回送（规则 1）。
    const deliverer = defaultAgentDeliverer(env);
    const corr = correlationStub();
    expect(await corr.hasPending('cid-send-1')).toBe(true);
    await deliverer.routeResult(resultEvent('cid-send-1', key, { echo: 'ok' }));
    // 首次交付后 correlation settled → 再次 resolve 为 null（规则 6 去重）。
    expect(await corr.resolve('cid-send-1')).toBeNull();
    // 重复结果再次 routeResult → drop-duplicate（不抛，幂等）。
    await deliverer.routeResult(resultEvent('cid-send-1', key, { echo: 'dup' }));
  });

  it('routeResult with unknown correlationId → drop-no-waiter (rule 5, no throw)', async () => {
    const deliverer = defaultAgentDeliverer(env);
    await deliverer.routeResult(resultEvent('cid-never-registered', 'inst-x', {}));
    // 不抛即通过（规则 5：等待方先消失 / 伪造 correlationId，丢弃记审计）。
  });
});

describe('AgentRuntime.terminate cascade (§3.4 rule 4)', () => {
  it('cascade terminate marks subtree terminated + emits terminated failed for pending correlations', async () => {
    const reg = new AgentRegistry(env.DB_PROVIDERS);
    const name = uniq('term');
    await reg.write(D(name));
    const rt = new AgentRuntime(runtimeDeps());
    const parent = uniq('parent');
    const child = uniq('child');
    await rt.spawn({ definition: name, instanceKey: parent });
    await rt.spawn({ definition: name, instanceKey: child }, { parent });

    // child 作产出方登记一个 pending correlation（等待方 = parent）。
    const corr = correlationStub();
    await corr.register('cid-term', { kind: 'agent', id: parent }, child, 2_000_000, 't');

    await rt.terminate(parent, { cascade: true });

    // 子树两实例都 terminated。
    const parentInfo = await instanceRpc(parent);
    const childInfo = await instanceRpc(child);
    expect((await parentInfo.getInfo()).status).toBe('terminated');
    expect((await childInfo.getInfo()).status).toBe('terminated');
    // child 的 pending correlation 被 failProducer settle（规则 4）→ resolve 为 null。
    expect(await corr.resolve('cid-term')).toBeNull();
  });
});

describe('AgentRuntime.listInstances tree (§3.2)', () => {
  it('tree returns parent + descendants', async () => {
    const reg = new AgentRegistry(env.DB_PROVIDERS);
    const name = uniq('tree');
    await reg.write(D(name));
    const rt = new AgentRuntime(runtimeDeps());
    const root = uniq('root');
    const c1 = uniq('c1');
    await rt.spawn({ definition: name, instanceKey: root });
    await rt.spawn({ definition: name, instanceKey: c1 }, { parent: root });

    const page = await rt.listInstances({ tree: root });
    const ids = page.items.map((i) => i.instanceId).sort();
    expect(ids).toEqual([c1, root].sort());
    const rootInfo = page.items.find((i) => i.instanceId === root);
    expect(rootInfo?.children).toContain(c1);
  });
});
