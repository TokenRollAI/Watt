/**
 * Manager Agent —— 真正的编排者：用 runAgent 生成一段 PlanScript（JS 数据资产），
 * 而非自己执行动作。生成的脚本由 Script Runner（driver.ts）在 QuickJS 沙箱中确定性
 * 执行，脚本内通过 host.run 派发 researcher / synthesizer 子 Agent。
 *
 * 这是「模型负责计划、确定性代码负责调度」的落地：Manager（模型）产出 PlanScript，
 * driver（确定性代码）执行它。Manager 决定开几路调研、各路目标、以及如何把结果汇总
 * ——编排逻辑由模型生成，不再硬编码在 TS 里。
 *
 * 输出契约：Manager 经注入的 finish 工具提交 { planScript }（一段 JS 源码字符串），
 * 我们随后用 @watt/plan-script 静态校验它；不合法则要求 Manager 重写（这里通过把
 * 校验交给 driver 的 replay 完成——validation_failed 会被 driver 捕获并回报）。
 */

import type { ModelClient } from '@watt/model-deepseek';
import type { AgentSpec, ContextPackage } from '@watt/protocol';
import { runAgent } from '@watt/runtime-core';
import { validatePlanScript } from '@watt/plan-script';

const MODEL_ID = 'deepseek/deepseek-chat';

const MANAGER_SCHEMA = {
  type: 'object',
  properties: {
    planScript: {
      type: 'string',
      description: '一段 PlanScript（JavaScript 源码），用 host.run 编排 researcher 与 synthesizer',
    },
    rationale: { type: 'string', description: '简述你的编排思路（开几路、如何汇总）' },
  },
  required: ['planScript'],
  additionalProperties: false,
};

/**
 * PlanScript 写作规范（进入 Manager 的 system prompt）。给足约束与可直接照搬的范式，
 * 让模型产出能通过 plan-script 静态校验的脚本。
 */
const PLANSCRIPT_GUIDE = `
你的产物是一段 **PlanScript**：运行在确定性沙箱里的 JavaScript 源码，用来编排一支 deep research 小队。

## 沙箱能力（严格遵守，违反会导致脚本被拒）
- 脚本是一段 async 函数体：可直接用 \`await\`、\`return\`，以及 \`Promise.all\`。
- 唯一的外部能力是 Host 函数 \`run(agent, ctx)\`：派发一个子 Agent 执行一段工作，返回一个对象 \`{ status, output, costUsd, error }\`。
  - \`status\` 的取值**只有两个**：\`"ok"\`（成功，此时 output 有效）或 \`"failed"\`（失败，此时 error 有效）。判断成功**必须**用 \`r.status === "ok"\`，绝不要用 "success" 等其它字面量。
  - \`output\` 是子 Agent 的结构化结果（researcher 的 output 含 summary/findings/sources；synthesizer 的 output 含 report/keyTakeaways/sources）。
- **禁止**：import/require、fetch、Date、Math.random、setTimeout、任何网络或时间或随机 API。只能用纯 JS（Array/Object/JSON/Promise 等）和 run()。
- 不要自己写调研逻辑或编造数据——调研由子 Agent 完成，你只负责编排。

## 子 Agent（用 agent 名区分角色）
- 名字含 "researcher" → 调研员：会用搜索工具调研一个子方向，返回 { output: { summary, findings:[{point,source}], sources } }。
- 名字含 "synthesizer" → 汇总者：综合各调研结果写报告，返回 { output: { report, keyTakeaways, sources } }。

## ctx 的形状（每次 run 必须提供，且字段完整，否则脚本会被拒）
\`\`\`
{
  objective: "这个子 Agent 要完成什么（自然语言）",
  inputs: [],
  budget: { maxCostUsd: 0.05, maxWallClockMs: 110000, maxToolCalls: 12 },
  expectedOutput: "对输出的补充说明",
  permissions: { contextScope: [], toolScope: ["web_search","web_read"] }
}
\`\`\`
预算建议（很重要，给紧了会导致子 Agent 中途失败、丢弃成果）：
- researcher 的 ctx：\`budget: { maxCostUsd: 0.06, maxWallClockMs: 110000, maxToolCalls: 12 }\`，permissions.toolScope 必须含 ["web_search","web_read"]。
- synthesizer 的 ctx：要综合多路材料并写长报告，**必须给足墙钟**：\`budget: { maxCostUsd: 0.15, maxWallClockMs: 150000, maxToolCalls: 1 }\`，permissions 用 \`{ contextScope: [] }\`（不需要工具）。

## 推荐范式（可照此结构，按研究问题调整子方向数量与内容）
\`\`\`js
// 1) 并行派发若干调研员，每个负责一个互补子方向
const researchers = await Promise.all([
  run("researcher_arch", { objective: "调研 X 的核心架构与设计哲学", inputs: [], budget: { maxCostUsd: 0.05, maxWallClockMs: 110000, maxToolCalls: 12 }, expectedOutput: "summary+findings，每条配来源", permissions: { contextScope: [], toolScope: ["web_search","web_read"] } }),
  run("researcher_ecosystem", { objective: "调研 X 的生态成熟度与生产就绪性", inputs: [], budget: { maxCostUsd: 0.05, maxWallClockMs: 110000, maxToolCalls: 12 }, expectedOutput: "summary+findings，每条配来源", permissions: { contextScope: [], toolScope: ["web_search","web_read"] } }),
]);

// 2) 收集成功的调研结果（注意：成功的判断是 status === "ok"），喂给汇总者
const materials = researchers
  .filter((r) => r.status === "ok")
  .map((r, i) => ({ index: i, output: r.output }));
const final = await run("synthesizer", {
  objective: "综合各子方向调研结果，写一份结构化研究报告。材料：" + JSON.stringify(materials),
  inputs: [],
  budget: { maxCostUsd: 0.15, maxWallClockMs: 150000, maxToolCalls: 1 },
  expectedOutput: "markdown 报告 + keyTakeaways + sources",
  permissions: { contextScope: [] }
});

// 3) 返回最终报告作为整段计划的完成值
return final.output;
\`\`\`

按给定的研究问题，决定开几个调研员（2-4 个互补子方向最佳）、各自的 objective，然后汇总。只输出脚本，不要解释性注释之外的内容。
`;

