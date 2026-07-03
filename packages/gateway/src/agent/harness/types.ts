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

/**
 * 一个可供模型调用的工具（agentic loop）——名/描述/JSON Schema 入参 + execute。
 *
 * 这是 harness 侧的 provider 中立工具面（不绑 AI SDK 类型）：inputSchema 是 JSON Schema
 *   对象（execute 前由 caller 侧转成 SDK Schema），execute 收到模型给的参数、产出结果对象
 *   （回喂模型继续多步）。manage/* Agent 的 platform 接口（如 scheduler_write/list）经此暴露，
 *   execute 内直调对应 Manager + 过 Authorizer.Check（委托链见 claims）。
 *
 * 边界（LOOP 纪律 4）：工具循环由 AI SDK generateText 的 stopWhen 承接（不自写 loop）；
 *   本类型只声明工具契约，不含循环控制。
 */
export interface HarnessTool {
  /** 工具名（模型据此选调；须匹配 [a-zA-Z0-9_-]，AI SDK 工具键约束）。 */
  name: string;
  /** 工具描述（模型据此判断何时/如何调用）。 */
  description: string;
  /** 入参 JSON Schema（object）——caller 侧转成 AI SDK Schema 校验模型给的参数。 */
  inputSchema: Record<string, unknown>;
  /** 执行工具：收到模型参数 → 产出结果对象（回喂模型）。抛错由 SDK 捕获为工具错误结果。 */
  execute(args: Record<string, unknown>): Promise<unknown>;
}

/** 一次模型调用的请求（Anthropic Messages 最小面）。 */
export interface ModelCallRequest {
  /** 系统提示（可选，携带 schema 约束提示）。 */
  system?: string;
  /** 用户消息文本（由 input + 可能的重试提示拼成）。 */
  prompt: string;
  /** 模型名（由 ModelProvider 解析或 env 缺省）。 */
  model: string;
  /**
   * 可选工具集（agentic loop）——非空时 caller 走多步工具调用（generateText tools + stopWhen），
   *   模型可多轮调工具后产最终文本；缺省（undefined/空）时 caller 保持单次调用（无回归）。
   */
  tools?: HarnessTool[];
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
