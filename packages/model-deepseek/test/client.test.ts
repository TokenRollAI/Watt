import { describe, expect, it, vi } from 'vitest';
import {
  DeepSeekClient,
  DEFAULT_PRICE_TABLE,
  ModelError,
  computeCostUsd,
  normalizeUsage,
  type ChatRequest,
  type FetchLike,
} from '../src/index.js';

/** 构造一个返回固定原始响应的 mock fetch（成功路径）。 */
function okFetch(rawBody: unknown): FetchLike {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(rawBody),
  }));
}

const baseRequest: ChatRequest = {
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: '你好' }],
};

/** DeepSeek 风格的原始响应（带 cache hit/miss 细分）。 */
const rawWithCache = {
  model: 'deepseek-chat',
  choices: [
    {
      finish_reason: 'stop',
      message: { role: 'assistant', content: '你好，有什么可以帮你？' },
    },
  ],
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
    prompt_cache_hit_tokens: 800,
    prompt_cache_miss_tokens: 200,
  },
};

describe('usage 归一化', () => {
  it('细分 cache hit/miss 原样保留并汇总 input', () => {
    const u = normalizeUsage(rawWithCache.usage);
    expect(u).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheHitTokens: 800,
      cacheMissTokens: 200,
      totalTokens: 1200,
    });
  });

  it('无细分时保守全计为 miss（不低估成本）', () => {
    const u = normalizeUsage({ prompt_tokens: 500, completion_tokens: 100 });
    expect(u.cacheHitTokens).toBe(0);
    expect(u.cacheMissTokens).toBe(500);
    expect(u.inputTokens).toBe(500);
  });

  it('只给 hit 时 miss 由 prompt 推导', () => {
    const u = normalizeUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 300 });
    expect(u.cacheHitTokens).toBe(300);
    expect(u.cacheMissTokens).toBe(700);
  });
});

describe('costUsd 计算（含 cache hit 价）', () => {
  it('按命中/未命中/输出分别计价', () => {
    const price = DEFAULT_PRICE_TABLE['deepseek-chat']!;
    // hit:800 * 0.028/M + miss:200 * 0.14/M + out:200 * 0.28/M
    const expected =
      (800 * 0.028 + 200 * 0.14 + 200 * 0.28) / 1_000_000;
    const cost = computeCostUsd(
      { cacheHitTokens: 800, cacheMissTokens: 200, outputTokens: 200 },
      price,
    );
    expect(cost).toBeCloseTo(expected, 12);
  });

  it('chat() 每次响应都带 costUsd（成本是一等公民）', async () => {
    const client = new DeepSeekClient({
      apiKey: 'k',
      fetch: okFetch(rawWithCache),
    });
    const res = await client.chat(baseRequest);
    expect(res.costUsd).toBeGreaterThan(0);
    const expected =
      (800 * 0.028 + 200 * 0.14 + 200 * 0.28) / 1_000_000;
    expect(res.costUsd).toBeCloseTo(expected, 12);
    expect(res.usage.cacheHitTokens).toBe(800);
    expect(res.message.content).toBe('你好，有什么可以帮你？');
    expect(res.finishReason).toBe('stop');
  });

  it('缺价格表条目时抛错（成本不容静默归零）', async () => {
    const client = new DeepSeekClient({
      apiKey: 'k',
      fetch: okFetch({ ...rawWithCache, model: 'unknown' }),
      priceTable: {},
    });
    await expect(client.chat(baseRequest)).rejects.toThrow(/no price entry/);
  });
});

