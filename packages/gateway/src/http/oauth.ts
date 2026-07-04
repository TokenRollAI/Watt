/**
 * CLI 设备授权端点（Proto §6.5d，RFC 8628 Device Authorization Grant 最小子集）。
 *
 * 端点（挂平台根）：
 * - POST /oauth/device/authorize（无认证）→ {device_code,user_code,verification_uri,expires_in,interval}
 * - POST /oauth/device/approve（需 admin token + Check(platform://policy,'manage')）→ 绑定 user_code→principal
 * - POST /oauth/token（无认证）→ pending 时 400 {error:"authorization_pending"}；approved → 签发 user token
 *
 * 关键契约（§6.5d）：**OAuth 端点整体在 WattError 契约之外**——错误体走 RFC 8628 §3.5
 * 的 OAuth 形状 `{error:"...", error_description?}`（HTTP 400），而非裸 WattError。
 * 唯一例外：approve 端点需认证 + 授权，其"未认证/无权"沿用平台 WattError（401/403），
 * 因为 approve 是平台管理动作（admin 代确认），不属 RFC 8628 的 CLI↔平台 OAuth 交互面。
 *
 * grant 存储：KV（DeviceGrantStore，见 device-store.ts）。roles 换 token 时经
 * IdentityMapper.ResolvePrincipal 实时解析（§6.3 / §6.5a）。
 */

import {
  createDeviceGrant,
  DEVICE_GRANT_TYPE,
  evaluateTokenExchange,
  normalizeUserCode,
  type OAuthErrorBody,
  oauthError,
  signUserToken,
} from '@watt/core';
import { wattError } from '@watt/shared';
import { Hono } from 'hono';
import { newAuthorizer } from '../audit/audit-sink.ts';
import { DeviceGrantStore } from '../authz/device-store.ts';
import { IdentityMapper } from '../authz/identity-mapper.ts';
import { loadPlatformKeys } from '../authz/keys.ts';
import { PolicyStore } from '../authz/policy-store.ts';
import { ensureSeedPolicy } from '../authz/seed.ts';
import type { Bindings } from '../env.ts';
import { type AuthVars, authMiddleware } from './auth.ts';
import { forbiddenResponse, wattErrorResponse } from './errors.ts';

const RES_POLICY = 'platform://policy';

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** OAuth 错误应答（RFC 8628 §3.5 形状，HTTP 400，非 WattError；§6.5d 豁免）。 */
function oauthErrorResponse(
  // biome-ignore lint/suspicious/noExplicitAny: Hono context 泛型在此不需精确。
  c: any,
  body: OAuthErrorBody,
): Response {
  return c.json(body, 400);
}

