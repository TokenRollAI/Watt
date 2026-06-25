/**
 * Host 桥的「参数归一化 + schema 校验」层。
 *
 * 沙箱内脚本以 protocol-v1.md 规定的位置参数形态调用 Host 函数：
 *   run(agent, ctx) / invoke(tool, args) / spawn(req) / checkpoint(summary, refs?)
 *   approval(prompt, refs?) / sleep(ms) / waitFor(eventKey, timeoutMs) / artifact(op)
 *
 * 而 journal 的存储单元（@watt/protocol 的 *Params schema）是「具名对象」。本模块把
 * 沙箱侧传来的 JS 实参数组翻译成对象形状，再用对应 zod schema 校验/归一化。校验在
 * 参数进入 journal「之前」执行——任何不合法的 Host 调用都不会进入确定性记录。
 *
 * 设计决策（已在最终报告标注）：协议层把 Host API 同时表达为全局对象 `host` 与 8 个
 * 顶层全局函数。这里只关心「函数名 + 位置实参 → 校验过的 params」，与暴露形式解耦。
 */
import {
  ApprovalParams,
  ArtifactParams,
  CheckpointParams,
  HostFunction,
  InvokeParams,
  RunParams,
  SleepParams,
  SpawnParams,
  WaitForParams,
} from '@watt/protocol';
import { z } from 'zod';

/** 把某个 Host 函数的位置实参翻译成「待校验的对象」。 */
function argsToParamsObject(fn: HostFunction, args: unknown[]): unknown {
  switch (fn) {
    case 'run':
      return { agent: args[0], ctx: args[1] };
    case 'invoke':
      return { tool: args[0], args: args[1] };
    case 'spawn':
      // spawn 单对象参数（SpawnRequest）。
      return args[0];
    case 'checkpoint':
      return { summary: args[0], ...(args[1] !== undefined ? { refs: args[1] } : {}) };
    case 'approval':
      return { prompt: args[0], ...(args[1] !== undefined ? { refs: args[1] } : {}) };
    case 'sleep':
      return { ms: args[0] };
    case 'waitFor':
      return { eventKey: args[0], timeoutMs: args[1] };
    case 'artifact':
      // artifact 单对象参数（ArtifactOp 判别联合）。
      return args[0];
  }
}

const PARAM_SCHEMAS: Record<HostFunction, z.ZodType> = {
  run: RunParams,
  invoke: InvokeParams,
  spawn: SpawnParams,
  checkpoint: CheckpointParams,
  approval: ApprovalParams,
  sleep: SleepParams,
  waitFor: WaitForParams,
  artifact: ArtifactParams,
};

export interface NormalizedParamsOk {
  ok: true;
  params: unknown;
}
export interface NormalizedParamsErr {
  ok: false;
  message: string;
}

/**
 * 归一化并校验一次 Host 调用的参数。
 * 失败时返回结构化错误（zod 报文摘要），由调用方决定是 reject 还是终止。
 */
export function normalizeHostParams(
  fn: HostFunction,
  args: unknown[],
): NormalizedParamsOk | NormalizedParamsErr {
  const candidate = argsToParamsObject(fn, args);
  const result = PARAM_SCHEMAS[fn].safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return { ok: false, message: `host.${fn} 参数校验失败：${issues}` };
  }
  return { ok: true, params: result.data };
}

/**
 * 比较两个已归一化 params 是否结构相等（journal 一致性校验用）。
 * 采用稳定序列化比较：params 都是经 zod 归一化的纯 JSON 数据，键序不保证一致，
 * 故先做键排序再 JSON.stringify。
 */
export function paramsEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
