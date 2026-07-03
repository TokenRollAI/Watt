/**
 * Anthropic Messages 格式模型调用（Proto §9 ModelRouter 消费面 / 中转直连）。
 *
 * 走中转 `ANTHROPIC_BASE_URL`（缺省 https://llm.fantacy.live），Anthropic Messages 格式，
 * key 从 env secret `ANTHROPIC_API_KEY`。这是 DoD §6 项 3 @llm 集成的真实模型路径
 * （external-facts：中转直连最简；AI Gateway custom provider 留 M8 规范路径）。
 *
 * 用 Vercel AI SDK（`ai` + `@ai-sdk/anthropic` 的 createAnthropic）——供应商中立的模型调用层
 * （LOOP 纪律 4：模型调用经成熟 SDK，不手拼 HTTP；换 provider 只改工厂不动调用点）。
 * 版本对齐：ai@6 + @ai-sdk/anthropic@3，与 agents@0.17.3 的 `ai@^6` peer 一致（勿升 ai@7）。
 *
 * workerd 适配（关键）：Workers 无 process.env，必须用 `createAnthropic()` 工厂显式传 apiKey/baseURL
 * （从 env binding 取），禁用裸 `import { anthropic }`（会静默读 env 失败）。fetch 可注入。
 *
 * baseURL 语义：createAnthropic 的 baseURL 缺省 `https://api.anthropic.com/v1`，SDK 在其后拼
 * `/messages`——中转期望 `${base}/v1/messages`，故 baseUrl 传 `${中转根}/v1`（见 withV1Suffix）。
 *
 * 此 harness = 单次调用（generateText，文本进/文本出）；schema 校验重试在 llm.ts（保留协议语义
 * §3.4 携带违规反馈退回重发，不交给 SDK 的黑盒重试）。测试用 fake caller 不走此实现（不触网络）。
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import type { ModelCaller, ModelCallRequest, ModelCallResult } from './types.ts';

/** 默认中转基址（external-facts / .env ANTHROPIC_BASE_URL）——不含 /v1。 */
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://llm.fantacy.live';

/** 默认单次模型调用超时（实现声明）：60s。超时 → 抛错 → llm harness 归类 failed(reason='error')。 */
export const DEFAULT_MODEL_TIMEOUT_MS = 60_000;

/** createAnthropic 的 baseURL 需含 /v1（其后拼 /messages）；补齐 base 的 /v1 后缀，去尾斜杠。 */
function withV1Suffix(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

/**
 * 构造真实 Anthropic Messages caller。
 * baseUrl/apiKey 从 env 取（缺省 baseUrl）；maxOutputTokens 保守取 1024（结构化 output 足够）。
 * fetchImpl 可注入（默认全局 fetch，workerd 下即 runtime fetch）。
 * timeoutMs：单次调用超时（缺省 DEFAULT_MODEL_TIMEOUT_MS）——经 AbortSignal.timeout 传给 generateText，
 *   超时中止上游请求并抛错（llm harness 捕获 → failed(reason='error')，避免 onEvent 无限挂起吃满
 *   correlation.timeoutMs 才被平台超时代发）。
 */
export function createAnthropicCaller(opts: {
  baseUrl?: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ModelCaller {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
  const provider = createAnthropic({
    apiKey: opts.apiKey,
    baseURL: withV1Suffix(opts.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL),
    ...(opts.fetchImpl !== undefined ? { fetch: opts.fetchImpl } : {}),
  });
  return {
    async call(req: ModelCallRequest): Promise<ModelCallResult> {
      const { text, usage } = await generateText({
        model: provider(req.model),
        maxOutputTokens: 1024,
        abortSignal: AbortSignal.timeout(timeoutMs),
        ...(req.system !== undefined ? { system: req.system } : {}),
        prompt: req.prompt,
      });
      if (typeof text !== 'string' || text.length === 0) {
        throw new Error('anthropic messages response missing content text');
      }
      // AI SDK usage：inputTokens/outputTokens（ai@6）；缺省时省略（打点侧按 0 处理）。
      const modelUsage =
        usage !== undefined
          ? { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 }
          : undefined;
      return { text, ...(modelUsage !== undefined ? { usage: modelUsage } : {}) };
    },
  };
}
