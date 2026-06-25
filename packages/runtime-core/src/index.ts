/**
 * @watt/runtime-core 公共 API。
 *
 * Agent Runtime turn loop：平台无关（不 import 任何 Cloudflare API），纯
 * vitest 可测。依赖 @watt/model-deepseek 的 ModelClient 窄接口。
 */

export { runAgent, MAX_FOLLOW_UPS } from './run.js';
export type {
  RunAgentParams,
  AgentRunOutcome,
  RunFailureCode,
} from './run.js';

export type { Tool, ToolResult } from './tools.js';
export { allowedToolNames } from './tools.js';

export {
  FINISH_TOOL,
  GIVE_UP_TOOL,
  validateOutput,
  makeFinishToolDef,
  makeGiveUpToolDef,
  type FinishOutcome,
} from './finish.js';

export {
  BudgetMeter,
  BudgetExceededError,
  type BudgetLimit,
} from './budget.js';

export {
  RunEventSink,
  RUN_EVENTS,
  type EventEmitter,
  type EventContext,
} from './events.js';
