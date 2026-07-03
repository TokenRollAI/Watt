/**
 * llm harness（Proto §3.3 AgentEndpoint / §3.4 ExpectSpec.schema 校验重试）。
 *
 * OnEvent → 调模型（ModelCaller，Anthropic Messages 格式，注入以便测试 fake）→
 *   若 expect.schema 存在：core validateAgentOutput 校验 output；不符 → 携带校验错误退回重试
 *   （core shouldRetry，最多 DEFAULT_MAX_ATTEMPTS=3 次，实现声明）；仍失败 →
 *   failed(reason='invalid_output', error=首个违规摘要)；成功 → result(output)。
 *   无 schema：模型输出直接作 output（尝试 JSON 解析，失败作纯文本）。
 *
 * 纯逻辑（模型调用经注入的 ModelCaller）：不直接读 env/网络——测试用 fake caller 驱动
 *   schema 失败重试路径（toolchain-pitfalls §35，@llm 真实调用留 tag 集成测试）。
 *
 * §7 E2E 约定：断言协议事实（schema 合法的 agent.result），不断言 LLM 文本内容。
 */

import {
  DEFAULT_MAX_ATTEMPTS,
  type SchemaViolation,
  shouldRetry,
  validateAgentOutput,
} from '@watt/core';
import type { HarnessOutcome, ModelCaller, ModelCallRequest } from './types.ts';

/** llm harness 输入：spawn input + 可选 expect.schema + 模型名。 */
export interface LlmHarnessInput {
  /** spawn/send 的 input（作提示主体）。 */
  input: unknown;
  /** ExpectSpec.schema（JSON Schema）——存在则校验 output 并重试（§3.4）。 */
  schema?: unknown;
  /** 解析后的模型名（ModelProvider 解析或 env 缺省）。 */
  model: string;
  /** 最大尝试次数（实现声明缺省 3）。 */
  maxAttempts?: number;
}

/** 把 input 拼成模型提示（携带 schema 约束提示 + 可能的重试违规反馈）。 */
function buildRequest(
  input: LlmHarnessInput,
  retryViolations: SchemaViolation[] | undefined,
): ModelCallRequest {
  const promptBody = typeof input.input === 'string' ? input.input : JSON.stringify(input.input);
  let system: string | undefined;
  if (input.schema !== undefined) {
    system = `Respond with a single JSON value that conforms to this JSON Schema: ${JSON.stringify(
      input.schema,
    )}. Output only the JSON, no prose.`;
  }
  let prompt = promptBody;
  if (retryViolations !== undefined && retryViolations.length > 0) {
    // 退回子实例重试：携带上次校验错误（§3.4「携带校验错误退回子实例重试」）。
    const summary = retryViolations.map((v) => `${v.path || '<root>'}: ${v.message}`).join('; ');
    prompt = `${promptBody}\n\nYour previous output failed schema validation: ${summary}. Fix it and respond with valid JSON only.`;
  }
  return { system, prompt, model: input.model };
}

/** 尝试把模型文本解析成结构化 output；非 JSON → 原样文本。 */
function parseOutput(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * 运行 llm harness。expect.schema 存在则校验 + 重试；耗尽 → invalid_output failed。
 * 模型调用抛错（网络/上游）→ failed(reason='error')——不重试（§3.4 平台不隐式重试模型错误）。
 */
export async function llmHarness(
  input: LlmHarnessInput,
  caller: ModelCaller,
): Promise<HarnessOutcome> {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let lastViolations: SchemaViolation[] | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let text: string;
    try {
      text = await caller.call(buildRequest(input, lastViolations));
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      return { kind: 'failed', reason: 'error', errorMessage: `model call failed: ${msg}` };
    }
    const output = parseOutput(text);

    // 无 schema：直接成功（模型输出作 output）。
    if (input.schema === undefined) {
      return { kind: 'result', output };
    }

    const outcome = validateAgentOutput(output, input.schema);
    if (outcome.valid) {
      return { kind: 'result', output };
    }
    lastViolations = outcome.violations;
    // 还能重试则继续循环（退回子实例重试，携带违规反馈）；否则落 invalid_output。
    if (!shouldRetry(attempt, maxAttempts)) {
      const summary = outcome.violations
        .map((v) => `${v.path || '<root>'}: ${v.message}`)
        .join('; ');
      return {
        kind: 'failed',
        reason: 'invalid_output',
        errorMessage: `output failed schema validation after ${maxAttempts} attempts: ${summary}`,
      };
    }
  }
  // 理论不可达（循环内 return）；兜底 invalid_output。
  return {
    kind: 'failed',
    reason: 'invalid_output',
    errorMessage: 'output failed schema validation',
  };
}
