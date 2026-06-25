/**
 * DeepSeekClient：DeepSeek 官方 API 的薄客户端（OpenAI 兼容 chat completions，
 * V1 非流式）。实现窄接口 ModelClient。
 *
 * 设计约束：
 * - fetch 通过构造参数注入（默认 globalThis.fetch），测试全用 mock fetch，
 *   不打真实 API、不起真实网络。
 * - 每次响应都归一化 usage 并算出 costUsd（成本是一等公民）。
 * - 瞬时错误（429 / 5xx / 网络错误）指数退避重试，重试次数与退避函数可注入
 *   （测试用 0 延迟）。非瞬时错误（4xx）不重试，抛类型化 ModelError。
 */

import { ModelError, isTransientStatus } from './errors.js';
import {
  DEFAULT_PRICE_TABLE,
  computeCostUsd,
  priceFor,
  type PriceTable,
} from './pricing.js';
import type {
  AssistantMessage,
  ChatRequest,
  ModelClient,
  NormalizedChatResponse,
  NormalizedUsage,
  ToolCall,
} from './types.js';

/** fetch 的最小签名（只用到本客户端需要的部分）。 */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** 退避函数：给定第几次重试（从 1 开始），返回等待毫秒数。 */
export type BackoffFn = (attempt: number) => number;

/** 默认指数退避：100ms、200ms、400ms... 上限 5s。测试用 () => 0 覆盖。 */
export const defaultBackoff: BackoffFn = (attempt) =>
  Math.min(100 * 2 ** (attempt - 1), 5_000);

export interface DeepSeekClientOptions {
  /** DeepSeek API key */
  apiKey: string;
  /** API base URL，默认官方端点 */
  baseUrl?: string;
  /** 注入的 fetch，默认 globalThis.fetch */
  fetch?: FetchLike;
  /** 最大重试次数（不含首次），默认 3 */
  maxRetries?: number;
  /** 退避函数，默认 defaultBackoff */
  backoff?: BackoffFn;
  /** sleep 实现，默认 setTimeout；测试可注入 () => Promise.resolve() */
  sleep?: (ms: number) => Promise<void>;
  /** 价格表覆盖，默认 DEFAULT_PRICE_TABLE */
  priceTable?: PriceTable;
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com';

/** DeepSeek 原始响应体的最小结构（只取本客户端用到的字段）。 */
interface RawChatResponse {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** DeepSeek 特有：输入中命中 / 未命中 prefix cache 的 token 数 */
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 把 DeepSeek 原始 usage 归一化。
 *
 * DeepSeek 给 prompt_cache_hit_tokens / prompt_cache_miss_tokens，二者之和应
 * 等于 prompt_tokens。若 provider 未给细分（如老接口），全部计为 miss——
 * 按全价计费是安全的保守估计，绝不把未知段当 cache hit 低估成本。
 */
export function normalizeUsage(raw: RawChatResponse['usage']): NormalizedUsage {
  const prompt = raw?.prompt_tokens ?? 0;
  const completion = raw?.completion_tokens ?? 0;
  const hit = raw?.prompt_cache_hit_tokens;
  const miss = raw?.prompt_cache_miss_tokens;

  let cacheHitTokens: number;
  let cacheMissTokens: number;
  if (hit === undefined && miss === undefined) {
    // 无细分：全额按 miss 计（保守，不低估成本）
    cacheHitTokens = 0;
    cacheMissTokens = prompt;
  } else {
    cacheHitTokens = hit ?? 0;
    cacheMissTokens = miss ?? Math.max(prompt - cacheHitTokens, 0);
  }

  const inputTokens = cacheHitTokens + cacheMissTokens;
  return {
    inputTokens,
    outputTokens: completion,
    cacheHitTokens,
    cacheMissTokens,
    totalTokens: raw?.total_tokens ?? inputTokens + completion,
  };
}

export class DeepSeekClient implements ModelClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly backoff: BackoffFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly priceTable: PriceTable;

