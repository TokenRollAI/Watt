/**
 * WattError — 平台统一错误形状（Proto.md §0.2、传输绑定见 §11.3）。
 *
 * 7 个错误码 + HTTP 映射 + 重试约束。Proto §11.3 规定「错误：HTTP 状态码 + body 为
 * `WattError`」——即所有对外接口（HTBP 树、CLI、Gateway 路由）出错时**直接**返回裸
 * `WattError`（`{ code, message, retryable }`），**无信封**，HTTP 状态码按 CODE_TO_HTTP 映射。
 */

/** Proto §0.2：7 个规范错误码，不得扩展。 */
export const WATT_ERROR_CODES = [
  'not_found',
  'permission_denied',
  'invalid_argument',
  'conflict',
  'unavailable',
  'rate_limited',
  'internal',
] as const;

export type WattErrorCode = (typeof WATT_ERROR_CODES)[number];

/**
 * WattError 载荷（Proto §0.2）。
 * - `message`：面向 LLM / 人的可读解释。
 * - `retryable`：仅允许在 rate_limited / unavailable / internal 上为 true（见 RETRYABLE_CODES）。
 */
export interface WattError {
  code: WattErrorCode;
  message: string;
  retryable: boolean;
}

/**
 * Proto §0.2 规范性 HTTP 映射。
 * not_found→404 / permission_denied→403 / invalid_argument→400 /
 * conflict→409 / rate_limited→429 / unavailable→503 / internal→500。
 */
export const CODE_TO_HTTP: Record<WattErrorCode, number> = {
  not_found: 404,
  permission_denied: 403,
  invalid_argument: 400,
  conflict: 409,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

/** Proto §0.2：retryable=true 仅允许出现在这三个码上。 */
export const RETRYABLE_CODES: ReadonlySet<WattErrorCode> = new Set<WattErrorCode>([
  'rate_limited',
  'unavailable',
  'internal',
]);

/**
 * 构造一个 WattError。若 `retryable` 未显式传入，则按 RETRYABLE_CODES 推导。
 * 显式传 `retryable:true` 但 code 不允许重试时，强制降为 false（保持契约不变量）。
 */
export function wattError(code: WattErrorCode, message: string, retryable?: boolean): WattError {
  const canRetry = RETRYABLE_CODES.has(code);
  const resolved = retryable === undefined ? canRetry : retryable && canRetry;
  return { code, message, retryable: resolved };
}

/** 取某错误码对应的 HTTP 状态码。 */
export function httpStatusFor(code: WattErrorCode): number {
  return CODE_TO_HTTP[code];
}
