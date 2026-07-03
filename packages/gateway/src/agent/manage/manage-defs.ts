/**
 * manage/* Agent 的内置定义 + 运行时绑定（Proto M10 / R25 DoD④）。
 *
 * M10：manage Agent = 一组内置 AgentDefinition（manage/platform 全局路由 + manage/{context|tool|
 *   cron|agent} 每层一个）；system prompt 内嵌该层 ~skill，工具 = 该层接口经 builtin Provider 暴露，
 *   受 Auth 委托链约束（agent 替 user 操作才有对应权限）。
 *
 * 本文件两职责：
 *  1. **种子源**（SEED_MANAGE_DEFS）：引导时经 AgentRegistry.write 幂等写入（seedManageDefs）。
 *  2. **运行时绑定**（resolveManageBinding）：AgentInstance.onEvent 里按 definition 名解出该层的
 *     system prompt（~skill）+ 工具构造器（execute 直调 platform Manager + Check），交给 llm harness
 *     的 agentic loop（工具面选型 B，见 harness/scheduler-tools.ts）。
 *
 * R25 只落地 manage/cron（DoD④ 唯一验收面）；manage/platform 作全局路由入口一并种子（M10 完备性，
 *   但无工具绑定，纯对话）。其余层（context/tool/agent）留后续轮次（占位不种子，避免半成品）。
 */

import type { AgentDefinition, TokenClaims } from '@watt/core';
import { newAuthorizer } from '../../audit/audit-sink.ts';
import type { Bindings } from '../../env.ts';
import { SchedulerManager } from '../../scheduler/scheduler-manager.ts';
import type { AgentRegistry } from '../agent-registry.ts';
import { createSchedulerTools } from '../harness/scheduler-tools.ts';
import type { HarnessTool } from '../harness/types.ts';

/** manage/cron 的 ~skill system prompt（中文）——cron 语义 + 工具用法 + 输出纪律。 */
export const MANAGE_CRON_SYSTEM_PROMPT = [
  '你是 Watt 平台的定时任务（cron）管理助手。用户用自然语言描述定时需求，你把它翻译成 CronJob 并调用工具落地。',
  '',
  '调度语义（务必遵守）：',
  '- schedule 用 UTC 时区。周期任务用五段分钟级 cron 表达式：分 时 日 月 周（例："0 9 * * *" 表示每天 UTC 09:00）。',
  '- 一次性任务用 ISO-8601 时刻字符串（例："2026-08-01T09:00:00Z"）。',
  '- 若用户给的是本地时间且未说时区，按 UTC 处理并在回复中说明。',
  '',
  'CronJob.action 三选一：',
  '- publish：发布一个平台事件，形如 {"kind":"publish","event":{"type":"<事件类型>","payload":{...},"session":"<可选会话>"}}。',
  '  发"报表/日报"类需求时优先用 publish，事件 type 用语义化名字（如 token 日报用 "report.daily.tokens"），payload 里带目标群/参数。',
  '- agent：触发一个 Agent，形如 {"kind":"agent","definition":"<agent名>","input":{...}}。',
  '- script：执行脚本，形如 {"kind":"script","scriptRef":"<uri>","grants":[...]}。',
  '',
  '工作流程：',
  '1. 需要时先用 scheduler_list 看已有任务，避免重复。',
  '2. 用 scheduler_write 创建/更新任务。id 可省略（平台自动生成）；createdBy 由平台注入，不要自己填。',
  '3. 建成后用一句中文确认：任务用途、触发时刻（换算成人类可读）、action 类型。不要输出 JSON 原文或调用细节。',
  '',
  '若工具返回 permission denied，如实告知用户你没有相应权限，不要伪造成功。',
].join('\n');

/** manage/cron 的内置 AgentDefinition（种子）。model=glm-5.2，grants 含 platform://scheduler manage/read。 */
export const MANAGE_CRON_DEF: AgentDefinition = {
  name: 'manage/cron',
  description:
    '定时任务（cron）管理 Agent：把自然语言定时需求翻译成 CronJob 并经 Scheduler 落地（M10）。',
  runtime: 'light',
  entry: { kind: 'do-class', className: 'AgentInstance' },
  model: { preferred: 'glm-5.2' },
  grants: [{ resources: ['platform://scheduler'], actions: ['manage', 'read'] }],
  contextNamespaces: [],
  toolScopes: ['platform://scheduler'],
};

