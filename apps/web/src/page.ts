/**
 * 单页前端：HTML + CSS + JS 内联为一个字符串常量，由 Worker 直接返回。
 * 无构建链、无外部资源（CSS/JS 全内联，字体用系统栈），符合现有 Worker 风格。
 */

export const PAGE_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Watt · Deep Research Team</title>
<style>
  :root {
    --bg: #0e1116;
    --panel: #161b22;
    --panel-2: #1c232d;
    --border: #2a3340;
    --text: #e6edf3;
    --muted: #8b97a6;
    --accent: #f5a524;
    --accent-2: #4493f8;
    --ok: #3fb950;
    --fail: #f85149;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 980px; margin: 0 auto; padding: 32px 20px 80px; }

  header.hero { padding: 8px 0 24px; border-bottom: 1px solid var(--border); margin-bottom: 28px; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .bolt {
    width: 34px; height: 34px; border-radius: 9px;
    background: linear-gradient(135deg, var(--accent), #e8590c);
    display: grid; place-items: center; font-size: 19px; color: #1a1205;
    box-shadow: 0 0 0 1px rgba(245,165,36,.3), 0 6px 20px -8px rgba(245,165,36,.6);
  }
  .brand h1 { font-size: 19px; margin: 0; letter-spacing: .2px; }
  .brand .sub { color: var(--muted); font-size: 13px; margin-top: 2px; }

  form.ask { display: flex; gap: 10px; margin: 26px 0 6px; flex-wrap: wrap; }
  .ask textarea {
    flex: 1 1 100%; min-height: 70px; resize: vertical;
    background: var(--panel); color: var(--text); border: 1px solid var(--border);
    border-radius: 12px; padding: 14px 16px; font-family: var(--sans); font-size: 15px;
    outline: none; transition: border-color .15s;
  }
  .ask textarea:focus { border-color: var(--accent-2); }
  .controls { display: flex; align-items: center; gap: 14px; flex: 1 1 auto; }
  .controls label { color: var(--muted); font-size: 13px; display: flex; align-items: center; gap: 8px; }
  .controls select {
    background: var(--panel); color: var(--text); border: 1px solid var(--border);
    border-radius: 8px; padding: 7px 10px; font-size: 13px; font-family: var(--sans);
  }
  button.run {
    margin-left: auto; background: var(--accent); color: #1a1205; border: 0;
    border-radius: 10px; padding: 11px 22px; font-weight: 650; font-size: 14px;
    cursor: pointer; transition: transform .08s, filter .15s;
  }
  button.run:hover { filter: brightness(1.06); }
  button.run:active { transform: translateY(1px); }
  button.run:disabled { opacity: .5; cursor: not-allowed; }

  .hint { color: var(--muted); font-size: 12.5px; margin-top: 4px; }
  .examples { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .chip {
    background: var(--panel-2); border: 1px solid var(--border); color: var(--muted);
    border-radius: 999px; padding: 5px 12px; font-size: 12.5px; cursor: pointer;
  }
  .chip:hover { color: var(--text); border-color: var(--accent-2); }

  /* status / progress */
  .status { margin: 24px 0; display: none; }
  .status.show { display: block; }
  .bar {
    height: 4px; background: var(--panel-2); border-radius: 4px; overflow: hidden; position: relative;
  }
  .bar > i {
    position: absolute; inset: 0; width: 40%;
    background: linear-gradient(90deg, transparent, var(--accent-2), transparent);
    animation: slide 1.3s infinite;
  }
  @keyframes slide { 0%{left:-40%} 100%{left:100%} }
  .status .label { color: var(--muted); font-size: 13px; margin-top: 10px; }
  .elapsed { font-variant-numeric: tabular-nums; color: var(--text); }

  /* sections */
  section.card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
    padding: 0; margin: 18px 0; overflow: hidden;
  }
  .card > .head {
    display: flex; align-items: center; gap: 10px; padding: 14px 18px;
    border-bottom: 1px solid var(--border); cursor: pointer; user-select: none;
  }
  .card > .head .ico { font-size: 15px; }
  .card > .head h2 { font-size: 14.5px; margin: 0; font-weight: 620; }
  .card > .head .meta { margin-left: auto; color: var(--muted); font-size: 12.5px; font-family: var(--mono); }
  .card > .body { padding: 16px 18px; }
  .card.collapsed > .body { display: none; }
  .caret { color: var(--muted); transition: transform .15s; }
  .card.collapsed .caret { transform: rotate(-90deg); }

  pre.code {
    background: #0b0e13; border: 1px solid var(--border); border-radius: 10px;
    padding: 14px 16px; overflow-x: auto; font-family: var(--mono); font-size: 12.5px;
    line-height: 1.65; color: #c9d4e0; margin: 0; white-space: pre;
  }
  .rationale { color: var(--muted); font-size: 13.5px; margin: 0 0 14px; }

  .pill { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-family: var(--mono);
    padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); }
  .pill.ok { color: var(--ok); border-color: rgba(63,185,80,.4); }
  .pill.fail { color: var(--fail); border-color: rgba(248,81,73,.4); }

  .flow { display: flex; flex-direction: column; gap: 8px; }
  .call { display: flex; align-items: center; gap: 10px; font-size: 13px;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 9px; padding: 8px 12px; }
  .call .seq { font-family: var(--mono); color: var(--muted); font-size: 11.5px; }
  .call .fn { font-family: var(--mono); color: var(--accent-2); }
  .call .agent { color: var(--text); }
  .call .t { margin-left: auto; color: var(--muted); font-family: var(--mono); font-size: 11.5px; }

  .researcher { border: 1px solid var(--border); border-radius: 11px; margin: 12px 0; overflow: hidden; }
  .researcher .rh { display: flex; align-items: center; gap: 10px; padding: 11px 14px; background: var(--panel-2); }
  .researcher .rh .name { font-weight: 600; font-size: 13.5px; }
  .researcher .rh .stat { margin-left: auto; color: var(--muted); font-size: 12px; font-family: var(--mono); }
  .researcher .rb { padding: 12px 14px; }
  .trace { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  .trace .tr { font-family: var(--mono); font-size: 11px; padding: 3px 8px; border-radius: 6px;
    border: 1px solid var(--border); color: var(--muted); }
  .trace .tr.search { color: var(--accent-2); border-color: rgba(68,147,248,.3); }
  .trace .tr.read { color: #a371f7; border-color: rgba(163,113,247,.3); }
  .trace .tr.bad { color: var(--fail); border-color: rgba(248,81,73,.3); }
  .finding { font-size: 13px; padding: 7px 0; border-top: 1px dashed var(--border); }
  .finding:first-child { border-top: 0; }
  .finding .src a { color: var(--accent-2); font-size: 11.5px; text-decoration: none; font-family: var(--mono); }
  .finding .src a:hover { text-decoration: underline; }
  .summary { color: var(--muted); font-size: 13px; margin: 0 0 10px; }

  /* report markdown */
  .report { font-size: 14.5px; }
  .report h1 { font-size: 21px; margin: 18px 0 12px; }
  .report h2 { font-size: 17px; margin: 22px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
  .report h3 { font-size: 15px; margin: 16px 0 8px; }
  .report p { margin: 10px 0; }
  .report ul, .report ol { padding-left: 22px; margin: 10px 0; }
  .report li { margin: 4px 0; }
  .report a { color: var(--accent-2); }
  .report code { background: var(--panel-2); padding: 1px 6px; border-radius: 5px; font-family: var(--mono); font-size: 12.5px; }
  .report table { border-collapse: collapse; width: 100%; margin: 14px 0; font-size: 13px; display: block; overflow-x: auto; }
  .report th, .report td { border: 1px solid var(--border); padding: 7px 11px; text-align: left; vertical-align: top; }
  .report th { background: var(--panel-2); font-weight: 620; }
  .report blockquote { border-left: 3px solid var(--accent); margin: 12px 0; padding: 2px 14px; color: var(--muted); }

  .takeaways { list-style: none; padding: 0; margin: 0 0 16px; }
  .takeaways li { background: var(--panel-2); border: 1px solid var(--border); border-left: 3px solid var(--accent);
    border-radius: 8px; padding: 10px 14px; margin: 8px 0; font-size: 13.5px; }
  .src-list { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
  .src-list a { color: var(--accent-2); font-size: 12px; font-family: var(--mono); text-decoration: none; word-break: break-all; }

  .usage { display: flex; gap: 18px; flex-wrap: wrap; color: var(--muted); font-size: 12.5px; font-family: var(--mono); margin-top: 6px; }
  .usage b { color: var(--text); font-weight: 600; }
  .errbox { background: rgba(248,81,73,.08); border: 1px solid rgba(248,81,73,.35); color: #ffb4ae;
    border-radius: 10px; padding: 12px 14px; font-size: 13px; }
  .footer { color: var(--muted); font-size: 12px; text-align: center; margin-top: 40px; }
  .footer code { font-family: var(--mono); }
</style>
</head>
<body>
<div class="wrap">
  <header class="hero">
    <div class="brand">
      <div class="bolt">⚡</div>
      <div>
        <h1>Watt · Deep Research Team</h1>
        <div class="sub">Manager 生成 PlanScript → QuickJS 沙箱执行 → 子 Agent 并行调研 → 汇总</div>
      </div>
    </div>
  </header>

  <form class="ask" id="askForm">
    <textarea id="q" placeholder="输入一个研究问题，例如：对比 LangGraph、CrewAI、AutoGen 三个 AI agent 编排框架的设计取舍与适用场景"></textarea>
    <div class="controls">
      <label>子 Agent 数
        <select id="n">
          <option value="2">2</option>
          <option value="3" selected>3</option>
          <option value="4">4</option>
        </select>
      </label>
      <button class="run" id="runBtn" type="submit">开始调研</button>
    </div>
  </form>
  <div class="hint">调研需 1–3 分钟（真实搜索 + 多个子 Agent 并行 + 汇总），请耐心等待。</div>
  <div class="examples" id="examples">
    <span class="chip">对比 LangGraph、CrewAI、AutoGen 的设计取舍与适用场景</span>
    <span class="chip">DeepSeek 最新模型矩阵、定价与 API 特性</span>
    <span class="chip">2026 年 serverless 数据库选型对比</span>
  </div>

  <div class="status" id="status">
    <div class="bar"><i></i></div>
    <div class="label"><span id="statusText">正在调研…</span> · 已用时 <span class="elapsed" id="elapsed">0</span>s</div>
  </div>

  <div id="result"></div>

  <div class="footer">Watt · 所有调研由部署在 Cloudflare Workers 上的 <code>research-team</code> 完成 · DeepSeek + Tavily</div>
</div>

<script>
const $ = (s) => document.querySelector(s);
const form = $('#askForm'), q = $('#q'), n = $('#n'), runBtn = $('#runBtn');
const statusEl = $('#status'), statusText = $('#statusText'), elapsedEl = $('#elapsed'), resultEl = $('#result');

$('#examples').addEventListener('click', (e) => {
  if (e.target.classList.contains('chip')) { q.value = e.target.textContent; q.focus(); }
});

let timer = null;
function startTimer() {
  const t0 = Date.now();
  elapsedEl.textContent = '0';
  timer = setInterval(() => { elapsedEl.textContent = Math.round((Date.now() - t0) / 1000); }, 250);
}
function stopTimer() { if (timer) clearInterval(timer); timer = null; }

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const question = q.value.trim();
  if (!question) { q.focus(); return; }
  const subagents = parseInt(n.value, 10);

  runBtn.disabled = true;
  resultEl.innerHTML = '';
  statusEl.classList.add('show');
  statusText.textContent = '正在调研（Manager 生成 PlanScript → 子 Agent 并行调研 → 汇总）…';
  startTimer();

  try {
    const RESEARCH_URL = '__RESEARCH_TEAM_URL__';
    const res = await fetch(RESEARCH_URL + '/v1/research', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, subagents }),
    });
    const data = await res.json();
    stopTimer();
    statusEl.classList.remove('show');
    if (!res.ok || data.error) {
      renderError(data);
    } else {
      renderResult(data);
    }
  } catch (err) {
    stopTimer();
    statusEl.classList.remove('show');
    renderError({ error: 'network', message: String(err && err.message || err) });
  } finally {
    runBtn.disabled = false;
  }
});

function renderError(data) {
  resultEl.innerHTML = '<div class="errbox"><b>调研失败：</b>' + esc(data.error || 'error') + ' — ' + esc(data.message || JSON.stringify(data)) + '</div>';
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function card(icon, title, meta, bodyNode, collapsed) {
  const c = el('section', 'card' + (collapsed ? ' collapsed' : ''));
  const head = el('div', 'head');
  head.innerHTML = '<span class="ico">' + icon + '</span><h2>' + esc(title) + '</h2><span class="meta">' + (meta || '') + '</span><span class="caret">▾</span>';
  head.addEventListener('click', () => c.classList.toggle('collapsed'));
  c.appendChild(head);
  const body = el('div', 'body');
  body.appendChild(bodyNode);
  c.appendChild(body);
  return c;
}

function renderResult(d) {
  resultEl.innerHTML = '';
  const m = d.manager || {}, ex = d.execution || {}, rr = d.roleReports || [], rep = d.report, u = d.usage || {};

  // 1) 最终报告（放最上面，最重要）
  if (rep && typeof rep === 'object' && (rep.report || (rep.keyTakeaways||[]).length)) {
    const body = el('div', 'report');
    if (rep.title) body.appendChild(el('h1', null, esc(rep.title)));
    if ((rep.keyTakeaways || []).length) {
      body.appendChild(el('h2', null, '核心结论'));
      const ul = el('ul', 'takeaways');
      rep.keyTakeaways.forEach((t) => ul.appendChild(el('li', null, esc(t))));
      body.appendChild(ul);
    }
    if (rep.report) {
      const md = el('div', null, renderMarkdown(rep.report));
      body.appendChild(md);
    }
    if ((rep.sources || []).length) {
      body.appendChild(el('h2', null, '来源'));
      const sl = el('div', 'src-list');
      rep.sources.forEach((s) => {
        const a = el('a'); a.href = s; a.target = '_blank'; a.rel = 'noopener'; a.textContent = s;
        sl.appendChild(a);
      });
      body.appendChild(sl);
    }
    resultEl.appendChild(card('📄', '研究报告', '', body, false));
  }

  // 2) 各 subagent 调研轨迹
  if (rr.length) {
    const body = el('div');
    rr.forEach((r) => body.appendChild(renderRole(r)));
    const okc = rr.filter((r) => r.status === 'ok').length;
    resultEl.appendChild(card('🔎', '子 Agent 调研轨迹', okc + '/' + rr.length + ' 成功', body, false));
  }

  // 3) Manager 生成的 PlanScript
  if (m.planScript) {
    const body = el('div');
    if (m.rationale) body.appendChild(el('p', 'rationale', '<b style="color:var(--text)">编排思路：</b>' + esc(m.rationale)));
    const validPill = m.scriptValid
      ? '<span class="pill ok">✓ 静态校验通过</span>'
      : '<span class="pill fail">✗ 校验失败</span>';
    body.appendChild(el('div', null, validPill + '<span style="color:var(--muted);font-size:12px;margin-left:10px">由 Manager（模型）生成，确定性沙箱执行</span>'));
    const pre = el('pre', 'code'); pre.textContent = m.planScript;
    body.appendChild(pre);
    resultEl.appendChild(card('🧠', 'Manager 生成的 PlanScript', '', body, false));
  }

  // 4) 脚本驱动的 host 调用编排
  if ((ex.hostCalls || []).length) {
    const body = el('div', 'flow');
    ex.hostCalls.forEach((c) => {
      const row = el('div', 'call');
      row.innerHTML =
        '<span class="seq">seq ' + c.seq + '</span>' +
        '<span class="fn">host.' + esc(c.fn) + '</span>' +
        (c.agent ? '<span class="agent">' + esc(c.agent) + '</span>' : '') +
        '<span class="pill ' + (c.status === 'ok' ? 'ok' : 'fail') + '">' + c.status + '</span>' +
        '<span class="t">' + Math.round((c.ms||0)/1000) + 's</span>';
      body.appendChild(row);
    });
    const meta = (ex.status || '') + ' · ' + (ex.rounds || 0) + ' 轮';
    resultEl.appendChild(card('🧩', '脚本驱动的编排（host.run 派发）', meta, body, true));
  }

  // usage
  if (u.totalCostUsd !== undefined) {
    const usage = el('div', 'usage',
      '总成本 <b>$' + (u.totalCostUsd || 0) + '</b>' +
      ' · 总耗时 <b>' + Math.round((u.totalMs||0)/1000) + 's</b>' +
      (u.breakdown ? ' · Manager $' + (u.breakdown.manager||0).toFixed(5) + ' · 执行 $' + (u.breakdown.execution||0).toFixed(5) : ''));
    resultEl.appendChild(usage);
  }
}

function renderRole(r) {
  const box = el('div', 'researcher');
  const rh = el('div', 'rh');
  const reads = (r.trace || []).filter((t) => t.action === 'read' && t.ok).length;
  const srch = (r.trace || []).filter((t) => t.action === 'search' && t.ok).length;
  rh.innerHTML =
    '<span class="name">' + esc(r.agent || r.role) + '</span>' +
    '<span class="pill ' + (r.status === 'ok' ? 'ok' : 'fail') + '">' + r.status + '</span>' +
    '<span class="stat">搜' + srch + ' · 读' + reads + ' · $' + (r.costUsd||0).toFixed(5) + '</span>';
  box.appendChild(rh);
  const rb = el('div', 'rb');

  if ((r.trace || []).length) {
    const tr = el('div', 'trace');
    r.trace.forEach((t) => {
      const cls = 'tr ' + (t.ok ? (t.action || '') : 'bad');
      const label = (t.action === 'read')
        ? ('read ' + shortUrl(t.target))
        : (t.action + ' "' + (t.target||'').slice(0, 28) + '"');
      const span = el('span', cls); span.textContent = label;
      tr.appendChild(span);
    });
    rb.appendChild(tr);
  }

  const out = r.output;
  if (out && typeof out === 'object') {
    if (out.summary) rb.appendChild(el('p', 'summary', esc(out.summary)));
    (out.findings || []).slice(0, 8).forEach((f) => {
      const fd = el('div', 'finding');
      fd.innerHTML = esc(f.point || '');
      if (f.source) fd.appendChild(el('div', 'src', '<a href="' + esc(f.source) + '" target="_blank" rel="noopener">' + shortUrl(f.source) + '</a>'));
      rb.appendChild(fd);
    });
  } else if (r.error) {
    rb.appendChild(el('div', 'errbox', esc(r.error.code) + ': ' + esc(r.error.message || '')));
  }
  box.appendChild(rb);
  return box;
}

function shortUrl(u) {
  try { const x = new URL(u); return x.hostname.replace(/^www\./, '') + (x.pathname.length > 1 ? x.pathname.slice(0, 24) : ''); }
  catch { return (u || '').slice(0, 40); }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/* —— 极简 markdown 渲染（够用即可：标题/列表/表格/粗体/链接/代码/引用）—— */
function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  let html = '', i = 0;
  const BT = String.fromCharCode(96); // 反引号，避免与外层 String.raw 模板冲突
  const codeRe = new RegExp(BT + '([^' + BT + ']+)' + BT, 'g');
  const inline = (t) => esc(t)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*(?!\*)([^*]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(codeRe, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  while (i < lines.length) {
    let line = lines[i];

    // 表格
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i+1])) {
      const header = splitRow(line);
      i += 2;
      let rows = '';
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = splitRow(lines[i]);
        rows += '<tr>' + cells.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>';
        i++;
      }
      html += '<table><thead><tr>' + header.map((h) => '<th>' + inline(h) + '</th>').join('') + '</tr></thead><tbody>' + rows + '</tbody></table>';
      continue;
    }
    // 标题
    let mh = /^(#{1,6})\s+(.*)$/.exec(line);
    if (mh) { const lv = mh[1].length; html += '<h' + lv + '>' + inline(mh[2]) + '</h' + lv + '>'; i++; continue; }
    // 引用
    if (/^>\s?/.test(line)) {
      let buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      html += '<blockquote>' + inline(buf.join(' ')) + '</blockquote>';
      continue;
    }
    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      let buf = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
      html += '<ul>' + buf.map((b) => '<li>' + inline(b) + '</li>').join('') + '</ul>';
      continue;
    }
    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      let buf = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
      html += '<ol>' + buf.map((b) => '<li>' + inline(b) + '</li>').join('') + '</ol>';
      continue;
    }
    // 分隔线
    if (/^\s*---+\s*$/.test(line)) { html += '<hr style="border:0;border-top:1px solid var(--border);margin:14px 0">'; i++; continue; }
    // 空行
    if (/^\s*$/.test(line)) { i++; continue; }
    // 段落（合并连续非空行）
    let buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i]) && !/^\s*[-*+]\s/.test(lines[i]) && !/^\s*\d+\.\s/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    html += '<p>' + inline(buf.join(' ')) + '</p>';
  }
  return html;
}
function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}
</script>
</body>
</html>`;
