import { type WattError, wattError } from '@watt/shared';

/**
 * correlationId 校验 + correlation 等待表纯状态机（Proto §3.4）——无 I/O。
 *
 * correlationId 约束（§3.4 L444）：字符集 [A-Za-z0-9_-]、长度 ≤80（平台生成时保证，
 *   透传时校验，违规 → invalid_argument）——保证净化后 Workflows 事件名合法。
 *
 * CorrelationTable 是六条路由规则（§3.4）的判定数据源：
 *   register  → 登记等待方 + 超时时刻；
 *   resolve   → 首次返回等待方并标记 settled，再次 null（规则 6 去重）；
 *   expire    → 到期未 settled 列表（规则 3 超时代发的判定源）；
 *   failWaiter→ 某等待方名下全部未 settled correlation（规则 4 终止即失败）。
 * 内存实现在此；gateway 后续以 DO storage 实现同接口（CorrelationTable interface）。
 */

// correlationId 合法字符集与长度上限（§3.4 L444）。
const CORRELATION_ID_MAX_LEN = 80;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * 校验 correlationId 合法性（透传路径）。
 * 空串、超长、含非法字符 → invalid_argument WattError；合法 → null。
 */
export function validateCorrelationId(id: string): WattError | null {
  if (id.length === 0) {
    return wattError('invalid_argument', 'correlationId must not be empty', false);
  }
  if (id.length > CORRELATION_ID_MAX_LEN) {
    return wattError(
      'invalid_argument',
      `correlationId exceeds max length ${CORRELATION_ID_MAX_LEN}: got ${id.length}`,
      false,
    );
  }
  if (!CORRELATION_ID_PATTERN.test(id)) {
    return wattError('invalid_argument', 'correlationId must match [A-Za-z0-9_-]', false);
  }
  return null;
}

/** 注入的 id 生成器（平台用 crypto.randomUUID 等实现；纯逻辑侧注入以保持决定性可测）。 */
export type GenIdFn = () => string;

/**
 * 由注入的 genId 产合法 correlationId（平台生成路径，§3.4 L444「平台生成时保证」）。
 * 对 genId 产物做净化：非法字符替换为 '-'，超长截断到上限——保证结果必过 validateCorrelationId。
 */
export function genCorrelationId(genId: GenIdFn): string {
  const raw = genId();
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, CORRELATION_ID_MAX_LEN);
  // 净化后若为空（genId 产纯非法且被截空的极端情况），兜底一个合法占位。
  return sanitized.length === 0 ? 'c' : sanitized;
}

// ─── CorrelationTable 状态机 ─────────────────────────────────────────────

/** 等待方标识：Send 的调用者（agent 实例）或 Task 步骤（§3.4 规则 1）。 */
export interface Waiter {
  kind: 'agent' | 'task';
  id: string;
}

/** 内部记录：等待方 + 超时时刻 + 是否已 settled（结果送达/超时/终止后置位）。 */
interface CorrelationRecord {
  waiter: Waiter;
  timeoutAtMs: number;
  settled: boolean;
}

/**
 * correlation 等待表接口——gateway 以 DO storage 实现同接口。
 * 所有方法同步纯判定（内存实现）；DO 实现会是异步，但接口形状与语义一致。
 */
export interface CorrelationTable {
  /** 登记一个等待中的 correlation。重复 register 同 id → 覆盖（幂等 upsert 语义）。 */
  register(correlationId: string, waiter: Waiter, timeoutAtMs: number): void;
  /**
   * 是否存在该 correlation 的记录（无论 settled 与否）。
   * 用于区分「从未登记」（规则 5 drop-no-waiter）与「已 settled」（规则 6 drop-duplicate）——
   * resolve 对两者都返回 null，故路由判定需先 hasPending 探测。
   */
  hasPending(correlationId: string): boolean;
  /**
   * 解析一个 correlation：首次返回其 waiter 并标记 settled；
   * 再次调用（已 settled 或不存在）→ null（规则 6 去重 / 规则 5 等待方消失后无记录）。
   */
  resolve(correlationId: string): Waiter | null;
  /** 返回 nowMs 时刻所有到期且未 settled 的 correlationId（规则 3 超时代发判定源）。 */
  expire(nowMs: number): string[];
  /**
   * 某等待方被终止（规则 4）：返回其名下全部未 settled 的 correlationId，
   * 并将它们标记 settled（避免后续 resolve 再触发）。
   */
  failWaiter(waiterId: string): string[];
}

/** CorrelationTable 的内存实现（纯逻辑单测用；gateway 用 DO storage 版本）。 */
export class InMemoryCorrelationTable implements CorrelationTable {
  private readonly records = new Map<string, CorrelationRecord>();

  register(correlationId: string, waiter: Waiter, timeoutAtMs: number): void {
    this.records.set(correlationId, { waiter, timeoutAtMs, settled: false });
  }

  hasPending(correlationId: string): boolean {
    return this.records.has(correlationId);
  }

  resolve(correlationId: string): Waiter | null {
    const rec = this.records.get(correlationId);
    if (rec === undefined || rec.settled) return null;
    rec.settled = true;
    return rec.waiter;
  }

  expire(nowMs: number): string[] {
    const out: string[] = [];
    for (const [id, rec] of this.records) {
      if (!rec.settled && rec.timeoutAtMs <= nowMs) {
        rec.settled = true;
        out.push(id);
      }
    }
    return out;
  }

  failWaiter(waiterId: string): string[] {
    const out: string[] = [];
    for (const [id, rec] of this.records) {
      if (!rec.settled && rec.waiter.id === waiterId) {
        rec.settled = true;
        out.push(id);
      }
    }
    return out;
  }
}
