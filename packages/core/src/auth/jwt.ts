/**
 * JWT 签发/验签纯逻辑（Proto §6.4a / §6.5a / §11.2）。
 *
 * 算法：**Ed25519 (EdDSA)** —— 非对称。依据 §11.2：`jwksUrl` = `<base>/.well-known/jwks.json`
 * 供 Plugin 取公钥验签 platform-token，反推平台对外必须走非对称并经 JWKS 暴露公钥。
 *
 * 本模块只做无 I/O 的纯逻辑：密钥以参数注入（gateway 侧从 env/secret 读取后传入）。
 * 库：jose（LOOP 纪律 4：JWT/JWKS 用 jose，不手写签验）。
 *
 * Token 三型（本轮 user token 深度使用；agent/plugin token 只定义类型 + 签发函数）：
 * - user token（§6.5a）：仅 sub + roles + exp/iat/trace，**无 agent_ 段与 chain**。
 * - agent token（§6.4a）：加 agent_def/agent_inst/chain（RFC8693 委托语义）。
 * - plugin/platform-token（§11.2）：平台自签作 Bearer，Plugin 经 jwksUrl 验签。
 */

import {
  type CryptoKey,
  exportJWK,
  importJWK,
  type JWK,
  jwtVerify,
  type KeyObject,
  SignJWT,
} from 'jose';
import type { PrincipalRef, TokenClaims } from '../types.ts';

/** 平台采用的 JWT 签名算法（非对称，JWKS 暴露公钥）。 */
export const JWT_ALG = 'EdDSA' as const;

/** JWK 的 crv 值（Ed25519）。 */
export const JWT_CRV = 'Ed25519' as const;

/** jose 接受的签名/验签密钥形态。 */
export type SigningKey = CryptoKey | KeyObject | Uint8Array;

/** 签发一个 token 所需的密钥材料 + 元数据。 */
export interface PrivateKeyMaterial {
  /** 私钥（EdDSA），jose 可用于 SignJWT。 */
  key: SigningKey;
  /** JWKS 的 `kid`，写入 JWT header 供验签方选钥。 */
  kid: string;
}

/** 验签所需的公钥材料。 */
export interface PublicKeyMaterial {
  key: SigningKey;
  kid: string;
}

/**
 * user token 签发入参（§6.5a）。claims 仅 sub + roles + trace；exp/iat 由本函数补。
 */
export interface IssueUserTokenInput {
  /** principal，形如 "user:alice"（写入 sub）。 */
  principal: PrincipalRef;
  /** IdentityMapper.ResolvePrincipal 实时解析的 roles（§6.3：触发时实时解析，不快照）。 */
  roles: string[];
  /** 链路 traceId（写入 trace claim）。 */
  trace?: string;
  /** 有效期（秒），默认见 DEFAULT_USER_TOKEN_TTL_SEC。 */
  ttlSeconds?: number;
}

/**
 * agent token 签发入参（§6.4a）。本轮定义签发函数，深度使用留后续 Phase（Agent Runtime）。
 */
export interface IssueAgentTokenInput {
  principal: PrincipalRef;
  roles: string[];
  agentDef: string;
  agentInst: string;
  chain: string[];
  trace?: string;
  ttlSeconds?: number;
}

/** 平台签发的通用 issuer/audience 元数据（可注入以便多环境）。 */
export interface TokenMeta {
  issuer: string;
  audience: string;
}

/** user token 默认有效期：Dashboard/CLI 登录态，取 1 小时（短期，续签由后续 Phase 接）。 */
export const DEFAULT_USER_TOKEN_TTL_SEC = 60 * 60;

/** agent token 默认有效期：分钟级短期（§6.4a），取 5 分钟。 */
export const DEFAULT_AGENT_TOKEN_TTL_SEC = 5 * 60;

/** now() 注入点（秒级 epoch），默认取系统时钟；测试可注入固定时钟。 */
export type NowFn = () => number;

const defaultNow: NowFn = () => Math.floor(Date.now() / 1000);

/**
 * 签发 user token（§6.5a）。无 agent_ 段与 chain。
 * 私钥与 issuer/audience 注入；exp/iat 由 now + ttl 计算。
 */
export async function signUserToken(
  input: IssueUserTokenInput,
  priv: PrivateKeyMaterial,
  meta: TokenMeta,
  now: NowFn = defaultNow,
): Promise<string> {
  const iat = now();
  const ttl = input.ttlSeconds ?? DEFAULT_USER_TOKEN_TTL_SEC;
  const payload: Record<string, unknown> = {
    roles: input.roles,
  };
  if (input.trace !== undefined) payload.trace = input.trace;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: JWT_ALG, kid: priv.kid })
    .setSubject(input.principal)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttl)
    .setIssuer(meta.issuer)
    .setAudience(meta.audience)
    .sign(priv.key);
}

