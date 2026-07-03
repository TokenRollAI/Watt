import { type WattError, wattError } from '@watt/shared';
import type { SignalDecision, TaskState } from './types.ts';

/**
 * Signal 状态机纯判定（Proto §8 Signal / DoD §7 单测项）——无 I/O。
 *
 * 规范约束（§8 L802 / DoD §7）：Signal 只对 waiting_human / waiting_event 的 Task 有效；
 * 其余状态 Signal → conflict（DoD §7 明写）。decision 三态与 consumer 桩一致。
 */

/** waiting 类状态集合：可接收 Signal 的两态（§8 L802）。 */
const SIGNALABLE_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'waiting_human',
  'waiting_event',
]);

/**
 * 判定某状态能否接收 Signal（§8 / DoD §7）。
 * waiting_human / waiting_event → null（可信号）；其余 7 态 → conflict（message 带当前态）。
 */
export function checkSignalable(state: TaskState): WattError | null {
  if (SIGNALABLE_STATES.has(state)) return null;
  return wattError(
    'conflict',
    `task not signalable in state '${state}': only waiting_human/waiting_event accept signals`,
    false,
  );
}

/**
 * 应用 Signal 后的次态判定（纯逻辑）。
 *
 * 声明：Proto §8 **未**定义 decision→次态的映射规则（执行状态由引擎驱动，§8 L800）——
 * decision 的语义（approve 继续 / reject 中止 / custom 分支）由 Workflows 模板代码在
 * waitForEvent 恢复后自行解释。故本函数只实现规范可断言的最小面：
 *   - 不可信号的状态（非 waiting）→ conflict（复用 checkSignalable）；
 *   - 可信号的状态 → 恢复为 'running'（waiting→running 恢复语义，引擎随后按 decision 推进/终止）。
 * 返回 { next } 或 { error }（不抛异常，保持纯判定可测）。
 */
export function applySignalTransition(
  state: TaskState,
  _decision: SignalDecision,
): { next: TaskState } | { error: WattError } {
  const err = checkSignalable(state);
  if (err !== null) return { error: err };
  return { next: 'running' };
}
