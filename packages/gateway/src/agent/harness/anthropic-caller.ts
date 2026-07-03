/**
 * Anthropic Messages 格式模型调用（Proto §9 ModelRouter 消费面 / 中转直连）。
 *
 * 走中转 `ANTHROPIC_BASE_URL`（缺省 https://llm.fantacy.live），Anthropic Messages 格式，
 * key 从 env secret `ANTHROPIC_API_KEY`（x-api-key）。这是 DoD §6 项 3 @llm 集成的真实模型路径
 * （external-facts：中转直连最简；AI Gateway custom provider 留 M8 规范路径）。
 *
 * 实现 ModelCaller 接口（llm harness 注入点）——测试用 fake caller 不走此实现（不触网络）。
 */

import type { ModelCaller, ModelCallRequest } from './types.ts';

/** 默认中转基址（external-facts / .env ANTHROPIC_BASE_URL）。 */
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://llm.fantacy.live';

/** Anthropic Messages 响应最小形状（content[0].text）。 */
interface AnthropicMessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
}

/**
 * 构造真实 Anthropic Messages caller。
 * baseUrl/apiKey 从 env 取（缺省 baseUrl）；max_tokens 保守取 1024（结构化 output 足够）。
 */
export function createAnthropicCaller(opts: {
  baseUrl?: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): ModelCaller {
  const base = (opts.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async call(req: ModelCallRequest): Promise<string> {
      const body: Record<string, unknown> = {
        model: req.model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: req.prompt }],
      };
      if (req.system !== undefined) body.system = req.system;
      const res = await fetchImpl(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': opts.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`anthropic messages returned HTTP ${res.status}: ${detail.slice(0, 200)}`);
      }
      const json = (await res.json()) as AnthropicMessagesResponse;
      const text = json.content?.find((c) => c.type === 'text')?.text ?? json.content?.[0]?.text;
      if (typeof text !== 'string') {
        throw new Error('anthropic messages response missing content text');
      }
      return text;
    },
  };
}