  constructor(opts: DeepSeekClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    // 默认绑定 globalThis.fetch；不存在则要求显式注入。
    // 注意：在 Cloudflare Workers / 浏览器中，全局 fetch 必须以全局对象为
    // this 调用——存成实例字段后用 this.fetchImpl(...) 调用会丢失绑定并抛
    // "Illegal invocation"，故此处显式 bind 到 globalThis。
    const defaultFetch =
      typeof globalThis.fetch === 'function'
        ? (globalThis.fetch.bind(globalThis) as unknown as FetchLike)
        : undefined;
    this.fetchImpl = opts.fetch ?? defaultFetch ?? undefined!;
    if (!this.fetchImpl) {
      throw new Error('no fetch available; inject one via options.fetch');
    }
    this.maxRetries = opts.maxRetries ?? 3;
    this.backoff = opts.backoff ?? defaultBackoff;
    this.sleep = opts.sleep ?? defaultSleep;
    this.priceTable = opts.priceTable ?? DEFAULT_PRICE_TABLE;
  }

  async chat(request: ChatRequest): Promise<NormalizedChatResponse> {
    const body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      stream: false,
    });

    const raw = await this.fetchWithRetry(body);
    return this.normalize(request.model, raw);
  }

  /**
   * 发请求并按瞬时/非瞬时策略重试。
   * - HTTP 非 2xx：429/5xx 瞬时重试，其余 4xx 立即抛 ModelError。
   * - fetch 抛错（网络错误）：瞬时重试。
   * - 重试耗尽：抛 ModelRetryExhausted（携带最后一次的 cause）。
   */
  private async fetchWithRetry(body: string): Promise<RawChatResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
    };

    let lastError: ModelError | undefined;
    // 总尝试次数 = 1（首次）+ maxRetries
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await this.sleep(this.backoff(attempt));
      }

      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.fetchImpl(url, { method: 'POST', headers, body });
      } catch (cause) {
        // 网络层失败：瞬时，可重试
        lastError = new ModelError({
          code: 'ModelNetworkError',
          message: `network error calling DeepSeek: ${stringifyCause(cause)}`,
          transient: true,
          cause,
        });
        continue;
      }

      if (res.ok) {
        const text = await res.text();
        return parseJson(text);
      }

      // HTTP 错误：按状态码区分瞬时与否
      const transient = isTransientStatus(res.status);
      const errBody = await safeText(res);
      const httpError = new ModelError({
        code: 'ModelHttpError',
        message: `DeepSeek returned HTTP ${res.status}: ${truncate(errBody)}`,
        status: res.status,
        transient,
      });
      if (!transient) {
        // 4xx（非 429）不重试，直接抛
        throw httpError;
      }
      lastError = httpError;
    }

    // 重试耗尽
    throw new ModelError({
      code: 'ModelRetryExhausted',
      message: `DeepSeek call failed after ${this.maxRetries + 1} attempts: ${
        lastError?.message ?? 'unknown'
      }`,
      status: lastError?.status,
      transient: false,
      cause: lastError,
    });
  }

  /** 归一化原始响应：抽取助手消息、归一 usage、算 costUsd。 */
  private normalize(model: string, raw: RawChatResponse): NormalizedChatResponse {
    const choice = raw.choices?.[0];
    if (!choice || !choice.message) {
      throw new ModelError({
        code: 'ModelResponseInvalid',
        message: 'DeepSeek response missing choices[0].message',
        transient: false,
      });
    }
    const message: AssistantMessage = {
      role: 'assistant',
      content: choice.message.content ?? null,
      ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
    };

    const usage = normalizeUsage(raw.usage);
    const price = priceFor(model, this.priceTable);
    const costUsd = computeCostUsd(usage, price);

    return {
      model,
      message,
      finishReason: choice.finish_reason ?? null,
      usage,
      costUsd,
    };
  }
}

// ---- 内部小工具 ----

function parseJson(text: string): RawChatResponse {
  try {
    return JSON.parse(text) as RawChatResponse;
  } catch (cause) {
    throw new ModelError({
      code: 'ModelResponseInvalid',
      message: `DeepSeek response is not valid JSON: ${truncate(text)}`,
      transient: false,
      cause,
    });
  }
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function truncate(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