/** manage/platform 全局路由入口（M10）——纯对话路由，无工具绑定（后续可扩展分派到各层）。 */
export const MANAGE_PLATFORM_DEF: AgentDefinition = {
  name: 'manage/platform',
  description: '平台管理总入口 Agent：接收管理意图并引导到对应管理层（M10 全局路由）。',
  runtime: 'light',
  entry: { kind: 'do-class', className: 'AgentInstance' },
  model: { preferred: 'glm-5.2' },
  grants: [],
  contextNamespaces: [],
  toolScopes: [],
};

/** 全部内置 manage 定义（种子源）——R25 只 cron + platform，其余层留后续轮次。 */
export const SEED_MANAGE_DEFS: AgentDefinition[] = [MANAGE_CRON_DEF, MANAGE_PLATFORM_DEF];

/** 一个 manage 层的运行时绑定：system prompt（~skill）+ 按 claims 构造该层工具。 */
export interface ManageBinding {
  systemPrompt: string;
  /** 构造该层工具（execute 内过 Check + 调 Manager，claims = 委托链）。无工具的层返回空数组。 */
  buildTools(env: Bindings, claims: TokenClaims, traceId?: string): HarnessTool[];
}

/**
 * 按 definition 名解出 manage 层的运行时绑定；非 manage 层（或未绑定工具的层）→ undefined。
 * manage/cron → scheduler 工具（scheduler_write/list）+ cron ~skill prompt。
 * manage/platform → 有 prompt 无工具（纯路由对话，本轮不分派）——返回 systemPrompt + 空 buildTools。
 */
export function resolveManageBinding(definition: string): ManageBinding | undefined {
  if (definition === 'manage/cron') {
    return {
      systemPrompt: MANAGE_CRON_SYSTEM_PROMPT,
      buildTools(env, claims, traceId) {
        return createSchedulerTools({
          manager: new SchedulerManager(env),
          authorizer: newAuthorizer(env, traceId),
          claims,
        });
      },
    };
  }
  if (definition === 'manage/platform') {
    return {
      systemPrompt:
        '你是 Watt 平台管理总入口。理解用户的管理意图（定时任务、上下文、工具、Agent 等），用中文引导用户到对应能力；本轮暂不代为执行子层操作。',
      buildTools: () => [],
    };
  }
  return undefined;
}

/**
 * 幂等种子 manage 定义（引导时调，仿 authz/seed.ts once-guard 语义）。
 * 每个 def 经 AgentRegistry.write upsert（相同 name 覆盖）——重复调用安全。不建订阅（manage/* 无声明式
 *   订阅，靠 CLI/对话主动 spawn）。
 */
export async function seedManageDefs(registry: AgentRegistry): Promise<void> {
  for (const def of SEED_MANAGE_DEFS) {
    await registry.write(def);
  }
}

/** isolate 级短路缓存（同一 isolate 内已成功种子的 promise）。失败时置回 null 以保留重试。 */
let manageSeeded: Promise<void> | null = null;

/**
 * 幂等引导入口（挂 platform/* 种子中间件，仿 ensureSeedPolicy）：isolate 级短路，首次成功后不再打 D1。
 * upsert 语义下即使短路失效重跑也安全（相同 name 覆盖，不累积）。失败清缓存以便下次请求重试。
 */
export function ensureManageDefsSeeded(registry: AgentRegistry): Promise<void> {
  if (!manageSeeded) {
    manageSeeded = seedManageDefs(registry).catch((err) => {
      manageSeeded = null;
      throw err;
    });
  }
  return manageSeeded;
}

/** 测试专用：重置 isolate 级短路缓存（清库后须调，否则种子不再重建）。 */
export function resetManageSeedGuardForTests(): void {
  manageSeeded = null;
}
