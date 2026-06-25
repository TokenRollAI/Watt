/**
 * PlanScript 重放结果与公共类型。
 *
 * 重放（replay）的产物是一个判别联合 ReplayResult：脚本要么跑到底（completed）、
 * 要么停在「等待一批 Host 调用完成」的静止态（pending）、要么被宿主截停或脚本自身
 * 出错（failed / gas_exceeded / timeout / budget_exceeded / journal_mismatch）。
 *
 * 关键不变量（见 core-invariants.md 不变量 4）：相同 journal 必然重放出相同的
 * 「下一批 pending 调用」（seq / fn / params 全等）。pending frontier 即为此不变量
 * 的可观测表达。
 */
import type { HostFunction, JournalEntry, TypedError } from '@watt/protocol';

/**
 * 一个待执行的 Host 调用（pending frontier 的单元）。
 *
 * - seq：按发起顺序分配的确定性序号（与完成顺序无关）。
 * - fn：8 个 Host 函数之一。
 * - params：已用 @watt/protocol 对应 schema 校验并归一化后的参数（journal 的存储形状）。
 */
export interface PendingCall {
  seq: number;
  fn: HostFunction;
  params: unknown;
}

/** 重放被宿主截停或脚本出错时携带的诊断信息。 */
export interface ReplayDiagnostic {
  message: string;
  /** journal 一致性破坏时，记录期望与实际的差异 */
  expected?: { seq: number; fn: HostFunction; params: unknown };
  actual?: { seq: number; fn: HostFunction; params: unknown };
}

/**
 * 重放结果判别联合。status 是判别字段。
 *
 * - pending：脚本静止在 fan-out frontier 上，calls 是本批全部待执行 Host 调用。
 * - completed：脚本顶层 async 体 resolve，value 是其完成值（best-effort 序列化）。
 * - failed：脚本抛出未捕获异常（非预算类）。
 * - gas_exceeded：指令级 gas 上限触发，死循环被截停。
 * - timeout：宿主侧 wall-clock 超时截停。
 * - budget_exceeded：预算超限，宿主直接终止（不投递进沙箱，脚本不可捕获）。
 * - journal_mismatch：脚本实际发起的调用与 journal 条目 fn/params 不一致，确定性被破坏。
 * - validation_failed：静态校验未通过（脚本根本不会进入沙箱执行）。
 */
export type ReplayResult =
  | { status: 'pending'; calls: PendingCall[] }
  | { status: 'completed'; value: unknown }
  | { status: 'failed'; error: ReplayDiagnostic }
  | { status: 'gas_exceeded'; error: ReplayDiagnostic }
  | { status: 'timeout'; error: ReplayDiagnostic }
  | { status: 'budget_exceeded'; error: ReplayDiagnostic }
  | { status: 'journal_mismatch'; error: ReplayDiagnostic }
  | { status: 'validation_failed'; errors: import('./validate.js').ValidationError[] };

/** 重放输入选项。 */
export interface ReplayOptions {
  /** PlanScript 源码 */
  source: string;
  /** 已知的 journal：以 seq 为隐式键（数组下标须等于 seq）。pending 条目无 result。 */
  journal: JournalEntry[];
  /**
   * 指令级 gas 上限：解释器每隔若干指令回调 interrupt handler，累计达上限即截停。
   * 这里以「interrupt 回调次数」近似 gas 计量（QuickJS 不暴露真实指令计数）。
   */
  gasLimit?: number;
  /** 单次重放 wall-clock 超时（宿主侧计时，毫秒） */
  wallClockTimeoutMs?: number;
  /** 沙箱内存上限（字节） */
  memoryLimitBytes?: number;
  /** 沙箱最大栈尺寸（字节） */
  maxStackSizeBytes?: number;
  /**
   * 预算检查钩子：每次脚本发起新 Host 调用（即到达一个尚未出现在 journal 的 seq）
   * 之前，宿主可在此判定是否预算超限。返回 true 表示超限 → 直接终止整个执行，
   * 标记 budget_exceeded，错误不投递进沙箱。默认不超限。
   */
  budgetCheck?: (call: PendingCall) => boolean;
}

export type { TypedError };
