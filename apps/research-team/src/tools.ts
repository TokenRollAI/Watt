/**
 * Web 调研工具：web_search + web_read，给 researcher subagent 使用。
 *
 * 后端：Tavily（https://tavily.com）——专为 LLM agent 设计的搜索/抽取 API，
 * 靠 API key 鉴权而非 IP，故对 Cloudflare Workers 数据中心出口稳定（不像
 * DuckDuckGo / r.jina.ai 无 key 抓取会按数据中心 IP 限流 202/429）。
 *
 * - web_search → POST /search：一次调用返回排序结果（title/url + 为 LLM
 *   清洗过的 content 摘要），可选 include_answer 给一句直答。
 * - web_read → POST /extract：抽取指定 URL 的正文（raw_content，截断）。
 *
 * 关键约束：execute 绝不抛异常——runtime-core 的 turn loop 不对工具 execute 做
 * try/catch，抛出会让整个 AgentRun 失败。所有错误都收敛成 { output:{ error } }。
 * 每次调用写入注入的 trace 数组，用于事后观察每个 subagent 的调研轨迹。
 */

import type { Tool } from '@watt/runtime-core';

export interface TraceEntry {
  action: 'search' | 'read';
  target: string;
  ok: boolean;
  ms: number;
  note?: string;
}

const TAVILY_SEARCH = 'https://api.tavily.com/search';
const TAVILY_EXTRACT = 'https://api.tavily.com/extract';
const READ_CHAR_LIMIT = 7000;
const SEARCH_RESULT_LIMIT = 6;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface PostResult {
  ok: boolean;
  status: number;
  data: unknown;
  error?: string;
}

/** POST JSON 到 Tavily，带瞬时错误（429/5xx/网络）退避重试。 */
async function postJson(url: string, body: unknown, retries = 2): Promise<PostResult> {
  let lastError = 'unknown';
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(500 * attempt);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (res.ok) {
        try {
          return { ok: true, status: res.status, data: JSON.parse(text) };
        } catch {
          return { ok: false, status: res.status, data: null, error: 'invalid json' };
        }
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = `http ${res.status}`;
        continue;
      }
      return { ok: false, status: res.status, data: null, error: `http ${res.status}: ${text.slice(0, 160)}` };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, status: 0, data: null, error: lastError };
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface TavilySearchResponse {
  answer?: string;
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

interface TavilyExtractResponse {
  results?: Array<{ url?: string; raw_content?: string }>;
}

/**
 * 构造 web 工具（web_search + web_read），共享一个 trace 数组。
 * apiKey 由调用方从 Worker secret 注入。
 */
export function makeWebTools(apiKey: string, trace: TraceEntry[]): Tool[] {
  // 工具层软约束：限制搜索次数，逼模型读够信息后转向 finish，避免「反复换词
  // 检索从不收敛」耗尽 maxToolCalls 而失败（这是丢弃已得成果的主因）。
  let searchCount = 0;
  const MAX_SEARCHES = 4;
  let readCount = 0;
  const MAX_READS = 5;

  const webSearch: Tool = {
    name: 'web_search',
    description:
      '用搜索引擎检索网页（Tavily）。参数 query 用英文检索式效果更好。返回 title/url + 为 LLM 清洗过的 content 摘要列表；通常摘要已足够，必要时再用 web_read 精读某个 URL。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索检索式（建议英文）' } },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(args) {
      const query = String(args.query ?? '').trim();
      if (!query) return { output: { error: 'query 不能为空' } };
      if (searchCount >= MAX_SEARCHES) {
        trace.push({ action: 'search', target: query, ok: false, ms: 0, note: `搜索已达上限 ${MAX_SEARCHES}` });
        return {
          output: {
            error: `已达搜索次数上限（${MAX_SEARCHES} 次）。请基于已检索到的信息，用 web_read 精读最相关的 1-2 个 URL（如果还没读），然后立即调用 finish 提交结果。`,
          },
        };
      }
      searchCount += 1;
      const started = Date.now();
      const res = await postJson(TAVILY_SEARCH, {
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: SEARCH_RESULT_LIMIT,
        include_answer: true,
      });
      const ms = Date.now() - started;
      if (!res.ok) {
        trace.push({ action: 'search', target: query, ok: false, ms, note: res.error });
        return { output: { error: `搜索失败：${res.error}` } };
      }
      const data = res.data as TavilySearchResponse;
      const results: SearchResult[] = (data.results ?? [])
        .filter((r) => r.url)
        .map((r) => ({
          title: (r.title ?? '').trim(),
          url: r.url ?? '',
          snippet: (r.content ?? '').slice(0, 600),
        }))
        .slice(0, SEARCH_RESULT_LIMIT);
      const ok = results.length > 0;
      trace.push({ action: 'search', target: query, ok, ms, note: `${results.length} 条 via tavily` });
      if (!ok) return { output: { query, results: [], note: '无结果，请换检索式' } };
      return { output: { query, answer: data.answer ?? undefined, results } };
    },
  };

  const webRead: Tool = {
    name: 'web_read',
    description:
      '抽取并阅读一个网页 URL 的正文（Tavily extract，截断）。当 web_search 的摘要不够、需要某页完整正文时使用。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要阅读的完整 http(s) URL' } },
      required: ['url'],
      additionalProperties: false,
    },
    async execute(args) {
      const target = String(args.url ?? '').trim();
      if (!/^https?:\/\//.test(target)) return { output: { error: 'url 必须是 http(s) 链接' } };
      if (readCount >= MAX_READS) {
        trace.push({ action: 'read', target, ok: false, ms: 0, note: `精读已达上限 ${MAX_READS}` });
        return {
          output: {
            error: `已达精读次数上限（${MAX_READS} 次）。请基于已读到的内容立即调用 finish 提交结果。`,
          },
        };
      }
      readCount += 1;
      const started = Date.now();
      const res = await postJson(TAVILY_EXTRACT, { api_key: apiKey, urls: [target] });
      const ms = Date.now() - started;
      if (!res.ok) {
        trace.push({ action: 'read', target, ok: false, ms, note: res.error });
        return { output: { error: `抓取失败：${res.error}` } };
      }
      const data = res.data as TavilyExtractResponse;
      const raw = data.results?.[0]?.raw_content ?? '';
      if (!raw) {
        trace.push({ action: 'read', target, ok: false, ms, note: '空正文' });
        return { output: { error: '该 URL 未能抽取到正文，换一个来源' } };
      }
      const truncated = raw.length > READ_CHAR_LIMIT;
      trace.push({ action: 'read', target, ok: true, ms, note: `${raw.length}字` });
      return { output: { url: target, content: raw.slice(0, READ_CHAR_LIMIT), truncated } };
    },
  };

  return [webSearch, webRead];
}
