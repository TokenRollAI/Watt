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
 *
 * 边界声明（LOOP 纪律 4）：本 harness = 单次模型调用 + expect.schema 校验重试（§3.2/§3.4）。
 *   多轮工具调用循环（R25 DoD④ manage/* Agent）由 LlmHarnessInput.tools 触发，**循环本身交给成熟
 *   框架**（AI SDK generateText 的 tools + stopWhen，见 anthropic-caller.ts）——本文件不自增 loop、
 *   不手拼多轮工具调度，只把 tools 透传给注入的 ModelCaller。systemOverride（manage/* def 的 ~skill
 *   system prompt）优先于 schema 约束提示。模型调用本身经官方 @anthropic-ai/sdk（见 anthropic-caller.ts），
 *   不手拼 HTTP。
 */

import {
  DEFAULT_MAX_ATTEMPTS,
  type SchemaViolation,
  shouldRetry,
  validateAgentOutput,
} from '@watt/core';
import type {
  HarnessOutcome,
  HarnessTool,
  ModelCaller,
  ModelCallRequest,
  ModelUsage,
} from './types.ts';

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
  /**
   * 可选工具集（agentic loop，R25 DoD④ manage/* Agent）——非空时 caller 走多步工具调用
   *   （模型多轮调工具后产最终文本）；缺省时保持单次调用（无回归）。工具循环与 schema 重试正交：
   *   有 schema 时最终文本仍走 validateAgentOutput 校验重试；无 schema（manage/* 常态）时最终文本直接作 output。
   */
  tools?: HarnessTool[];
}

/** 覆盖系统提示（manage/* Agent 的 def system prompt 内嵌该层 ~skill）——存在则替代 schema 约束提示。 */
export interface LlmSystemOverride {
  system?: string;
}

/** 把 input 拼成模型提示（携带 schema 约束提示 + 可能的重试违规反馈）。 */
function buildRequest(
  input: LlmHarnessInput,
  retryViolations: SchemaViolation[] | undefined,
  systemOverride?: string,
): ModelCallRequest {
  const promptBody = typeof input.input === 'string' ? input.input : JSON.stringify(input.input);
  // system 优先级：def 显式 systemOverride（manage/* ~skill）＞ schema 约束提示 ＞ 无。
  let system: string | undefined = systemOverride;
  if (system === undefined && input.schema !== undefined) {
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
  return {
    system,
    prompt,
    model: input.model,
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
  };
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
 *
 * onUsage：每次真实模型调用返回 usage 时回调（Metrics 打点，§10）——重试多次则回调多次
 *   （每次模型调用各产一行 usage）。注入以便 agent-instance 写 usage 表 + AE 打点（测试可省略）。
 */
export async function llmHarness(
  input: LlmHarnessInput,
  caller: ModelCaller,
  onUsage?: (usage: ModelUsage) => void,
  systemOverride?: string,
): Promise<HarnessOutcome> {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let lastViolations: SchemaViolation[] | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let text: string;
    try {
      const result = await caller.call(buildRequest(input, lastViolations, systemOverride));
      text = result.text;
      if (result.usage !== undefined && onUsage !== undefined) onUsage(result.usage);
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
