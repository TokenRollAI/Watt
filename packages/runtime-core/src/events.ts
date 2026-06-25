/**
 * 事件发射：通过注入的窄 emitter 发 WattEvent（scope:'run'）。
 *
 * emitter 保持窄——一个 emit 函数。runId / workspaceId 等标识由调用方提供，
 * eventIndex 由 runtime 单调递增。每条事件 payload 带 costUsd（成本是一等
 * 公民，事件流也要能审计成本）。
 */

import type { RunEvent } from '@watt/protocol';

/** 窄 emitter：runtime 只依赖这一个函数。 */
export interface EventEmitter {
  emit(event: RunEvent): void | Promise<void>;
}

/** runtime 发出的事件类型常量。 */
export const RUN_EVENTS = {
  started: 'agent_run.started',
  modelCalled: 'model.called',
  toolCalled: 'tool.called',
  finished: 'agent_run.finished',
} as const;

/** 构造事件所需的稳定标识（调用方提供）。 */
export interface EventContext {
  workspaceId: string;
  runId: string;
  /** 时钟注入：默认 Date.now，测试可固定。事件 at 用它生成 ISO 串。 */
  now: () => number;
}

/**
 * 事件发射器封装：维护 eventIndex 单调递增，统一补全 base 字段。
 * 不直接持有 EventEmitter 的实现细节，只调用注入的 emit。
 */
export class RunEventSink {
  private index = 0;
  constructor(
    private readonly emitter: EventEmitter,
    private readonly ctx: EventContext,
  ) {}

  async emit(type: string, payload: Record<string, unknown>): Promise<void> {
    const event: RunEvent = {
      scope: 'run',
      workspaceId: this.ctx.workspaceId,
      runId: this.ctx.runId,
      eventIndex: this.index++,
      at: new Date(this.ctx.now()).toISOString(),
      type,
      payload,
    };
    await this.emitter.emit(event);
  }
}
