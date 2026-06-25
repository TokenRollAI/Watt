/**
 * 预算三限（ContextPackage.budget）：maxCostUsd / maxWallClockMs /
 * maxToolCalls。
 *
 * 每次模型调用与工具调用之前，由确定性代码检查；超限立即中止，结果标记为
 * budget exceeded（用 @watt/protocol 的 BUDGET_EXCEEDED 常量），不可被
 * "模型决定继续"绕过。成本是一等公民：累计每次模型与工具调用的 costUsd。
 */

import { BUDGET_EXCEEDED, type Budget } from '@watt/protocol';

/** 触发预算中止的具体限额。 */
export type BudgetLimit = 'maxCostUsd' | 'maxWallClockMs' | 'maxToolCalls';

/** 预算超限错误：不可被模型绕过，直接终止 turn loop。 */
export class BudgetExceededError extends Error {
  /** 与 protocol TypedError.code 对齐的稳定码 */
  readonly code = BUDGET_EXCEEDED;
  /** 触发中止的限额 */
  readonly limit: BudgetLimit;

  constructor(limit: BudgetLimit, detail: string) {
    super(`${BUDGET_EXCEEDED}: ${limit} — ${detail}`);
    this.name = 'BudgetExceededError';
    this.limit = limit;
  }

  toTypedError(): { code: string; message: string } {
    return { code: this.code, message: this.message };
  }
}

/**
 * 预算计量器：累计成本与工具调用数，提供"调用前检查"。
 * 时钟注入（now）以便测试墙钟超限路径。
 */
export class BudgetMeter {
  private costUsd = 0;
  private toolCalls = 0;
  private readonly startedAt: number;

  constructor(
    private readonly budget: Budget,
    private readonly now: () => number,
  ) {
    this.startedAt = now();
  }

  /** 当前累计成本（USD）。 */
  get spentUsd(): number {
    return this.costUsd;
  }

  /** 当前累计工具调用数。 */
  get toolCallCount(): number {
    return this.toolCalls;
  }

  /** 已耗墙钟（ms）。 */
  elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  /**
   * 模型调用前检查：成本与墙钟（模型调用不计入 maxToolCalls）。
   * 超限抛 BudgetExceededError。
   */
  assertCanCallModel(): void {
    this.assertCost();
    this.assertWallClock();
  }

  /**
   * 工具调用前检查：成本、墙钟、工具次数。
   * maxToolCalls 是"再发起一次工具调用是否越界"，故用 >= 判定。
   */
  assertCanCallTool(): void {
    this.assertCost();
    this.assertWallClock();
    if (this.toolCalls >= this.budget.maxToolCalls) {
      throw new BudgetExceededError(
        'maxToolCalls',
        `已用 ${this.toolCalls} 次，上限 ${this.budget.maxToolCalls}`,
      );
    }
  }

  private assertCost(): void {
    if (this.costUsd >= this.budget.maxCostUsd) {
      throw new BudgetExceededError(
        'maxCostUsd',
        `已花 ${this.costUsd} USD，上限 ${this.budget.maxCostUsd}`,
      );
    }
  }

  private assertWallClock(): void {
    const elapsed = this.elapsedMs();
    if (elapsed >= this.budget.maxWallClockMs) {
      throw new BudgetExceededError(
        'maxWallClockMs',
        `已用 ${elapsed}ms，上限 ${this.budget.maxWallClockMs}ms`,
      );
    }
  }

  /** 记一次模型调用成本。 */
  addModelCost(costUsd: number): void {
    this.costUsd += costUsd;
  }

  /** 记一次工具调用：累计成本并 +1 工具计数。 */
  addToolCall(costUsd: number): void {
    this.costUsd += costUsd;
    this.toolCalls += 1;
  }
}