export function oauthRoutes(): Hono<{ Bindings: Bindings; Variables: AuthVars }> {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVars }>();

  // ── POST /oauth/device/authorize（无认证）───────────────────────────────
  app.post('/oauth/device/authorize', async (c) => {
    const now = nowSec();
    // verification_uri：Dashboard 未上线，指向平台根的 /device 提示页（§6.5d：
    // 允许 admin 用已有 token 调 approve 代替浏览器确认）。
    const base = c.env.WATT_BASE_URL ?? new URL(c.req.url).origin;
    const verificationUri = `${base.replace(/\/+$/, '')}/device`;
    const { grant, response } = createDeviceGrant({ verificationUri, now: () => now });
    const store = new DeviceGrantStore(c.env.KV_TENANTS);
    await store.put(grant, now);
    return c.json(response);
  });

  // ── POST /oauth/device/approve（需 admin token + Check）──────────────────
  // 认证/授权走平台 WattError（这是平台管理动作，不是 RFC 8628 的 OAuth 交互面）。
  app.use('/oauth/device/approve', authMiddleware());
  app.use('/oauth/device/approve', async (c, next) => {
    // 种子引导幂等（与 platform 路由一致），保证 admin 首次可用。
    const policies = new PolicyStore(c.env.DB_POLICIES);
    const identities = new IdentityMapper(c.env.DB_POLICIES);
    await ensureSeedPolicy(policies, identities, c.env.WATT_ADMIN_PRINCIPAL);
    await next();
  });
  app.post('/oauth/device/approve', async (c) => {
    const claims = c.get('claims');
    const authorizer = newAuthorizer(c.env, c.get('callContext').traceId);
    // approve = 授予某 principal 一个 token，视为平台管理动作 → Check(platform://policy,'manage')。
    const decision = await authorizer.check(claims, RES_POLICY, 'manage');
    if (!decision.allow) {
      return forbiddenResponse(c, decision.reason ?? 'not authorized to approve device grants');
    }

    let body: { user_code?: unknown; principal?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', 'request body must be JSON', false),
      );
    }
    const userCode = typeof body.user_code === 'string' ? normalizeUserCode(body.user_code) : '';
    if (!userCode) {
      return wattErrorResponse(c, wattError('invalid_argument', 'user_code is required', false));
    }
    // principal 缺省时默认绑定为当前调用者本人（admin 自助登录常见路径）。
    const principal =
      typeof body.principal === 'string' && body.principal.trim()
        ? body.principal.trim()
        : claims.sub;

    const store = new DeviceGrantStore(c.env.KV_TENANTS);
    const grant = await store.getByUserCode(userCode);
    const now = nowSec();
    if (grant === undefined) {
      return wattErrorResponse(c, wattError('not_found', `unknown user_code: ${userCode}`, false));
    }
    if (now >= grant.expiresAt) {
      return wattErrorResponse(c, wattError('not_found', 'user_code has expired', false));
    }
    if (grant.status === 'approved') {
      // 重复 approve 幂等：已批准则原样返回（不改绑定）。
      return c.json({ approved: true, principal: grant.principal, alreadyApproved: true });
    }
    grant.status = 'approved';
    grant.principal = principal;
    await store.update(grant, now);
    return c.json({ approved: true, principal });
  });

  // ── POST /oauth/token（无认证）──────────────────────────────────────────
  app.post('/oauth/token', async (c) => {
    let body: { grant_type?: unknown; device_code?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return oauthErrorResponse(c, oauthError('invalid_request', 'request body must be JSON'));
    }
    if (body.grant_type !== DEVICE_GRANT_TYPE) {
      return oauthErrorResponse(
        c,
        oauthError('invalid_request', `unsupported grant_type: ${String(body.grant_type)}`),
      );
    }
    const deviceCode = typeof body.device_code === 'string' ? body.device_code : '';
    if (!deviceCode) {
      return oauthErrorResponse(c, oauthError('invalid_request', 'device_code is required'));
    }

    const store = new DeviceGrantStore(c.env.KV_TENANTS);
    const grant = await store.getByDeviceCode(deviceCode);
    const now = nowSec();
    const outcome = evaluateTokenExchange(grant, now);

    switch (outcome.kind) {
      case 'pending':
        return oauthErrorResponse(c, oauthError('authorization_pending'));
      case 'expired':
        return oauthErrorResponse(c, oauthError('expired_token', 'the device_code has expired'));
      case 'invalid_grant':
        return oauthErrorResponse(
          c,
          oauthError('invalid_grant', 'unknown or consumed device_code'),
        );
      case 'approved': {
        // 签发 user token（§6.5a）：roles 经 ResolvePrincipal 实时解析（§6.3）。
        let keys: Awaited<ReturnType<typeof loadPlatformKeys>>;
        try {
          keys = await loadPlatformKeys(c.env);
        } catch {
          // 密钥缺失属服务端问题——OAuth 端点仍走 OAuth 形状（500 级用 invalid_request 兜底较弱，
          // 但此路径要求平台配置就绪；返回 400 invalid_request + 描述）。
          return oauthErrorResponse(c, oauthError('invalid_request', 'signing key unavailable'));
        }
        const identities = new IdentityMapper(c.env.DB_POLICIES);
        const { roles } = await identities.resolvePrincipal(outcome.principal);
        const token = await signUserToken(
          { principal: outcome.principal, roles, trace: crypto.randomUUID() },
          keys.priv,
          keys.meta,
        );
        // §6.5d device_code 一次性使用：签发成功后消费 grant（失败路径不消费，
        // 保留 CLI 重试机会）。grant 此处必非空（evaluateTokenExchange 已判定 approved）。
        if (grant !== undefined) await store.delete(grant);
        return c.json({
          access_token: token,
          token_type: 'Bearer',
          expires_in: 60 * 60,
        });
      }
    }
  });

  // ── POST /oauth/root/token（无认证；Root Key 换发 admin token，§6.5e）────────
  // Root Key 明文只在换发请求 body 里出现一次；平台只存 SHA-256 摘要（WATT_ROOT_KEY_HASH）。
  // 摘要比对天然常数时间（先哈希再等长比较）；成功/失败都写 AuditRecord（resource
  // platform://auth，action root-exchange）。JWT 私钥轮换不影响 Root Key（§6.5e 解耦语义）。
  app.post('/oauth/root/token', async (c) => {
    const configuredHash = c.env.WATT_ROOT_KEY_HASH;
    let body: { root_key?: unknown; ttl_sec?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return oauthErrorResponse(c, oauthError('invalid_request', 'request body must be JSON'));
    }
    const rootKey = typeof body.root_key === 'string' ? body.root_key : '';
    if (!rootKey) {
      return oauthErrorResponse(c, oauthError('invalid_request', 'root_key is required'));
    }
    if (configuredHash === undefined || configuredHash.length === 0) {
      // 功能未启用：与"不匹配"用不同错误码（§6.5e 允许区分未启用），但不含更多细节。
      return oauthErrorResponse(c, oauthError('invalid_request', 'root key is not configured'));
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rootKey));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const ok = hex === configuredHash.toLowerCase();

    // 审计（成功/失败都写；best-effort 不阻塞）。
    try {
      const { AuditStore } = await import('../audit/audit-store.ts');
      await new AuditStore(c.env.DB_AUDIT).write({
        context: {
          principal: ok ? (c.env.WATT_ADMIN_PRINCIPAL ?? 'user:admin') : 'user:unknown',
          roles: [],
          traceId: c.req.header('X-Watt-Trace') ?? crypto.randomUUID(),
        },
        resource: 'platform://auth',
        action: 'root-exchange',
        decision: ok ? 'allow' : 'deny',
      });
    } catch (err) {
      console.error('root-exchange audit write failed', { err: String(err) });
    }
    if (!ok) {
      return c.json(oauthError('invalid_grant', 'root key mismatch'), 401);
    }

    // 换发：TTL 缺省 7d、上限 30d（§6.5e）；roles 经 ResolvePrincipal 实时解析（§6.3）。
    const DEFAULT_TTL = 7 * 24 * 3600;
    const MAX_TTL = 30 * 24 * 3600;
    const ttlRaw = typeof body.ttl_sec === 'number' ? Math.floor(body.ttl_sec) : DEFAULT_TTL;
    const ttlSec = Math.min(Math.max(ttlRaw, 60), MAX_TTL);
    let keys: Awaited<ReturnType<typeof loadPlatformKeys>>;
    try {
      keys = await loadPlatformKeys(c.env);
    } catch {
      return oauthErrorResponse(c, oauthError('invalid_request', 'signing key unavailable'));
    }
    const principal = c.env.WATT_ADMIN_PRINCIPAL ?? 'user:admin';
    // 种子引导幂等（首次换发时 admin 角色绑定可能尚未建立）。
    const policies = new PolicyStore(c.env.DB_POLICIES);
    const identities = new IdentityMapper(c.env.DB_POLICIES);
    await ensureSeedPolicy(policies, identities, c.env.WATT_ADMIN_PRINCIPAL);
    const { roles } = await identities.resolvePrincipal(principal);
    const token = await signUserToken(
      { principal, roles, trace: crypto.randomUUID(), ttlSeconds: ttlSec },
      keys.priv,
      keys.meta,
    );
    return c.json({ access_token: token, token_type: 'Bearer', expires_in: ttlSec });
  });

  return app;
}