export interface ManagerResult {
  status: 'ok' | 'failed';
  planScript?: string;
  rationale?: string;
  /** 本地静态校验结果（在交给 driver 前先验一道，错误更早暴露）。 */
  scriptValid?: boolean;
  scriptErrors?: string[];
  error?: { code: string; message: string };
  costUsd: number;
  turns: number;
  ms: number;
}

export async function runManager(
  model: ModelClient,
  question: string,
  hint: { subagents: number },
): Promise<ManagerResult> {
  const spec: AgentSpec = {
    instructions:
      '你是 deep research 团队的 Manager（编排者）。你的职责是把研究问题转化为一段 PlanScript，' +
      '用 host.run 编排调研员与汇总者，可靠地交付一份研究报告。\n' +
      PLANSCRIPT_GUIDE,
    outputSchema: MANAGER_SCHEMA,
    tools: [],
    model: { id: MODEL_ID, temperature: 0.3, maxTokens: 3000 },
    runtime: 'worker',
    lifecycle: 'ephemeral',
  };
  const ctx: ContextPackage = {
    objective:
      `研究问题：${question}\n\n请生成一段 PlanScript：开 ${hint.subagents} 个互补子方向的调研员并行调研，` +
      `再用一个 synthesizer 汇总。务必让每个 run 的 ctx 字段完整。`,
    inputs: [],
    budget: { maxCostUsd: 0.05, maxWallClockMs: 40_000, maxToolCalls: 1 },
    expectedOutput: 'planScript 是一段合法的 PlanScript 源码（见规范），rationale 简述编排思路。',
    permissions: { contextScope: [] },
  };

  const started = Date.now();
  const outcome = await runAgent({
    spec,
    ctx,
    model,
    tools: [],
    emitter: { emit: () => {} },
    ids: { workspaceId: 'ws_research', runId: 'run_manager', now: () => Date.now() },
  });
  const ms = Date.now() - started;

  if (outcome.status !== 'ok' || !outcome.output || typeof outcome.output !== 'object') {
    return {
      status: 'failed',
      error: outcome.error ?? { code: 'ManagerError', message: 'Manager 未产出有效 planScript' },
      costUsd: outcome.costUsd,
      turns: outcome.turns,
      ms,
    };
  }

  const out = outcome.output as { planScript?: unknown; rationale?: unknown };
  const planScript = typeof out.planScript === 'string' ? out.planScript : '';
  const rationale = typeof out.rationale === 'string' ? out.rationale : undefined;

  // 本地先静态校验一道（driver 也会校验，但这里能更早、更清晰地暴露脚本问题）。
  const validation = validatePlanScript(planScript);

  return {
    status: 'ok',
    planScript,
    rationale,
    scriptValid: validation.ok,
    scriptErrors: validation.ok ? undefined : validation.errors.map((e) => e.message),
    costUsd: outcome.costUsd,
    turns: outcome.turns,
    ms,
  };
}
