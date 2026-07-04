/**
 * init 向导：信任根密钥的本地生成与首 admin token 签发（P5，计划 §P5——消解鸡生蛋）。
 *
 * 三个信任根 secret（Proto §11.2 / §6.6）：
 *   - WATT_JWT_PRIVATE_JWK          —— 平台 Ed25519 私钥 JWK（签发 user token + 派生 JWKS 公钥）
 *   - WATT_SECRET_ENCRYPTION_KEY    —— SecretStore AES-256-GCM 主密钥（32B base64url）
 *   - WATT_ADMIN_PRINCIPAL          —— 种子引导初始 admin principal（§6.5c）
 *
 * 首 admin 引导：init 生成 JWK 时**同进程内存中先签一个 admin token（7d exp）**再 wrangler secret put
 *   再丢弃私钥——首次部署无存量 token 可吊销，零轮换（对比 sign-admin-token.mjs 的 --rotate）。
 *   签发常量与 gateway 对齐（packages/gateway/src/env.ts）：issuer=watt-platform / audience=watt-api /
 *   kid=watt-platform-1 / alg=EdDSA。§6.5a：仅 sub + roles + iat/exp/trace。
 *
 * 本模块纯密码学 + jose（无 IO、无 spawn），便于单测：生成 JWK → 签 token → 同 JWK 公钥可验证。
 */

import { exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT } from 'jose';

// 签名密钥类型（从 jose 派生，避免直接引用 DOM 的 CryptoKey 全局——本工程 lib=ES2023 无 DOM）。
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

// gateway 侧常量真源：packages/gateway/src/env.ts（DEFAULT_JWT_ISSUER/AUDIENCE/PLATFORM_KID）。
export const JWT_ISSUER = 'watt-platform';
export const JWT_AUDIENCE = 'watt-api';
export const PLATFORM_KID = 'watt-platform-1';
export const ADMIN_TOKEN_TTL_SEC = 7 * 24 * 60 * 60; // 7d

export interface GeneratedTrustRoot {
  /** 私钥 JWK JSON（喂 wrangler secret put WATT_JWT_PRIVATE_JWK；用后即丢，不落盘）。 */
  privateJwkJson: string;
  /** SecretStore AES-256-GCM 主密钥（32B base64url；喂 WATT_SECRET_ENCRYPTION_KEY）。 */
  encryptionKey: string;
  /** 首 admin token（7d；写 ~/.watt/credentials.json，供后续 CLI 调用）。 */
  adminToken: string;
}

/** 生成信任根三件套 + 首 admin token（同进程内签发后私钥即丢弃）。 */
export async function generateTrustRoot(adminPrincipal: string): Promise<GeneratedTrustRoot> {
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const jwk = await exportJWK(privateKey);
  const privateJwkJson = JSON.stringify(jwk);

  const adminToken = await signAdminToken(privateKey, adminPrincipal);

  // AES-256-GCM 主密钥：32 随机字节 → base64url（与 gateway SecretStore 约定一致）。
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const encryptionKey = base64url(raw);

  return { privateJwkJson, encryptionKey, adminToken };
}

/** 用给定私钥（SigningKey 或私钥 JWK JSON）签一个 admin token（roles=["admin"]，7d）。 */
export async function signAdminToken(
  privateKey: SigningKey | string,
  adminPrincipal: string,
  ttlSec: number = ADMIN_TOKEN_TTL_SEC,
): Promise<string> {
  const key =
    typeof privateKey === 'string' ? await importJWK(JSON.parse(privateKey), 'EdDSA') : privateKey;
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({ roles: ['admin'], trace: `watt-init-${nowSec}` })
    .setProtectedHeader({ alg: 'EdDSA', kid: PLATFORM_KID })
    .setSubject(adminPrincipal)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ttlSec)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .sign(key);
}

/** 从私钥 JWK JSON 派生对应公钥 JWK（用于验证/JWKS 传播判据的 `x` 比对）。 */
export async function publicJwkFromPrivate(
  privateJwkJson: string,
): Promise<{ x?: string; kty?: string; crv?: string }> {
  const jwk = JSON.parse(privateJwkJson) as Record<string, unknown>;
  // Ed25519 私钥 JWK 的公钥部分 = 去掉私钥分量 `d`。
  const { d: _d, ...pub } = jwk;
  return pub as { x?: string; kty?: string; crv?: string };
}

/** 校验一个 token 能被给定私钥 JWK 对应的公钥验证（单测/自检用）。返回 payload。 */
export async function verifyWithJwk(
  token: string,
  privateJwkJson: string,
): Promise<{ sub?: string; roles?: unknown }> {
  const pub = await publicJwkFromPrivate(privateJwkJson);
  const key = await importJWK({ ...pub, alg: 'EdDSA' }, 'EdDSA');
  const { payload } = await jwtVerify(token, key, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
  return payload as { sub?: string; roles?: unknown };
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
