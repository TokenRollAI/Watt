import { describe, expect, it } from 'vitest';
import type { SubscriptionSink } from '../eventbus/types.ts';
import type { Event } from '../types.ts';
import { resolveInstanceKey } from './index.ts';
import { spawnRequestSchema } from './types.ts';

/**
 * Spawn 幂等键：SpawnRequest 视角的集成用例（Proto §3.2 L367 / §2.3）。
 *
 * 复用 eventbus 的 resolveInstanceKey（不复制实现）。验证两条键来源的关系：
 *   1. SpawnRequest.instanceKey 显式给 → 直接作幂等键（平台按此 idFromName 定位实例）；
 *   2. instanceKey 缺省（订阅驱动的 Spawn）→ 由 sink.instanceBy 经 resolveInstanceKey 推导；
 *      推导键与「显式给同一字符串」等价（同键 → 同实例）。
 *
 * oracle：断言显式键与推导键在语义上可对齐（session 态 definition+session 拼法一致）。
 */

function ev(id: string, session?: string): Event {
  return {
    id,
    source: { kind: 'im', channel: 'feishu' },
    type: 'im.message',
    session,
    payload: {},
    occurredAt: '2026-07-03T00:00:00Z',
    traceId: 'tr-1',
  };
}

function agentSink(instanceBy: 'session' | 'event' | 'singleton'): SubscriptionSink {
  return { kind: 'agent', definition: 'recorder', instanceBy };
}

describe('SpawnRequest.instanceKey 显式 vs 订阅 instanceBy 推导', () => {
  it('显式 instanceKey：SpawnRequest 原样携带（幂等键即调用方给定值）', () => {
    const req = spawnRequestSchema.parse({
      definition: 'recorder',
      instanceKey: 'agent:recorder#session:feishu:chat:oc_x',
    });
    expect(req.instanceKey).toBe('agent:recorder#session:feishu:chat:oc_x');
  });

  it('缺省 instanceKey：从 session 订阅推导出与显式写法一致的键', () => {
    // 订阅路径推导：instanceBy='session' → resolveInstanceKey 产 definition + session。
    const derived = resolveInstanceKey(agentSink('session'), ev('e-1', 'feishu:chat:oc_x'));
    expect('key' in derived).toBe(true);
    if ('key' in derived) {
      // 与「若显式给 instanceKey」应约定的同一字符串对齐（同键 → 同实例）。
      const explicit = spawnRequestSchema.parse({
        definition: 'recorder',
        instanceKey: derived.key,
      });
      expect(explicit.instanceKey).toBe(derived.key);
      expect(derived.key).toContain('recorder');
      expect(derived.key).toContain('feishu:chat:oc_x');
    }
  });

  it('singleton 订阅推导键与事件/session 无关（同 definition 全局唯一实例）', () => {
    const k1 = resolveInstanceKey(agentSink('singleton'), ev('e-1', 's-1'));
    const k2 = resolveInstanceKey(agentSink('singleton'), ev('e-2', 's-2'));
    expect(k1).toEqual(k2);
  });

  it('SpawnRequest 缺省 instanceKey 合法（无键 Spawn = 每次新实例，非幂等）', () => {
    const req = spawnRequestSchema.parse({ definition: 'recorder' });
    expect(req.instanceKey).toBeUndefined();
  });
});