describe('tool_calls 透传', () => {
  it('响应里的 tool_calls 进入归一化 message', async () => {
    const raw = {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'finish', arguments: '{"x":1}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const client = new DeepSeekClient({ apiKey: 'k', fetch: okFetch(raw) });
    const res = await client.chat(baseRequest);
    expect(res.message.tool_calls).toHaveLength(1);
    expect(res.message.tool_calls?.[0]?.function.name).toBe('finish');
    expect(res.finishReason).toBe('tool_calls');
  });
});

describe('重试策略', () => {
  it('429 瞬时错误重试后成功', async () => {
    let calls = 0;
    const fetch: FetchLike = vi.fn(async () => {
      calls++;
      if (calls < 3) {
        return { ok: false, status: 429, text: async () => 'rate limited' };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(rawWithCache) };
    });
    const client = new DeepSeekClient({
      apiKey: 'k',
      fetch,
      backoff: () => 0,
      sleep: async () => {},
    });
    const res = await client.chat(baseRequest);
    expect(calls).toBe(3);
    expect(res.costUsd).toBeGreaterThan(0);
  });

  it('5xx 瞬时错误也重试', async () => {
    let calls = 0;
    const fetch: FetchLike = vi.fn(async () => {
      calls++;
      if (calls < 2) return { ok: false, status: 503, text: async () => 'unavailable' };
      return { ok: true, status: 200, text: async () => JSON.stringify(rawWithCache) };
    });
    const client = new DeepSeekClient({ apiKey: 'k', fetch, sleep: async () => {} });
    await client.chat(baseRequest);
    expect(calls).toBe(2);
  });

  it('4xx（非 429）不重试，抛类型化 ModelError', async () => {
    let calls = 0;
    const fetch: FetchLike = vi.fn(async () => {
      calls++;
      return { ok: false, status: 400, text: async () => 'bad request' };
    });
    const client = new DeepSeekClient({ apiKey: 'k', fetch, sleep: async () => {} });
    await expect(client.chat(baseRequest)).rejects.toMatchObject({
      code: 'ModelHttpError',
      status: 400,
      transient: false,
    });
    expect(calls).toBe(1);
  });

  it('网络错误重试耗尽后抛 ModelRetryExhausted', async () => {
    let calls = 0;
    const fetch: FetchLike = vi.fn(async () => {
      calls++;
      throw new Error('ECONNRESET');
    });
    const client = new DeepSeekClient({
      apiKey: 'k',
      fetch,
      maxRetries: 2,
      backoff: () => 0,
      sleep: async () => {},
    });
    const err = await client.chat(baseRequest).catch((e) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect(err.code).toBe('ModelRetryExhausted');
    // 1 首次 + 2 重试 = 3 次
    expect(calls).toBe(3);
  });

  it('退避函数被调用、attempt 递增', async () => {
    const backoff = vi.fn((attempt: number) => attempt);
    let calls = 0;
    const fetch: FetchLike = vi.fn(async () => {
      calls++;
      if (calls < 3) return { ok: false, status: 500, text: async () => 'x' };
      return { ok: true, status: 200, text: async () => JSON.stringify(rawWithCache) };
    });
    const client = new DeepSeekClient({
      apiKey: 'k',
      fetch,
      backoff,
      sleep: async () => {},
    });
    await client.chat(baseRequest);
    expect(backoff.mock.calls.map((c) => c[0])).toEqual([1, 2]);
  });
});

describe('请求构造', () => {
  it('注入 fetch 收到正确 url/headers/body，不打真实网络', async () => {
    const fetch = vi.fn<FetchLike>(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(rawWithCache),
    }));
    const client = new DeepSeekClient({
      apiKey: 'secret',
      baseUrl: 'https://example.test',
      fetch,
    });
    await client.chat({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      maxTokens: 100,
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://example.test/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer secret');
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({
      model: 'deepseek-chat',
      temperature: 0.5,
      max_tokens: 100,
      stream: false,
    });
  });

  it('响应缺 choices 抛 ModelResponseInvalid', async () => {
    const client = new DeepSeekClient({ apiKey: 'k', fetch: okFetch({ usage: {} }) });
    await expect(client.chat(baseRequest)).rejects.toMatchObject({
      code: 'ModelResponseInvalid',
    });
  });
});
