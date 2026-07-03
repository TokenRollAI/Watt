import { describe, expect, it } from 'vitest';
import { echoHarness } from '../src/agent/harness/echo.ts';
import { llmHarness } from '../src/agent/harness/llm.ts';
import type { HarnessTool, ModelCaller, ModelCallRequest } from '../src/agent/harness/types.ts';

/**
 * harness 纯逻辑单测（Proto §3.3 / §3.4）——无 DO、无网络。
 * echo：回显 input → result。
 * llm：注入 fake ModelCaller 驱动 schema 校验重试路径（toolchain-pitfalls §35，@llm 真实调用留 tag 集成）。
 *   断言协议事实（result/failed + reason），不断言 LLM 文本内容（§7 E2E 约定）。
 */

describe('echo harness (§3.3)', () => {
  it('echoes input as result output', () => {
    const outcome = echoHarness({ hello: 'world' });
    expect(outcome).toEqual({ kind: 'result', output: { echo: { hello: 'world' } } });
  });
});

/** 固定文本 fake caller（不看请求，恒返 text）。 */
function fixedCaller(text: string): ModelCaller {
  return {
    async call() {
      return { text };
    },
  };
}

/** 按尝试次数返回不同文本的 fake caller（驱动重试路径）。 */
function sequenceCaller(texts: string[]): ModelCaller & { calls: ModelCallRequest[] } {
  const calls: ModelCallRequest[] = [];
  return {
    calls,
    async call(req: ModelCallRequest) {
      const idx = calls.length;
      calls.push(req);
      return { text: texts[Math.min(idx, texts.length - 1)] as string };
    },
  };
}

describe('llm harness — no schema (§3.3)', () => {
  it('returns model output as result (JSON parsed)', async () => {
    const outcome = await llmHarness(
      { input: 'hi', model: 'glm-5.2' },
      fixedCaller('{"answer": 42}'),
    );
    expect(outcome).toEqual({ kind: 'result', output: { answer: 42 } });
  });

  it('non-JSON model output becomes plain text result', async () => {
    const outcome = await llmHarness({ input: 'hi', model: 'glm-5.2' }, fixedCaller('just text'));
    expect(outcome).toEqual({ kind: 'result', output: 'just text' });
  });

  it('model call error → failed(reason=error), not retried', async () => {
    const caller: ModelCaller = {
      async call() {
        throw new Error('upstream 500');
      },
    };
    const outcome = await llmHarness({ input: 'hi', model: 'glm-5.2' }, caller);
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'error' });
  });
});

describe('llm harness — with schema, retry (§3.4 校验重试)', () => {
  const schema = {
    type: 'object',
    properties: { score: { type: 'number' } },
    required: ['score'],
  };

  it('valid output on first attempt → result', async () => {
    const outcome = await llmHarness(
      { input: 'rate this', schema, model: 'glm-5.2', maxAttempts: 3 },
      fixedCaller('{"score": 5}'),
    );
    expect(outcome).toEqual({ kind: 'result', output: { score: 5 } });
  });

  it('invalid then valid within maxAttempts → result (retry with violation feedback)', async () => {
    const caller = sequenceCaller(['{"wrong": true}', '{"score": 7}']);
    const outcome = await llmHarness(
      { input: 'rate this', schema, model: 'glm-5.2', maxAttempts: 3 },
      caller,
    );
    expect(outcome).toEqual({ kind: 'result', output: { score: 7 } });
    // 第二次调用应携带上次校验违规反馈（退回子实例重试，§3.4）。
    expect(caller.calls).toHaveLength(2);
    expect(caller.calls[1]?.prompt).toContain('failed schema validation');
  });

  it('always-invalid → failed(reason=invalid_output) after maxAttempts', async () => {
    const caller = sequenceCaller(['{"wrong": 1}']);
    const outcome = await llmHarness(
      { input: 'rate this', schema, model: 'glm-5.2', maxAttempts: 3 },
      caller,
    );
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'invalid_output' });
    // 首次 + 2 次重试 = 3 次尝试（DEFAULT_MAX_ATTEMPTS 语义）。
    expect(caller.calls).toHaveLength(3);
  });
});

describe('llm harness — tool calling loop (§3.3 / R25 DoD④)', () => {
  /**
   * fake ModelCaller 模拟 AI SDK 的 agentic loop（真实循环在 anthropic-caller，此处不触网络）：
   *   收到 req.tools 时按 toolPlan 调对应工具的 execute（喂给它参数），最后返回确认文本。
   *   这验证 llm.ts 把 tools 透传给 caller + systemOverride 生效，工具 execute 被驱动。
   */
  function toolLoopCaller(
    toolPlan: { name: string; args: Record<string, unknown> }[],
    finalText: string,
  ): ModelCaller & { seenTools: string[]; seenSystem: (string | undefined)[] } {
    const seenTools: string[] = [];
    const seenSystem: (string | undefined)[] = [];
    return {
      seenTools,
      seenSystem,
      async call(req: ModelCallRequest) {
        seenSystem.push(req.system);
        for (const step of toolPlan) {
          const tool = req.tools?.find((t) => t.name === step.name);
          if (tool !== undefined) {
            seenTools.push(step.name);
            await tool.execute(step.args);
          }
        }
        return { text: finalText };
      },
    };
  }

  it('passes tools + systemOverride to caller and drives tool execute', async () => {
    const executed: Record<string, unknown>[] = [];
    const tools: HarnessTool[] = [
      {
        name: 'scheduler_write',
        description: 'create cron',
        inputSchema: { type: 'object' },
        async execute(args) {
          executed.push(args);
          return { job: { id: 'j1' } };
        },
      },
    ];
    const caller = toolLoopCaller(
      [{ name: 'scheduler_write', args: { schedule: '0 9 * * *' } }],
      '已为你创建每天 UTC 09:00 的 token 日报任务。',
    );
    const outcome = await llmHarness(
      { input: '每天9点发token日报', model: 'glm-5.2', tools },
      caller,
      undefined,
      'SYSTEM: cron skill',
    );
    // 无 schema → 最终文本直接作 output（非 JSON 保留纯文本）。
    expect(outcome).toEqual({
      kind: 'result',
      output: '已为你创建每天 UTC 09:00 的 token 日报任务。',
    });
    // 工具被驱动一次，参数透传。
    expect(executed).toEqual([{ schedule: '0 9 * * *' }]);
    expect(caller.seenTools).toEqual(['scheduler_write']);
    // systemOverride（~skill）覆盖了默认 system。
    expect(caller.seenSystem[0]).toBe('SYSTEM: cron skill');
  });

  it('no tools → single call unchanged (zero regression)', async () => {
    let sawTools: HarnessTool[] | undefined = [];
    const caller: ModelCaller = {
      async call(req) {
        sawTools = req.tools;
        return { text: 'plain answer' };
      },
    };
    const outcome = await llmHarness({ input: 'hi', model: 'glm-5.2' }, caller);
    expect(outcome).toEqual({ kind: 'result', output: 'plain answer' });
    // 无 tools 的 def：req.tools 为 undefined（不注入空数组），行为不变。
    expect(sawTools).toBeUndefined();
  });
});
