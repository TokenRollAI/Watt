/**
 * 验收测试共用的构造器：合法 ID、ContextPackage、journal 条目工厂。
 * 全部走 @watt/protocol 的 schema，确保测试输入与协议契约一致。
 */
import {
  newAgentId,
  newRunId,
  newTaskId,
  type ContextPackage,
  type JournalEntry,
  type AgentRunResult,
} from '@watt/protocol';

export function makeAgentId(): string {
  return newAgentId();
}

export function makeRunId(): string {
  return newRunId(newTaskId());
}

/** 一个最小合法 ContextPackage（protocol agent.ts 五字段全必填）。 */
export function makeCtx(objective = 'do work'): ContextPackage {
  return {
    objective,
    inputs: [],
    budget: { maxCostUsd: 1, maxWallClockMs: 60_000, maxToolCalls: 5 },
    expectedOutput: 'a result',
    permissions: { contextScope: [] },
  };
}

/** 构造一条已完成的 run journal 条目。 */
export function completedRunEntry(seq: number, output: unknown): JournalEntry {
  const result: AgentRunResult = { status: 'ok', costUsd: 0.01, output };
  return {
    seq,
    fn: 'run',
    params: { agent: makeAgentId(), ctx: makeCtx() },
    result,
  };
}

/** 用给定 agent/ctx 构造一条已完成 run 条目（params 必须与脚本发起的一致才能重放）。 */
export function runEntry(
  seq: number,
  agent: string,
  ctx: ContextPackage,
  result?: AgentRunResult,
): JournalEntry {
  return {
    seq,
    fn: 'run',
    params: { agent, ctx },
    ...(result ? { result } : {}),
  } as JournalEntry;
}

/** 已完成的 invoke 条目。 */
export function invokeEntry(
  seq: number,
  tool: string,
  args: Record<string, unknown>,
  result?: { status: 'ok' | 'failed'; costUsd: number; output?: unknown; error?: { code: string; message: string } },
): JournalEntry {
  return {
    seq,
    fn: 'invoke',
    params: { tool, args },
    ...(result ? { result } : {}),
  } as JournalEntry;
}
