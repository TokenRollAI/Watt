/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { llmHarness } from '../src/agent/harness/llm.ts';
import type { ModelCaller, ModelUsage } from '../src/agent/harness/types.ts';
import { UsageStore, writeUsageDataPoint } from '../src/metrics/usage-store.ts';

/**
 * Metrics 打点单测（R23）——llm harness 的 onUsage 回调 + UsageStore 落库 + AE writeDataPoint spy。
 * AE 本地行为：miniflare 提供 AE_METRICS 绑定，writeDataPoint 为 no-op（不落可查存储）——单测 spy 断言
 * 调用参数（blobs/doubles/indexes 顺序），真实 SQL 查询走远端（@metrics 部署冒烟）。
 */

/** 带 usage 的 fake caller。 */
function callerWithUsage(text: string, usage: ModelUsage): ModelCaller {
  return {
    async call() {
      return { text, usage };
    },
  };
}

describe('llm harness usage callback (§10 打点)', () => {
  it('onUsage fires once per model call with returned usage', async () => {
    const seen: ModelUsage[] = [];
    const outcome = await llmHarness(
      { input: 'hi', model: 'glm-5.2' },
      callerWithUsage('{"ok":true}', { inputTokens: 42, outputTokens: 7 }),
      (u) => seen.push(u),
    );
    expect(outcome.kind).toBe('result');
    expect(seen).toEqual([{ inputTokens: 42, outputTokens: 7 }]);
  });

  it('onUsage fires per attempt on schema retry (multiple usage rows)', async () => {
    const seen: ModelUsage[] = [];
    // 恒返回不满足 schema 的输出 → 重试耗尽（maxAttempts=2），每次 call 各产一条 usage。
    const caller: ModelCaller = {
      async call() {
        return { text: '"not-an-object"', usage: { inputTokens: 5, outputTokens: 1 } };
      },
    };
    const outcome = await llmHarness(
      {
        input: 'x',
        model: 'glm-5.2',
        maxAttempts: 2,
        schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      },
      caller,
      (u) => seen.push(u),
    );
    expect(outcome.kind).toBe('failed');
    expect(seen.length).toBe(2);
  });

  it('caller without usage → onUsage not called', async () => {
    const seen: ModelUsage[] = [];
    const caller: ModelCaller = {
      async call() {
        return { text: 'plain' };
      },
    };
    await llmHarness({ input: 'hi', model: 'm' }, caller, (u) => seen.push(u));
    expect(seen.length).toBe(0);
  });
});

describe('UsageStore + AE打点', () => {
  it('UsageStore.write persists a row queryable via SQL', async () => {
    await env.DB_AUDIT.prepare('DELETE FROM usage').run();
    const store = new UsageStore(env.DB_AUDIT);
    await store.write({
      provider: 'anthropic',
      model: 'glm-5.2',
      agentDef: 'deep-research',
      instance: 'inst-1',
      inputTokens: 100,
      outputTokens: 40,
    });
    const row = await env.DB_AUDIT.prepare(
      'SELECT provider, model, agent_def, instance, input_tokens, output_tokens FROM usage',
    ).first<Record<string, unknown>>();
    expect(row?.provider).toBe('anthropic');
    expect(row?.model).toBe('glm-5.2');
    expect(row?.agent_def).toBe('deep-research');
    expect(row?.input_tokens).toBe(100);
    expect(row?.output_tokens).toBe(40);
  });

  it('writeUsageDataPoint calls AE binding with ordered blobs/doubles/indexes', () => {
    const spy = vi.fn();
    const fakeAe = { writeDataPoint: spy } as unknown as Parameters<typeof writeUsageDataPoint>[0];
    writeUsageDataPoint(fakeAe, {
      provider: 'anthropic',
      model: 'glm-5.2',
      agentDef: 'dr',
      instance: 'i1',
      inputTokens: 12,
      outputTokens: 3,
      cost: 0.01,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      blobs: ['anthropic', 'glm-5.2', 'dr', 'i1'],
      doubles: [12, 3, 0.01],
      indexes: ['anthropic'],
    });
  });

  it('writeUsageDataPoint no-op when binding undefined (AE optional)', () => {
    expect(() =>
      writeUsageDataPoint(undefined, {
        provider: 'p',
        model: 'm',
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).not.toThrow();
  });

  it('real AE_METRICS binding exists in miniflare and writeDataPoint is a callable no-op', () => {
    // 实测结论：vitest-pool-workers 本地提供 AE 绑定，writeDataPoint 可调（no-op，不落可查存储）。
    const ae = env.AE_METRICS;
    expect(ae).toBeDefined();
    expect(() =>
      writeUsageDataPoint(ae, { provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1 }),
    ).not.toThrow();
  });
});
