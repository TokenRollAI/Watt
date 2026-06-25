/**
 * Script Runner —— PlanScript 的确定性执行驱动（架构「调度器三件套」之一）。
 *
 * 执行模型（见 architecture/execution-model.md「Script Runner」与 plan-script 包）：
 * PlanScript 是 Manager 生成的 JS 数据资产；本 driver 用 replayPlanScript 反复重放它：
 *
 *   journal = []
 *   loop:
 *     r = replayPlanScript({ source, journal })
 *     if r.completed → 返回脚本完成值
 *     if r.pending   → 在沙箱外并行执行 r.calls（host.run / host.invoke）
 *                      把每个结果写回 journal[seq]，继续 loop
 *
 * 关键：模型调用（runAgent）发生在**沙箱之外**的宿主侧——QuickJS 沙箱内无网络、无
 * 时间、无随机（plan-script 的两道防线保证）。脚本只负责「编排」（决定开几路、依赖、
 * 汇总），真正的 Agent 执行由 host.run 在确定性 driver 控制下派发。这正是「模型负责
 * 计划、确定性代码负责调度」：Manager 产 PlanScript 数据，driver 产动作。
 *
 * 不变量落地：
 * - 每个 host 调用结果符合 protocol 的 AgentRunResult/ToolRunResult（status/costUsd/...）。
 * - 预算由 driver 在「发起新调用前」用 budgetCheck 兜底（确定性，脚本不可绕过）。
 * - host.run 的结果是确定性记录进 journal；相同 journal 必然重放出相同 frontier。
 */

import type { ModelClient } from '@watt/model-deepseek';
import type { AgentRunResult, JournalEntry } from '@watt/protocol';
import { replayPlanScript, setQuickJSVariant, type PendingCall, type ReplayResult } from '@watt/plan-script';
import { newVariant } from 'quickjs-emscripten';
import baseVariantImport from '@jitl/quickjs-wasmfile-release-sync';
// Cloudflare Workers 只允许「部署时预编译」的 WebAssembly.Module，禁止运行时
// instantiate(bytes)。wrangler 把静态 import 的 .wasm 当作预编译 Module 处理——这是
// Workers 上加载 WASM 的唯一合法路径。我们直接 import variant 的 .wasm 模块，用
// newVariant 把它注入，绕开默认 emscripten loader 的运行时 fetch/instantiate。
import wasmModule from '@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm';
import { runRoleAgent, type RoleRunReport } from './roles.js';

const baseVariant =
  (baseVariantImport as { default?: unknown }).default ?? (baseVariantImport as unknown);
// 用预编译的 WebAssembly.Module 覆盖 variant 的 wasm 加载（Workers 兼容）。
const workerVariant = newVariant(baseVariant as never, { wasmModule: wasmModule as never });
setQuickJSVariant(workerVariant);

/** host 调用的执行轨迹（用于观察脚本驱动了哪些 Agent）。 */
export interface HostCallTrace {
  seq: number;
  fn: string;
  agent?: string;
  status: 'ok' | 'failed';
  costUsd: number;
  ms: number;
}

export interface DriverResult {
  /** 脚本最终状态。 */
  status: 'completed' | 'failed';
  /** completed 时脚本的返回值（通常是最终报告或其 ref）。 */
  value?: unknown;
  /** 失败诊断（脚本错误 / 预算 / gas / 超时 / journal 不一致 / 校验失败）。 */
  error?: { kind: string; message: string };
  /** 重放轮数（= fan-out 批次数，体现脚本的依赖结构）。 */
  rounds: number;
  /** 全部 host 调用轨迹。 */
  hostCalls: HostCallTrace[];
  /** 各 role agent 的详细运行报告（researcher 的调研轨迹在此）。 */
  roleReports: RoleRunReport[];
  /** 总成本（所有 host.run / host.invoke 的 costUsd 之和）。 */
  totalCostUsd: number;
}

export interface DriverDeps {
  source: string;
  model: ModelClient;
  tavilyKey: string;
  question: string;
  /** 整段计划的成本上限（USD）；超限由 budgetCheck 在发起新调用前终止。 */
  maxPlanCostUsd: number;
  /** 重放轮数上限（防脚本逻辑异常导致无限 fan-out）。 */
  maxRounds?: number;
}

/**
 * 执行一段 PlanScript 到完成或失败。
 *
 * 注意：每轮 replay 都从头跑脚本（已完成调用从 journal 快进），这是 plan-script 的
 * 重放语义。脚本本体确定性、毫秒级；真正耗时的是沙箱外的 host.run（模型调用）。
 */
