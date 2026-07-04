/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from 'vitest';
import { createAnthropicCaller } from '../src/agent/harness/anthropic-caller.ts';
import type { HarnessTool } from '../src/agent/harness/types.ts';

/**
 * anthropic-caller usage 语义锁定（ai@6：result.usage=最后一步 / result.totalUsage=全步累计）。
 *
 * 带 tools 的 agentic loop（stopWhen stepCountIs）跑多步——若取 result.usage 会系统性丢失
 *   前面所有 step 的 token（Metrics 打点漏账）。本文件用 fake fetchImpl 模拟中转两步应答
 *   （step1 tool_use → step2 end_turn），锁定 caller 返回的 usage 是**两步之和**；
 *   回归含义：改回 result.usage 时本测试必红（只会看到最后一步的量）。
 */

/** Anthropic Messages 应答体（@ai-sdk/anthropic doGenerate 消费的最小面）。 */
function messagesResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createAnthropicCaller usage accounting (ai@6 totalUsage)', () => {
  it('sums token usage across all agentic-loop steps, not just the last one', async () => {
    let callCount = 0;
    let toolExecuted = 0;
    const fetchImpl: typeof fetch = async (_input, _init) => {
      callCount += 1;
      if (callCount === 1) {
        // step 1：模型决定调工具（stop_reason=tool_use），耗 100 in / 10 out。
        return messagesResponse({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'fake-model',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'probe', input: { q: 'x' } }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 10 },
        });
      }
      // step 2：工具结果回喂后产最终文本（end_turn），耗 150 in / 20 out。
      return messagesResponse({
        id: 'msg_2',
        type: 'message',
        role: 'assistant',
        model: 'fake-model',
        content: [{ type: 'text', text: 'final answer' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 150, output_tokens: 20 },
      });
    };

    const probe: HarnessTool = {
      name: 'probe',
      description: 'test probe tool',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      execute: async () => {
        toolExecuted += 1;
        return { ok: true };
      },
    };

    const caller = createAnthropicCaller({
      apiKey: 'test-key',
      baseUrl: 'https://fake-relay.test',
      fetchImpl,
    });
    const result = await caller.call({
      prompt: 'do the thing',
      model: 'fake-model',
      tools: [probe],
    });

    expect(callCount).toBe(2);
    expect(toolExecuted).toBe(1);
    expect(result.text).toBe('final answer');
    // 协议事实：usage = 全步累计（100+150 / 10+20）。取 result.usage（仅最后一步）会得 150/20。
    expect(result.usage).toEqual({ inputTokens: 250, outputTokens: 30 });
  });

  it('keeps single-step usage intact when no tools are given (no regression)', async () => {
    const fetchImpl: typeof fetch = async () =>
      messagesResponse({
        id: 'msg_only',
        type: 'message',
        role: 'assistant',
        model: 'fake-model',
        content: [{ type: 'text', text: 'plain' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 42, output_tokens: 7 },
      });

    const caller = createAnthropicCaller({
      apiKey: 'test-key',
      baseUrl: 'https://fake-relay.test',
      fetchImpl,
    });
    const result = await caller.call({ prompt: 'hi', model: 'fake-model' });

    expect(result.text).toBe('plain');
    // 单步时 totalUsage === usage（sum of one step）——无工具路径零回归。
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
  });
});
