/**
 * WattError ↔ HTTP 响应（Proto §0.2 / §11.3 / bare-watterror-body 决策）。
 *
 * 错误响应 body = 裸 WattError（{code,message,retryable}），无信封；HTTP 状态按 CODE_TO_HTTP。
 * 401 未认证：WattError 7 码无 "unauthenticated" 码，§0.2 无 401 映射——按 Proto §0.2 规范性补充
 * （bare-watterror-body 决策 / doc-gap #17 类）：未认证 → HTTP 401 + body code=permission_denied。
 * 认证中间件在解 token 前拦截，不进 Authorizer。
 */

import { httpStatusFor, type WattError, wattError } from '@watt/shared';
import type { Context } from 'hono';

/** 把 WattError 写成裸 body + 映射的 HTTP 状态（403 等）。 */
export function wattErrorResponse(c: Context, err: WattError): Response {
  // biome-ignore lint/suspicious/noExplicitAny: Hono 的 status 需要窄类型，运行时值来自规范映射表。
  return c.json(err, httpStatusFor(err.code) as any);
}

/** 401 未认证：裸 body code=permission_denied，HTTP 状态强制 401（§0.2 补充）。 */
export function unauthenticatedResponse(c: Context, message: string): Response {
  const err = wattError('permission_denied', message, false);
  // biome-ignore lint/suspicious/noExplicitAny: 401 非 code 的默认映射（403），此处显式覆盖为 401。
  return c.json(err, 401 as any);
}

/** 403 已认证但无权（Authorizer deny）。 */
export function forbiddenResponse(c: Context, message: string): Response {
  return wattErrorResponse(c, wattError('permission_denied', message, false));
}