export async function runPlanScript(deps: DriverDeps): Promise<DriverResult> {
  const { source, model, tavilyKey, question } = deps;
  const maxRounds = deps.maxRounds ?? 8;

  const journal: JournalEntry[] = [];
  const hostCalls: HostCallTrace[] = [];
  const roleReports: RoleRunReport[] = [];
  let totalCostUsd = 0;
  let rounds = 0;

  while (rounds < maxRounds) {
    rounds += 1;

    // 预算兜底：发起新调用前检查累计成本是否已超限（确定性，脚本不可绕过）。
    const budgetCheck = (_call: PendingCall): boolean => totalCostUsd >= deps.maxPlanCostUsd;

    const result: ReplayResult = await replayPlanScript({
      source,
      journal,
      budgetCheck,
      // 脚本本体应毫秒级；给足冗余。
      wallClockTimeoutMs: 5_000,
    });

    if (result.status === 'completed') {
      return { status: 'completed', value: result.value, rounds, hostCalls, roleReports, totalCostUsd };
    }

    if (result.status !== 'pending') {
      // validation_failed / failed / gas_exceeded / timeout / budget_exceeded / journal_mismatch
      const message =
        result.status === 'validation_failed'
          ? `PlanScript 静态校验失败：${result.errors.map((e) => e.message).join('; ')}`
          : result.error.message;
      return { status: 'failed', error: { kind: result.status, message }, rounds, hostCalls, roleReports, totalCostUsd };
    }

    // pending：并行执行本批所有 host 调用，把结果写回 journal[seq]。
    const settled = await Promise.all(
      result.calls.map((call) => executeHostCall(call, { model, tavilyKey, question })),
    );

    for (const s of settled) {
      journal[s.seq] = s.entry;
      totalCostUsd += s.trace.costUsd;
      hostCalls.push(s.trace);
      if (s.report) roleReports.push(s.report);
    }
  }

  return {
    status: 'failed',
    error: { kind: 'max_rounds', message: `重放轮数超过上限 ${maxRounds}（脚本可能无限 fan-out）` },
    rounds,
    hostCalls,
    roleReports,
    totalCostUsd,
  };
}

interface SettledCall {
  seq: number;
  entry: JournalEntry;
  trace: HostCallTrace;
  report?: RoleRunReport;
}

interface HostExecDeps {
  model: ModelClient;
  tavilyKey: string;
  question: string;
}

/**
 * 在沙箱外执行一个 pending host 调用。
 *
 * V1 支持 run（派发 role agent）与 invoke（直接工具调用，此处暂未启用业务工具，留作
 * 扩展）。其余 host 函数（spawn/checkpoint/approval/sleep/waitFor/artifact）在本 demo
 * 编排中不需要，遇到则返回 failed，让脚本走 continue-on-error 或失败传播。
 */
async function executeHostCall(call: PendingCall, deps: HostExecDeps): Promise<SettledCall> {
  const started = Date.now();

  if (call.fn === 'run') {
    const params = call.params as { agent: string; ctx: import('@watt/protocol').ContextPackage };
    const report = await runRoleAgent({
      agent: params.agent,
      ctx: params.ctx,
      model: deps.model,
      tavilyKey: deps.tavilyKey,
    });
    const ms = Date.now() - started;
    const result: AgentRunResult =
      report.status === 'ok'
        ? { status: 'ok', costUsd: report.costUsd, output: report.output }
        : { status: 'failed', costUsd: report.costUsd, error: report.error ?? { code: 'AgentError', message: 'unknown' } };
    return {
      seq: call.seq,
      entry: { seq: call.seq, fn: 'run', params: call.params as never, result },
      trace: { seq: call.seq, fn: 'run', agent: params.agent, status: result.status, costUsd: result.costUsd, ms },
      report,
    };
  }

  // 未支持的 host 函数：返回 failed 结果（脚本可降级）。run 之外的形状用 invoke 兜底。
  const ms = Date.now() - started;
  const failed = {
    status: 'failed' as const,
    costUsd: 0,
    error: { code: 'UnsupportedHostFn', message: `host.${call.fn} 在本编排中未实现` },
  };
  return {
    seq: call.seq,
    entry: { seq: call.seq, fn: call.fn, params: call.params as never, result: failed as never },
    trace: { seq: call.seq, fn: call.fn, status: 'failed', costUsd: 0, ms },
  };
}
