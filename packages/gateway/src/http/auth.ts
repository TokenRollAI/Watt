/**
 * 认证中间件（Proto §11.3a / §11.4a / §0.3）。
 *
 * 入站方向（客户端→平台，如 CLI）：CallContext 从 `Authorization: Bearer <token>` 的 JWT
 * claims 解出（§11.3a L970）——验签 → 构造 CallContext（sub→principal、roles、agent_*→agent 链、
 * trace→traceId）。无 token / 验签失败 / 过期 → 401 + 裸 WattError（不进 Authorizer）。
 *
 * X-Watt-Trace 头存在则透传作 traceId（§11.4a）；否则用 token 的 trace claim；再否则生成。
 */

import type { CallContext, TokenClaims } from '@watt/core';
import { verifyToken } from '@watt/core';
import type { Context, MiddlewareHandler } from 'hono';
import { loadPlatformKeys } from '../authz/keys.ts';
import type { Bindings } from '../env.ts';
import { unauthenticatedResponse } from './errors.ts';

/** Hono context 变量：验签后的 claims + 构造的 CallContext。 */
export interface AuthVars {
  claims: TokenClaims;
  callContext: CallContext;
}

/** 从 claims + trace 头构造 CallContext（§0.3）。 */
export function buildCallContext(
  claims: TokenClaims,
  traceHeader: string | undefined,
): CallContext {
  const traceId = traceHeader ?? claims.trace ?? crypto.randomUUID();
  const ctx: CallContext = {
    principal: claims.sub,
    roles: claims.roles,
    traceId,
  };
  // agent 段仅 agent token 有（§6.4a）；user token 缺省不设 agent。
  if (claims.agent_def !== undefined && claims.agent_inst !== undefined) {
    ctx.agent = { instanceId: claims.agent_inst, chain: claims.chain ?? [] };
  }
  return ctx;
}

function extractBearer(c: Context): string | null {
  const auth = c.req.header('Authorization') ?? c.req.header('authorization');
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ? m[1].trim() : null;
}

/**
 * 认证中间件。验签通过则把 claims + callContext 塞进 c.var，放行；否则 401 裸 WattError。
 */
export function authMiddleware(): MiddlewareHandler<{
  Bindings: Bindings;
  Variables: AuthVars;
}> {
  return async (c, next) => {
    const token = extractBearer(c);
    if (!token) {
      return unauthenticatedResponse(c, 'missing Bearer token');
    }
    let keys: Awaited<ReturnType<typeof loadPlatformKeys>>;
    try {
      keys = await loadPlatformKeys(c.env);
    } catch {
      // 密钥未配置属服务端问题；但对未认证请求仍统一按 401（不泄露内部状态）。
      return unauthenticatedResponse(c, 'authentication is not available');
    }
    let claims: TokenClaims;
    try {
      const verified = await verifyToken(token, keys.pub, keys.meta);
      claims = verified.claims;
    } catch {
      return unauthenticatedResponse(c, 'invalid or expired token');
    }
    c.set('claims', claims);
    c.set('callContext', buildCallContext(claims, c.req.header('X-Watt-Trace')));
    await next();
  };
}
