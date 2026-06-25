/**
 * Watt Web UI —— deep research team 的单页前端（无构建链）。
 *
 * 形态：一个 Worker，GET / 返回内联 HTML+CSS+JS 的单页；前端 POST /api/research，
 * 由本 Worker 服务端代理转发到 research-team Worker（避免 CORS、隐藏上游）。页面把
 * research-team 的结构化返回渲染成四块：Manager 生成的 PlanScript、脚本驱动的 host
 * 调用编排、各 subagent 的调研轨迹与发现、最终 markdown 报告。
 *
 * 设计取舍：研究一次要 1-3 分钟，前端用一个长 fetch + loading 态等待（V1 不做流式/
 * SSE；research-team 本身也是同步请求-响应）。
 */

import { PAGE_HTML } from './page.js';

interface Env {
  /** research-team Worker 的公网 URL（vars）。 */
  RESEARCH_TEAM_URL: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/') {
      // 把 research-team URL 注入页面：浏览器直连它（research 一次 1-3 分钟，超过
      // Worker 间 fetch 子请求时限，不能经本 Worker 代理）。research-team 已配 CORS。
      const upstream = (env.RESEARCH_TEAM_URL ?? '').replace(/\/$/, '');
      const html = PAGE_HTML.replace('__RESEARCH_TEAM_URL__', upstream);
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/research') {
      // 兼容保留：仍可经 Worker 代理（但 research 耗时长会撞子请求时限，前端默认走
      // 浏览器直连 research-team）。
      return proxyResearch(req, env);
    }

    return new Response('not found', { status: 404 });
  },
};

/** 服务端代理：把前端请求原样转发到 research-team，回传其 JSON。 */
async function proxyResearch(req: Request, env: Env): Promise<Response> {
  const upstream = (env.RESEARCH_TEAM_URL ?? '').replace(/\/$/, '');
  if (!upstream) {
    return json({ error: 'misconfigured', message: 'RESEARCH_TEAM_URL 未配置' }, 500);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_json', message: '请求体不是合法 JSON' }, 400);
  }

  try {
    const res = await fetch(`${upstream}/v1/research`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  } catch (err) {
    return json(
      { error: 'upstream_error', message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