/**
 * 签发 agent token（§6.4a）。含 agent_def/agent_inst/chain。
 * 本轮提供签发能力，Agent Runtime 深度接入留后续 Phase。
 */
export async function signAgentToken(
  input: IssueAgentTokenInput,
  priv: PrivateKeyMaterial,
  meta: TokenMeta,
  now: NowFn = defaultNow,
): Promise<string> {
  const iat = now();
  const ttl = input.ttlSeconds ?? DEFAULT_AGENT_TOKEN_TTL_SEC;
  const payload: Record<string, unknown> = {
    roles: input.roles,
    agent_def: input.agentDef,
    agent_inst: input.agentInst,
    chain: input.chain,
  };
  if (input.trace !== undefined) payload.trace = input.trace;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: JWT_ALG, kid: priv.kid })
    .setSubject(input.principal)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttl)
    .setIssuer(meta.issuer)
    .setAudience(meta.audience)
    .sign(priv.key);
}

/** 验签结果：解出的 TokenClaims（已按 §6.4a 结构化，agent 段可缺省）。 */
export interface VerifiedToken {
  claims: TokenClaims;
}

/**
 * 验签并解出 claims（§6.4a/§6.5a）。
 * - 只接受 EdDSA（algorithms 白名单，防降级攻击）。
 * - 校验 exp（过期由 jose 抛错）、issuer、audience。
 * - 结构化为 TokenClaims：sub→sub、roles、agent_def/agent_inst/chain（缺省即 user token）、trace。
 * 验签失败/过期/错密钥 → jose 抛错，由调用方（认证中间件）转 401。
 */
export async function verifyToken(
  token: string,
  pub: PublicKeyMaterial,
  meta: TokenMeta,
): Promise<VerifiedToken> {
  const { payload } = await jwtVerify(token, pub.key, {
    algorithms: [JWT_ALG],
    issuer: meta.issuer,
    audience: meta.audience,
  });

  const sub = payload.sub;
  if (typeof sub !== 'string') {
    throw new Error('token missing sub claim');
  }
  const rolesRaw = payload.roles;
  const roles = Array.isArray(rolesRaw)
    ? rolesRaw.filter((r): r is string => typeof r === 'string')
    : [];

  const claims: TokenClaims = { sub, roles };
  if (typeof payload.agent_def === 'string') claims.agent_def = payload.agent_def;
  if (typeof payload.agent_inst === 'string') claims.agent_inst = payload.agent_inst;
  if (Array.isArray(payload.chain)) {
    claims.chain = payload.chain.filter((c): c is string => typeof c === 'string');
  }
  if (typeof payload.trace === 'string') claims.trace = payload.trace;

  return { claims };
}

/**
 * 从 JWK JSON（私钥）导入为签名密钥 + 派生公钥 JWK（用于 JWKS 暴露）。
 * gateway 侧从 secret `WATT_JWT_PRIVATE_JWK` 读入后调用。
 * 返回 { priv, publicJwk }：priv 供签发，publicJwk 经 /.well-known/jwks.json 暴露。
 */
export async function importPrivateJwk(
  jwk: JWK,
  kid: string,
): Promise<{ priv: PrivateKeyMaterial; publicJwk: JWK }> {
  const key = (await importJWK(jwk, JWT_ALG)) as SigningKey;
  // 派生公钥 JWK：从私钥 JWK 摘出公钥字段（Ed25519 公钥 = crv + x + kty），去掉私钥 d。
  const publicJwk: JWK = {
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    alg: JWT_ALG,
    use: 'sig',
    kid,
  };
  return { priv: { key, kid }, publicJwk };
}

/** 从公钥 JWK 导入为验签密钥。 */
export async function importPublicJwk(jwk: JWK, kid: string): Promise<PublicKeyMaterial> {
  const key = (await importJWK({ ...jwk, alg: JWT_ALG }, JWT_ALG)) as SigningKey;
  return { key, kid };
}

/** 把一个或多个公钥 JWK 组装成 JWKS 响应体（/.well-known/jwks.json）。 */
export function buildJwks(publicJwks: JWK[]): { keys: JWK[] } {
  return { keys: publicJwks };
}

export type { JWK };
export { exportJWK };
