/**
 * @watt/model-deepseek 公共 API。
 *
 * 薄模型层：DeepSeek 官方 API（OpenAI 兼容，V1 非流式）的窄客户端，
 * 暴露 ModelClient 接口供 runtime-core 依赖。
 */

export type {
  ModelClient,
  ChatRequest,
  ChatMessage,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  FunctionToolDef,
  ToolCall,
  ToolChoice,
  NormalizedChatResponse,
  NormalizedUsage,
} from './types.js';

export {
  DeepSeekClient,
  normalizeUsage,
  defaultBackoff,
  type DeepSeekClientOptions,
  type FetchLike,
  type BackoffFn,
} from './client.js';

export {
  DEFAULT_PRICE_TABLE,
  computeCostUsd,
  priceFor,
  type ModelPrice,
  type PriceTable,
} from './pricing.js';

export { ModelError, isTransientStatus, type ModelErrorCode } from './errors.js';

export {
  assemblePrompt,
  assertStablePrefix,
  assertStableTools,
} from './prompt.js';
