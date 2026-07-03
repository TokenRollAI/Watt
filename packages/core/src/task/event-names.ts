import { type WattError, wattError } from '@watt/shared';

/**
 * Workflows 事件名净化（Proto §3.4 L446）——无 I/O。
 *
 * Cloudflare Workflows 的 waitForEvent 事件 type 仅允许 [A-Za-z0-9_-]、≤100 字符、禁 '.'。
 * 平台层事件名保持点分（如 agent.result）；净化只发生在 Workflows 适配层。规范映射（§3.4）：
 *   - agent.result / agent.failed 归并为同一 type `agent-result-<correlationId>`
 *     （payload 带 status:'result'|'failed'，由步骤代码分支处理——否则等 result 的步骤收不到 failed）；
 *   - 人类确认：`task-signal-<checkpoint>`。
 */

// Workflows 事件名约束（§3.4 L446）。
const EVENT_NAME_MAX_LEN = 100;
const EVENT_NAME_LEGAL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * 净化任意平台名为合法 Workflows 事件名片段。
 * 处理：'.' → '-'（点分事件名的规范映射）；其余非法字符（[A-Za-z0-9_-] 之外）→ '-'。
 * 声明：非法字符统一折叠为 '-'（不丢弃、不百分号编码）——保持可读且与 correlationId 净化一致
 *   （见 [[correlation]] genCorrelationId 同策略）。
 * 校验：净化结果为空 → 兜底 'x'（避免空片段）；超长 → 由调用方经 assertEventName 判定（此处只净化不截断）。
 */
export function sanitizeEventName(name: string): string {
  const sanitized = name.replace(/\./g, '-').replace(/[^A-Za-z0-9_-]/g, '-');
  return sanitized.length === 0 ? 'x' : sanitized;
}

/**
 * 断言一个已构造的事件名合法（供已知合法性存疑的完整名做终检）。
 * 空 / 超长（>100）/ 含非法字符 → invalid_argument；合法 → null。
 */
export function assertEventName(name: string): WattError | null {
  if (name.length === 0) {
    return wattError('invalid_argument', 'event name must not be empty', false);
  }
  if (name.length > EVENT_NAME_MAX_LEN) {
    return wattError(
      'invalid_argument',
      `event name exceeds Workflows max length ${EVENT_NAME_MAX_LEN}: got ${name.length}`,
      false,
    );
  }
  if (!EVENT_NAME_LEGAL_PATTERN.test(name)) {
    return wattError('invalid_argument', 'event name must match [A-Za-z0-9_-]', false);
  }
  return null;
}

/**
 * agent.result / agent.failed 的归并事件名（§3.4 L446）。
 * correlationId 净化后拼 `agent-result-<cid>`；结果 >100 → invalid_argument（不截断，
 * 因 correlationId ≤80 已保证前缀 'agent-result-'(13) + 80 = 93 ≤ 100，超长只可能因非法入参）。
 * 返回 string（合法）或 WattError（净化后仍超长/非法的兜底面）。
 */
export function agentResultEventName(correlationId: string): string | WattError {
  const name = `agent-result-${sanitizeEventName(correlationId)}`;
  const err = assertEventName(name);
  return err === null ? name : err;
}

/**
 * 人类确认信号的事件名（§3.4 L446）。
 * checkpoint 先净化再拼 `task-signal-<checkpoint>`；超长/非法 → invalid_argument。
 */
export function taskSignalEventName(checkpoint: string): string | WattError {
  const name = `task-signal-${sanitizeEventName(checkpoint)}`;
  const err = assertEventName(name);
  return err === null ? name : err;
}
