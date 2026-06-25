import { describe, expect, it } from 'vitest';
import type { AgentSpec, ContextPackage } from '@watt/protocol';
import {
  BudgetExceededError,
  BudgetMeter,
  allowedToolNames,
  validateOutput,
} from '../src/index.js';

describe('BudgetMeter', () => {
  const budget = { maxCostUsd: 1, maxWallClockMs: 1000, maxToolCalls: 2 };

  it('成本累计与工具计数', () => {
    const meter = new BudgetMeter(budget, () => 0);
    meter.addModelCost(0.1);
    meter.addToolCall(0.05);
    expect(meter.spentUsd).toBeCloseTo(0.15, 9);
    expect(meter.toolCallCount).toBe(1);
  });

  it('assertCanCallTool 到上限抛 BudgetExceededError(maxToolCalls)', () => {
    const meter = new BudgetMeter(budget, () => 0);
    meter.addToolCall(0);
    meter.addToolCall(0);
    expect(() => meter.assertCanCallTool()).toThrow(BudgetExceededError);
    try {
      meter.assertCanCallTool();
    } catch (e) {
      expect((e as BudgetExceededError).limit).toBe('maxToolCalls');
      expect((e as BudgetExceededError).code).toBe('BudgetExceeded');
    }
  });

  it('成本超限抛 maxCostUsd', () => {
    const meter = new BudgetMeter(budget, () => 0);
    meter.addModelCost(1);
    expect(() => meter.assertCanCallModel()).toThrow(/maxCostUsd/);
  });

  it('墙钟超限抛 maxWallClockMs', () => {
    let t = 0;
    const meter = new BudgetMeter(budget, () => t);
    t = 1000;
    expect(() => meter.assertCanCallModel()).toThrow(/maxWallClockMs/);
  });
});

describe('allowedToolNames', () => {
  const spec = {
    instructions: 'x',
    outputSchema: { type: 'object' },
    tools: [{ tool: 'a' }, { tool: 'b' }, { tool: 'c' }],
    model: { id: 'deepseek/deepseek-chat' },
    runtime: 'worker',
    lifecycle: 'ephemeral',
  } as unknown as AgentSpec;

  const baseCtx = {
    objective: 'o',
    inputs: [],
    budget: { maxCostUsd: 1, maxWallClockMs: 1, maxToolCalls: 1 },
    expectedOutput: 'e',
    permissions: { contextScope: [] },
  } as unknown as ContextPackage;

  it('无 toolScope → 白名单全集', () => {
    const names = allowedToolNames(spec, baseCtx);
    expect([...names].sort()).toEqual(['a', 'b', 'c']);
  });

  it('有 toolScope → 取交集', () => {
    const ctx = {
      ...baseCtx,
      permissions: { contextScope: [], toolScope: ['b', 'd'] },
    } as unknown as ContextPackage;
    const names = allowedToolNames(spec, ctx);
    expect([...names]).toEqual(['b']); // d 不在白名单，被交集排除
  });

  it('toolScope 为空数组 → 交集为空', () => {
    const ctx = {
      ...baseCtx,
      permissions: { contextScope: [], toolScope: [] },
    } as unknown as ContextPackage;
    expect(allowedToolNames(spec, ctx).size).toBe(0);
  });
});

describe('validateOutput', () => {
  const schema = {
    type: 'object',
    properties: { summary: { type: 'string' }, score: { type: 'number' } },
    required: ['summary'],
    additionalProperties: false,
  };

  it('合规对象通过', () => {
    const r = validateOutput(schema, { summary: 'ok', score: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).toEqual({ summary: 'ok', score: 1 });
  });

  it('缺必填字段失败并给错误明细', () => {
    const r = validateOutput(schema, { score: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });

  it('多余字段（additionalProperties:false）失败', () => {
    const r = validateOutput(schema, { summary: 'ok', extra: 1 });
    expect(r.ok).toBe(false);
  });

  it('类型不符失败', () => {
    const r = validateOutput(schema, { summary: 123 });
    expect(r.ok).toBe(false);
  });
});
