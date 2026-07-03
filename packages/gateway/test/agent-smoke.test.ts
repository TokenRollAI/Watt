/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { describe, expect, it } from 'vitest';
import type { AgentInstance, AgentInstanceRpc } from '../src/agent/agent-instance.ts';

/**
 * 冒烟测试（R13 首要验证）：确认 Cloudflare Agents SDK 的 `Agent` 基类能在 vitest-pool-workers
 * (0.18 / workerd) 加载 + 实例化 + state 持久化。这是决定 Agent Runtime 落地方案的 gate——
 * 若 agents 包无法在此环境加载/运行，则 fallback 到原生 DO Light Runtime（PROGRESS 留档）。
 *
 * 验证点：
 *  1. import { Agent } from 'agents' 在 workerd 可加载（模块顶层不崩）。
 *  2. getAgentByName(env.AGENT_INSTANCE, name) 恒路由同名实例（§3.2 幂等键宿主）。
 *  3. Agent DO RPC（initInstance/getInfo）可调 + setState 持久化跨调用可见。
 *  4. AgentInstance 与既有原生 DO（EventRouter/ContextRegistry）在同 Worker 内共存（wrangler
 *     migrations v3 new_sqlite_classes 混挂两类 DO）。
 */

/** getAgentByName 的 stub 经 RPC 包装方法收窄成 never（toolchain-pitfalls §31）——cast 到显式 RPC 面。 */
async function instanceStub(name: string): Promise<AgentInstanceRpc> {
  const stub = await getAgentByName<Cloudflare.Env, AgentInstance>(env.AGENT_INSTANCE, name);
  return stub as unknown as AgentInstanceRpc;
}

describe('Agents SDK smoke (R13 gate)', () => {
  it('getAgentByName routes to a named Agent instance and RPC works', async () => {
    const stub = await instanceStub('smoke-1');
    const state = await stub.initInstance({
      definition: 'echo',
      harness: 'echo',
      input: { hello: 'world' },
      nowIso: '2026-07-03T00:00:00.000Z',
    });
    expect(state.definition).toBe('echo');
    expect(state.status).toBe('idle');
    expect(state.harness).toBe('echo');
    expect(state.input).toEqual({ hello: 'world' });
  });

  it('same name returns same instance (state persists across stubs) — idempotent key host (§3.2)', async () => {
    const a = await instanceStub('smoke-persist');
    await a.initInstance({
      definition: 'triage',
      harness: 'echo',
      nowIso: '2026-07-03T00:00:00.000Z',
    });
    // 重新按同名取 stub —— 应命中同一 DO 实例，读到上一步持久化的 state。
    const b = await instanceStub('smoke-persist');
    const info = await b.getInfo();
    expect(info.definition).toBe('triage');
  });

  it('different names are distinct instances', async () => {
    const a = await instanceStub('smoke-a');
    const b = await instanceStub('smoke-b');
    await a.initInstance({
      definition: 'agent-a',
      harness: 'echo',
      nowIso: '2026-07-03T00:00:00.000Z',
    });
    await b.initInstance({
      definition: 'agent-b',
      harness: 'echo',
      nowIso: '2026-07-03T00:00:00.000Z',
    });
    expect((await a.getInfo()).definition).toBe('agent-a');
    expect((await b.getInfo()).definition).toBe('agent-b');
  });
});
