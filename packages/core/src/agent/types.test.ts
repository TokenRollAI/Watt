import { describe, expect, it } from 'vitest';
import {
  agentDefinitionSchema,
  agentFailedPayloadSchema,
  agentResultPayloadSchema,
  expectSpecSchema,
  spawnRequestSchema,
} from './types.ts';

/**
 * Agent Runtime 类型层 zod 校验（Proto §3.1 / §3.2 / §3.4）。
 * oracle：断言 parse 成功/失败与关键字段的可选性、判别式 union 的分支。
 */

// ═══ AgentDefinition（§3.1）══════════════════════════════════════════════

describe('agentDefinitionSchema (§3.1)', () => {
  const base = {
    name: 'triage',
    description: '分诊',
    runtime: 'light' as const,
    entry: { kind: 'do-class' as const, className: 'TriageAgent' },
    grants: [{ resources: ['tool://logs/*'], actions: ['invoke'] }],
    contextNamespaces: ['feedback/bugs'],
    toolScopes: ['observability/'],
  };

  it('接受最小合法 light do-class 定义（model/subscriptions 可选）', () => {
    const r = agentDefinitionSchema.safeParse(base);
    expect(r.success).toBe(true);
  });

  it('接受 heavy container entry（含 bindings/workspace）', () => {
    const r = agentDefinitionSchema.safeParse({
      ...base,
      runtime: 'heavy',
      entry: {
        kind: 'container',
        image: 'coding:latest',
        cmd: ['run'],
        bindings: [{ name: 'GIT_TOKEN', secretRef: 'secret://git' }],
        workspace: { repo: 'org/repo', ref: 'main' },
      },
    });
    expect(r.success).toBe(true);
  });

  it('接受 external endpoint entry 三协议', () => {
    for (const protocol of ['htbp', 'mcp', 'http'] as const) {
      const r = agentDefinitionSchema.safeParse({
        ...base,
        runtime: 'external',
        entry: { kind: 'endpoint', url: 'https://x', protocol },
      });
      expect(r.success).toBe(true);
    }
  });

  it('接受声明式 subscriptions（match + instanceBy）', () => {
    const r = agentDefinitionSchema.safeParse({
      ...base,
      subscriptions: [{ match: { type: 'im.*', channel: 'feishu' }, instanceBy: 'session' }],
    });
    expect(r.success).toBe(true);
  });

  it('拒绝未知 runtime', () => {
    const r = agentDefinitionSchema.safeParse({ ...base, runtime: 'quantum' });
    expect(r.success).toBe(false);
  });

  it('拒绝未知 entry.kind', () => {
    const r = agentDefinitionSchema.safeParse({ ...base, entry: { kind: 'wasm', mod: 'x' } });
    expect(r.success).toBe(false);
  });

  it('拒绝缺 description', () => {
    const { description: _drop, ...noDesc } = base;
    const r = agentDefinitionSchema.safeParse(noDesc);
    expect(r.success).toBe(false);
  });
});

// ═══ ExpectSpec / SpawnRequest（§3.2）════════════════════════════════════

describe('expectSpecSchema (§3.2)', () => {
  it('全字段可选：空对象合法', () => {
    expect(expectSpecSchema.safeParse({}).success).toBe(true);
  });
  it('接受 correlationId/timeoutMs/schema', () => {
    const r = expectSpecSchema.safeParse({
      correlationId: 'c-1',
      timeoutMs: 30000,
      schema: { type: 'object', properties: { score: { type: 'number' } } },
    });
    expect(r.success).toBe(true);
  });
  it('拒绝 timeoutMs 非数字', () => {
    expect(expectSpecSchema.safeParse({ timeoutMs: '30s' }).success).toBe(false);
  });
});

describe('spawnRequestSchema (§3.2)', () => {
  it('最小合法：只有 definition', () => {
    expect(spawnRequestSchema.safeParse({ definition: 'triage' }).success).toBe(true);
  });
  it('接受 instanceKey/input/ttl/expect', () => {
    const r = spawnRequestSchema.safeParse({
      definition: 'triage',
      instanceKey: 'agent:triage#session:s1',
      input: { text: 'hi' },
      ttl: 600,
      expect: { timeoutMs: 5000 },
    });
    expect(r.success).toBe(true);
  });
  it('拒绝缺 definition', () => {
    expect(spawnRequestSchema.safeParse({ input: {} }).success).toBe(false);
  });
});

// ═══ AgentResultPayload / AgentFailedPayload（§3.4）══════════════════════

describe('agentResultPayloadSchema (§3.4)', () => {
  it('接受 correlationId/instanceId/output + 可选 artifacts', () => {
    const r = agentResultPayloadSchema.safeParse({
      correlationId: 'c-1',
      instanceId: 'inst-1',
      output: { ok: true },
      artifacts: ['context://research/scratch/r1'],
    });
    expect(r.success).toBe(true);
  });
  it('output 可为任意 unknown（含 null）', () => {
    const r = agentResultPayloadSchema.safeParse({
      correlationId: 'c-1',
      instanceId: 'inst-1',
      output: null,
    });
    expect(r.success).toBe(true);
  });
  it('拒绝缺 correlationId', () => {
    const r = agentResultPayloadSchema.safeParse({ instanceId: 'inst-1', output: {} });
    expect(r.success).toBe(false);
  });
});

describe('agentFailedPayloadSchema (§3.4)', () => {
  it('接受五种 reason', () => {
    for (const reason of ['error', 'timeout', 'terminated', 'rejected', 'invalid_output']) {
      const r = agentFailedPayloadSchema.safeParse({
        correlationId: 'c-1',
        instanceId: 'inst-1',
        reason,
      });
      expect(r.success).toBe(true);
    }
  });
  it('接受携带 WattError 形状的 error', () => {
    const r = agentFailedPayloadSchema.safeParse({
      correlationId: 'c-1',
      instanceId: 'inst-1',
      reason: 'invalid_output',
      error: { code: 'invalid_argument', message: 'bad shape', retryable: false },
    });
    expect(r.success).toBe(true);
  });
  it('拒绝未知 reason', () => {
    const r = agentFailedPayloadSchema.safeParse({
      correlationId: 'c-1',
      instanceId: 'inst-1',
      reason: 'boom',
    });
    expect(r.success).toBe(false);
  });
  it('拒绝 error.code 非 7 码之一', () => {
    const r = agentFailedPayloadSchema.safeParse({
      correlationId: 'c-1',
      instanceId: 'inst-1',
      reason: 'error',
      error: { code: 'teapot', message: 'x', retryable: false },
    });
    expect(r.success).toBe(false);
  });
});
