/**
 * echo harness（Proto §3.3 AgentEndpoint / §3.4）——最小内置 harness。
 *
 * OnEvent 回显 input：把 spawn 时的 input（或事件 payload）原样作为 agent.result.output。
 * 用于 Send+expect 全链验证（send → 定向回送）与协议事实测试，不涉及模型调用。
 *
 * 纯函数（无 I/O、无绑定）：产出 HarnessOutcome，由 AgentInstance 侧 publish 成 agent.result。
 */

import type { HarnessOutcome } from './types.ts';

/**
 * echo：回显 input（缺省回显事件 payload）。始终成功产出 result。
 * output 形状 = { echo: <input> }——稳定可断言（协议事实，非 LLM 文本）。
 */
export function echoHarness(input: unknown): HarnessOutcome {
  return { kind: 'result', output: { echo: input } };
}
