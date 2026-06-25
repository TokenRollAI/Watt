/**
 * DeepSeek 薄模型层的消息 / 工具 / 响应类型。
 *
 * 形状保持 OpenAI 兼容（chat completions），但只覆盖 V1 非流式所需的子集，
 * 不引第三方依赖。归一化层（NormalizedChatResponse）把 provider 原始 usage
 * 收敛成统一结构，并强制每次响应都带 costUsd（成本是一等公民）。
 */

// ---- 请求侧：消息与工具 ----

/** system / user 文本消息 */
export interface SystemMessage {
  role: 'system';
  content: string;
}
export interface UserMessage {
  role: 'user';
  content: string;
}

/** 模型产出的助手消息：可只带文本、只带 tool_calls，或两者皆有 */
export interface AssistantMessage {
  role: 'assistant';
  /** 无工具调用时为文本；有工具调用时可能为 null */
  content: string | null;
  /** 模型请求执行的工具调用 */
  tool_calls?: ToolCall[];
}

/** 工具执行结果回填消息：必须携带对应的 tool_call_id */
export interface ToolResultMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

export type ChatMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

/** function tool 定义（OpenAI 兼容）。parameters 是 JSON Schema 对象。 */
export interface FunctionToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    /** JSON Schema（draft 2020-12 子集），由调用方提供 */
    parameters: Record<string, unknown>;
  };
}

/** 响应中的单个工具调用 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** 模型生成的 JSON 字符串实参，未必合法 JSON，由调用方解析 */
    arguments: string;
  };
}

/** 工具选择策略：与 OpenAI 兼容的窄子集 */
export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

/** 一次 chat 调用的请求。fetch 由客户端注入，本类型只描述语义参数。 */
export interface ChatRequest {
  /** 形如 "deepseek-chat" 的裸 model id（不带 provider 前缀） */
  model: string;
  messages: ChatMessage[];
  tools?: FunctionToolDef[];
  toolChoice?: ToolChoice;
  temperature?: number;
  maxTokens?: number;
}

// ---- 响应侧：归一化 ----

/**
 * 归一化 usage：把 DeepSeek 的 prompt_cache_hit_tokens /
 * prompt_cache_miss_tokens 收敛成统一字段。
 * - inputTokens：总输入 token（= cacheHit + cacheMiss，若 provider 给出）
 * - cacheHitTokens / cacheMissTokens：输入中命中 / 未命中 prefix cache 的部分
 * - outputTokens：补全产出 token
 */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  totalTokens: number;
}

/**
 * 归一化响应：薄模型层对外的唯一返回形状。
 * costUsd 必填——每次响应都已用价格表算出成本。
 */
export interface NormalizedChatResponse {
  /** 裸 model id（请求里给的那个） */
  model: string;
  /** 助手消息（文本 + 可选 tool_calls） */
  message: AssistantMessage;
  /** 模型停止原因（stop / tool_calls / length 等，provider 原样透传） */
  finishReason: string | null;
  usage: NormalizedUsage;
  /** 本次调用成本（USD），由价格表计算，成本是一等公民 */
  costUsd: number;
}

/** 窄接口：runtime-core 只依赖它；DeepSeekClient 与 fake model 都实现它。 */
export interface ModelClient {
  chat(request: ChatRequest): Promise<NormalizedChatResponse>;
}
