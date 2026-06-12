import { describe, expect, it } from 'vitest';
import {
  AgentSpec,
  ContextPackage,
  newArtifactId,
  newCheckpointId,
} from '../src/index.js';

const validSpec = {
  instructions: '你是调研 Agent，负责收集并总结指定主题的资料。',
  outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
  tools: [{ tool: 'web_search' }, { tool: 'github', scope: { repos: ['o/r'] } }],
  model: { id: 'deepseek/deepseek-chat', temperature: 0.7 },
  runtime: 'worker',
  lifecycle: 'ephemeral',
} satisfies Record<string, unknown>;

describe('AgentSpec', () => {
  it('接受合法 6 字段 spec', () => {
    expect(AgentSpec.parse(validSpec)).toMatchObject({ runtime: 'worker' });
  });

  it('model id 必须是 provider/model 形态', () => {
    expect(AgentSpec.safeParse({ ...validSpec, model: { id: 'deepseek' } }).success).toBe(false);
  });

  it('拒绝缺失字段（6 字段全必填）', () => {
    for (const key of Object.keys(validSpec)) {
      const { [key as keyof typeof validSpec]: _, ...rest } = validSpec;
      expect(AgentSpec.safeParse(rest).success).toBe(false);
    }
  });

  it('纯数据：未知字段被剥离而非保留', () => {
    const parsed = AgentSpec.parse({ ...validSpec, execute: () => 1 });
    expect('execute' in parsed).toBe(false);
  });
});

describe('ContextPackage', () => {
  const pkg = {
    objective: '调研 QuickJS WASM 在 Workers 中的 gas 计量方案',
    inputs: [
      { ref: newCheckpointId(), summary: '上一阶段调研摘要' },
      { ref: 'https://example.com/spec', summary: '外部规格' },
    ],
    budget: { maxCostUsd: 0.5, maxWallClockMs: 600_000, maxToolCalls: 50 },
    expectedOutput: '中文 Markdown 报告，含结论与引用',
    permissions: { contextScope: ['ckpt', 'art'] },
  };

  it('接受合法 5 字段包', () => {
    expect(ContextPackage.parse(pkg).inputs).toHaveLength(2);
  });

  it('inputs ref 只接受受认资源 ID 或 URL', () => {
    const bad = { ...pkg, inputs: [{ ref: 'raw-text', summary: 's' }] };
    expect(ContextPackage.safeParse(bad).success).toBe(false);
  });

  it('预算三限全必填且为正', () => {
    const bad = { ...pkg, budget: { maxCostUsd: 0.5, maxWallClockMs: 600_000 } };
    expect(ContextPackage.safeParse(bad).success).toBe(false);
    const zero = { ...pkg, budget: { ...pkg.budget, maxCostUsd: 0 } };
    expect(ContextPackage.safeParse(zero).success).toBe(false);
  });

  it('artifact id 可作为 input ref', () => {
    const withArt = { ...pkg, inputs: [{ ref: newArtifactId(), summary: '报告' }] };
    expect(ContextPackage.safeParse(withArt).success).toBe(true);
  });
});
