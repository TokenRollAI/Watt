/**
 * Role Agent 执行：把 PlanScript 里的 host.run(agent, ctx) 路由到具体角色的 runAgent。
 *
 * 角色由 agent 名前缀决定（Manager 在 PlanScript 里用这些名字派发）：
 * - "researcher..." → 调研员：带 Tavily web_search/web_read 工具，产结构化发现。
 * - "synthesizer..." / "synth..." → 汇总者：无工具，综合各发现写报告。
 * - 其它名字 → 通用 agent：无工具，按 ctx.objective 直接作答。
 *
 * ctx 已由 PlanScript 提供并经 protocol 的 ContextPackage schema 校验（在 host-bridge
 * 归一化时完成）；这里只补角色相关的 instructions / outputSchema / 工具授权。
 */

import type { ModelClient } from '@watt/model-deepseek';
import type { AgentSpec, ContextPackage, RunEvent } from '@watt/protocol';
import { runAgent } from '@watt/runtime-core';
import { makeWebTools, type TraceEntry } from './tools.js';

const MODEL_ID = 'deepseek/deepseek-chat';

export interface RoleRunReport {
  agent: string;
  role: 'researcher' | 'synthesizer' | 'generic';
  status: 'ok' | 'failed';
  output?: unknown;
  error?: { code: string; message: string };
  costUsd: number;
  turns: number;
  ms: number;
  /** researcher 的工具调用轨迹（其它角色为空）。 */
  trace: TraceEntry[];
}

const RESEARCHER_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '该子方向的调研小结（中文）' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          point: { type: 'string', description: '一条有依据的发现' },
          source: { type: 'string', description: '支撑该发现的来源 URL' },
        },
        required: ['point'],
        additionalProperties: false,
      },
    },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'findings'],
  additionalProperties: false,
};

const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    report: { type: 'string', description: 'markdown 格式的完整研究报告' },
    keyTakeaways: { type: 'array', items: { type: 'string' } },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['report', 'keyTakeaways'],
  additionalProperties: false,
};

const GENERIC_SCHEMA = {
  type: 'object',
  properties: { reply: { type: 'string' } },
  required: ['reply'],
  additionalProperties: false,
};

function classify(agent: string): RoleRunReport['role'] {
  const a = agent.toLowerCase();
  if (a.includes('synth')) return 'synthesizer';
  if (a.includes('research')) return 'researcher';
  return 'generic';
}

/**
 * 角色相关的预算地板：对 Manager 在 PlanScript 里给的预算取「不低于安全下限」。
 * synthesizer 写长报告需足够墙钟；researcher 需足够工具次数与墙钟。只放大、不缩小
 * （取 max），避免 Manager 给紧了导致中途失败丢成果。
 */
function floorBudget(
  role: RoleRunReport['role'],
  b: ContextPackage['budget'],
): ContextPackage['budget'] {
  if (role === 'synthesizer') {
    return {
      maxCostUsd: Math.max(b.maxCostUsd, 0.2),
      maxWallClockMs: Math.max(b.maxWallClockMs, 230_000),
      maxToolCalls: Math.max(b.maxToolCalls, 1),
    };
  }
  if (role === 'researcher') {
    return {
      maxCostUsd: Math.max(b.maxCostUsd, 0.06),
      maxWallClockMs: Math.max(b.maxWallClockMs, 110_000),
      // 工具层软上限 search≤4 + read≤5 = 最多 9 次有效调用；硬上限留足余量到 14，
      // 让模型在「达软上限被提示去 finish」后仍有预算真正提交，不致踩 maxToolCalls。
      maxToolCalls: Math.max(b.maxToolCalls, 14),
    };
  }
  return b;
}

export interface RunRoleParams {
  agent: string;
  ctx: ContextPackage;
  model: ModelClient;
  tavilyKey: string;
}

export async function runRoleAgent(params: RunRoleParams): Promise<RoleRunReport> {
  const { agent, model, tavilyKey } = params;
  const role = classify(agent);

  // 预算地板保护：Manager 在 PlanScript 里可能把预算给得过紧导致子 Agent 中途失败、
  // 丢弃已得成果。driver 侧对关键预算项设下限（取 Manager 值与地板的较大者），确保
  // 角色能跑完。这不违反「预算由确定性代码兜底」——这里只放宽到安全下限，上限仍受
  // maxPlanCostUsd 的全局兜底约束。
  const ctx: ContextPackage = {
    ...params.ctx,
    budget: floorBudget(role, params.ctx.budget),
  };

  let spec: AgentSpec;
  if (role === 'researcher') {
    spec = {
      instructions:
        '你是 deep research 团队的调研员，负责一个子方向。先用 web_search 检索（1-2 次足够），' +
        'web_search 返回的 content 摘要通常已够用；若某页需完整正文再用 web_read。读够信息后立即调用 finish 提交，' +
        '不要反复检索。每条发现尽量给出来源 URL；不要编造来源或事实。',
      outputSchema: RESEARCHER_SCHEMA,
      tools: [{ tool: 'web_search' }, { tool: 'web_read' }],
      model: { id: MODEL_ID, temperature: 0.3 },
      runtime: 'worker',
      lifecycle: 'ephemeral',
    };
  } else if (role === 'synthesizer') {
    spec = {
      instructions:
        '你是 deep research 团队的总编辑。综合各子方向调研员的发现，写一份结构化、有依据的研究报告。' +
        '结论必须基于所给材料，不要引入材料里没有的事实；对冲突信息要点明分歧；保留关键来源链接。报告用中文 markdown。' +
        '一次性调用 finish 提交结果，report 控制在 2000 字以内、聚焦核心对比，不要冗长。',
      outputSchema: SYNTH_SCHEMA,
      tools: [],
      model: { id: MODEL_ID, temperature: 0.4, maxTokens: 8000 },
      runtime: 'worker',
      lifecycle: 'ephemeral',
    };
  } else {
    spec = {
      instructions: '你是一个通用助理 Agent，请简洁准确地完成 objective。',
      outputSchema: GENERIC_SCHEMA,
      tools: [],
      model: { id: MODEL_ID, temperature: 0.5 },
      runtime: 'worker',
      lifecycle: 'ephemeral',
    };
  }

  const trace: TraceEntry[] = [];
  const events: RunEvent[] = [];
  const started = Date.now();
  const outcome = await runAgent({
    spec,
    ctx,
    model,
    tools: spec.tools.length ? makeWebTools(tavilyKey, trace) : [],
    emitter: { emit: (e) => void events.push(e) },
    ids: { workspaceId: 'ws_research', runId: `run_${role}`, now: () => Date.now() },
  });

  return {
    agent,
    role,
    status: outcome.status,
    output: outcome.output,
    error: outcome.error,
    costUsd: outcome.costUsd,
    turns: outcome.turns,
    ms: Date.now() - started,
    trace,
  };
}
