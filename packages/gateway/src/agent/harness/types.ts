/**
 * harness 共享类型（Proto §3.3 AgentEndpoint / §3.4 结果回传）。
 *
 * HarnessOutcome：harness 的产出——result（成功，含 output）或 failed（reason + 可选 error message），
 *   由 AgentInstance 侧转成 agent.result / agent.failed 事件 publish（带 correlationId 定向回送）。
 *
 * ModelCaller：llm harness 的模型调用抽象（Anthropic Messages 格式）——注入以便测试用 fake
 *   （对齐 vector provider 的 AI 依赖注入模式，toolchain-pitfalls §35：测试不读 env.AI/网络）。
 */

import type { AgentFailedReason } from '@watt/core';

/** harness 产出：result（成功）或 failed（reason + 可选 error message）。 */
export type HarnessOutcome =
  | { kind: 'result'; output: unknown }
  | { kind: 'failed'; reason: AgentFailedReason; errorMessage?: string };

/** 一次模型调用的请求（Anthropic Messages 最小面）。 */
export interface ModelCallRequest {
  /** 系统提示（可选，携带 schema 约束提示）。 */
  system?: string;
  /** 用户消息文本（由 input + 可能的重试提示拼成）。 */
  prompt: string;
  /** 模型名（由 ModelProvider 解析或 env 缺省）。 */
  model: string;
}

/** 一次模型调用的 token 用量（Metrics 打点，§10）——AI SDK result.usage 投影。 */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

/** 模型调用结果：输出文本 + 可选用量（Metrics 打点用；测试 fake 可省略 usage）。 */
export interface ModelCallResult {
  text: string;
  usage?: ModelUsage;
}

/** 模型调用抽象：输入请求 → 输出文本（Anthropic content[0].text）+ 可选用量。 */
export interface ModelCaller {
  call(req: ModelCallRequest): Promise<ModelCallResult>;
}
