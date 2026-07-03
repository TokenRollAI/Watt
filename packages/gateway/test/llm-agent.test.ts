/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from 'vitest';
import { createAnthropicCaller } from '../src/agent/harness/anthropic-caller.ts';
import { llmHarness } from '../src/agent/harness/llm.ts';

/**
 * @llm 集成测试（DoD §6 项3 真实模型路径）——默认 SKIP，仅在 LLM_TESTS=1 且提供
 * ANTHROPIC_API_KEY 时运行（LOOP 纪律 3：@llm 每轮每 tag 最多一次，真实消耗资源）。
 *
 * 运行说明（team-lead 手动跑）：
 *   LLM_TESTS=1 ANTHROPIC_API_KEY=<key> ANTHROPIC_BASE_URL=https://llm.fantacy.live \
 *     pnpm --filter @watt/gateway vitest run test/llm-agent.test.ts
 *   （若走本机代理需 https_proxy；模型名默认 glm-5.2，中转 Anthropic Messages 格式）。
 *
 * 断言协议事实（§7 E2E 约定）：llm harness 经真实模型 + expect.schema 校验 → 产出 schema 合法的
 *   agent.result（结构化 output 满足 JSON Schema），**不断言 LLM 文本内容**。
 */

const RUN = process.env.LLM_TESTS === '1' && (process.env.ANTHROPIC_API_KEY ?? '').length > 0;

describe.skipIf(!RUN)('llm harness — real model (@llm)', () => {
  it('produces a schema-valid agent.result via the real Anthropic Messages relay', async () => {
    const caller = createAnthropicCaller({
      apiKey: process.env.ANTHROPIC_API_KEY as string,
      baseUrl: process.env.ANTHROPIC_BASE_URL,
    });
    // 结构化任务：要求返回符合 schema 的评分对象（fan-in 结构化结果的形状约束）。
    const schema = {
      type: 'object',
      properties: {
        sentiment: { type: 'string' },
        score: { type: 'number' },
      },
      required: ['sentiment', 'score'],
    };
    const outcome = await llmHarness(
      {
        input:
          'Classify the sentiment of "I love this product!" and give a score from 0 to 1. ' +
          'Respond as JSON with keys "sentiment" (string) and "score" (number).',
        schema,
        model: process.env.LLM_MODEL ?? 'glm-5.2',
        maxAttempts: 3,
      },
      caller,
    );
    // 协议事实：收到 schema 合法的 result（不看具体文本/分值）。
    expect(outcome.kind).toBe('result');
    if (outcome.kind === 'result') {
      const out = outcome.output as { sentiment?: unknown; score?: unknown };
      expect(typeof out.sentiment).toBe('string');
      expect(typeof out.score).toBe('number');
    }
  });
});
