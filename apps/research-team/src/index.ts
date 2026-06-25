/**
 * Watt Deep Research Team —— Manager 生成 PlanScript + 确定性 Script Runner 执行。
 *
 * 这是 docs 架构「决策 1/2」的落地：
 *
 *   question
 *     -> Manager(模型) 生成 PlanScript（host.run 编排数据资产）
 *     -> Script Runner(确定性 driver) 在 QuickJS 沙箱重放执行脚本
 *        -> 脚本里的 host.run 派发 researcher（带 Tavily 工具）/ synthesizer
 *     -> 脚本完成值即最终报告
 *
 * 与早期版本的关键区别：编排逻辑不再硬编码在本 Worker 的 TS 里，而是由 Manager 生成的
 * PlanScript 决定（开几路、依赖、汇总）。Manager 真正在「编排」。模型调用全部发生在沙箱
 * 之外的宿主请求上下文（符合决策 4，不占用 DO）。
 */

import { DeepSeekClient } from '@watt/model-deepseek';
import { runManager } from './manager.js';
import { runPlanScript } from './driver.js';

interface Env {
  DEEPSEEK_API_KEY: string;
  DEEPSEEK_BASE_URL?: string;
  MODEL_ID?: string;
  TAVILY_API_KEY: string;
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // CORS 预检：允许浏览器从 web UI 直连本端点（research 一次 1-3 分钟，超过 Worker
    // 间 fetch 子请求时限，故让浏览器直连而非经 web Worker 代理）。
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return json({
        name: 'watt-research-team',
        ok: true,
        model: env.MODEL_ID ?? 'deepseek/deepseek-chat',
        orchestration: 'Manager 生成 PlanScript → QuickJS 沙箱重放 → host.run 派发子 Agent',
        data_source: 'tavily search + extract (api key)',
        endpoints: {
          'POST /v1/research':
            'body { question, subagents? (2-4, 默认 3) } → Manager 编排→脚本执行→汇总，返回 plan/脚本/各阶段明细/报告',
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/research') {
      try {
        return await handleResearch(req, env);
      } catch (err) {
        return json(
          {
            error: 'worker_exception',
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? (err.stack ?? '').split('\n').slice(0, 8) : undefined,
          },
          500,
        );
      }
    }

    return json({ error: 'not_found', path: url.pathname }, 404);
  },
};

interface ResearchBody {
  question?: string;
  subagents?: number;
}

async function handleResearch(req: Request, env: Env): Promise<Response> {
  if (!env.DEEPSEEK_API_KEY) return json({ error: 'missing_secret', message: 'DEEPSEEK_API_KEY 未配置' }, 500);
  if (!env.TAVILY_API_KEY) return json({ error: 'missing_secret', message: 'TAVILY_API_KEY 未配置' }, 500);

  let body: ResearchBody;
  try {
    body = (await req.json()) as ResearchBody;
  } catch {
    return json({ error: 'bad_json', message: '请求体不是合法 JSON' }, 400);
  }
  const question = body.question?.trim();
  if (!question) return json({ error: 'missing_field', message: 'question 必填' }, 400);
  const subagents = clampInt(body.subagents, 3, 2, 4);

  const model = new DeepSeekClient({
    apiKey: env.DEEPSEEK_API_KEY,
    baseUrl: env.DEEPSEEK_BASE_URL,
    maxRetries: 2,
  });

  const startedAt = Date.now();

  // 1) Manager 生成 PlanScript（真正的编排在这里——由模型决定脚本结构）。
  const manager = await runManager(model, question, { subagents });
  if (manager.status !== 'ok' || !manager.planScript) {
    return json(
      { question, stage: 'manager', error: 'manager_failed', manager },
      502,
    );
  }

  // 2) Script Runner 确定性执行 PlanScript：沙箱重放 + host.run 派发子 Agent。
  const driven = await runPlanScript({
    source: manager.planScript,
    model,
    tavilyKey: env.TAVILY_API_KEY,
    question,
    maxPlanCostUsd: 0.5,
  });

  const totalMs = Date.now() - startedAt;
  const totalCostUsd = manager.costUsd + driven.totalCostUsd;

  return json({
    question,
    subagents,
    // 第 1 阶段：Manager 编排（生成的脚本 + 思路 + 校验结果）
    manager: {
      status: manager.status,
      rationale: manager.rationale,
      planScript: manager.planScript,
      scriptValid: manager.scriptValid,
      scriptErrors: manager.scriptErrors,
      costUsd: manager.costUsd,
      turns: manager.turns,
      ms: manager.ms,
    },
    // 第 2 阶段：Script Runner 执行（脚本驱动的 host 调用编排）
    execution: {
      status: driven.status,
      rounds: driven.rounds,
      error: driven.error,
      hostCalls: driven.hostCalls,
    },
    // 第 2 阶段细节：每个 role agent 的运行（researcher 调研轨迹在此）
    roleReports: driven.roleReports.map((r) => ({
      agent: r.agent,
      role: r.role,
      status: r.status,
      trace: r.trace,
      output: r.output,
      error: r.error,
      costUsd: r.costUsd,
      turns: r.turns,
      ms: r.ms,
    })),
    // 第 3 阶段：脚本完成值（通常是 synthesizer 的最终报告）
    report: driven.value,
    usage: {
      totalCostUsd: Number(totalCostUsd.toFixed(6)),
      totalMs,
      breakdown: { manager: manager.costUsd, execution: driven.totalCostUsd },
    },
  });
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : dflt;
  return Math.max(min, Math.min(max, n));
}
