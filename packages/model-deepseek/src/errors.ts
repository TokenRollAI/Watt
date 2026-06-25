/**
 * 薄模型层的类型化错误。
 *
 * 形状与 @watt/protocol 的 TypedError（{ code, message }）对齐，便于上层
 * 直接把 code/message 透传进 AgentRunResult.error。
 *
 * 错误分类：
 * - transient（瞬时）：429 / 5xx / 网络错误，应被重试。
 * - non-transient（非瞬时）：4xx（除 429），不应重试，直接上抛。
 */

/** 类型化错误码（窄枚举，code 与 protocol TypedError 兼容） */
export type ModelErrorCode =
  | 'ModelHttpError' // HTTP 非 2xx
  | 'ModelNetworkError' // fetch 抛错（断网 / DNS / 超时等）
  | 'ModelResponseInvalid' // 响应体结构非预期
  | 'ModelRetryExhausted'; // 重试次数耗尽后仍失败

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  /** HTTP 状态码（若由 HTTP 响应产生） */
  readonly status?: number;
  /** 是否瞬时（可重试） */
  readonly transient: boolean;
  /** 触发本错误的底层 cause（如网络异常） */
  override readonly cause?: unknown;

  constructor(args: {
    code: ModelErrorCode;
    message: string;
    status?: number;
    transient: boolean;
    cause?: unknown;
  }) {
    super(args.message);
    this.name = 'ModelError';
    this.code = args.code;
    this.status = args.status;
    this.transient = args.transient;
    this.cause = args.cause;
  }

  /** 转成 protocol TypedError 形状（{ code, message }） */
  toTypedError(): { code: string; message: string } {
    return { code: this.code, message: this.message };
  }
}

/** HTTP 状态码是否瞬时（可重试）：429 与 5xx 瞬时，其余 4xx 非瞬时。 */
export function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}
