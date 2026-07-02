/**
 * 平台 JWT 密钥加载（gateway 侧 I/O 边界）。
 *
 * 从 env.WATT_JWT_PRIVATE_JWK（wrangler secret / .dev.vars）读入 Ed25519 私钥 JWK JSON，
 * 用 @watt/core 的 importPrivateJwk 导入为签名密钥 + 派生公钥 JWK（供 JWKS 暴露）。
 * 缺失/畸形 secret → 抛错（认证与 JWKS 路由会转 unavailable/500）。
 *
 * 纯签发/验签逻辑在 core；此处只负责"从环境读密钥"这一 I/O（LOOP 目标分工）。
 */

import {
  buildJwks,
  importPrivateJwk,
  importPublicJwk,
  type JWK,
  type PrivateKeyMaterial,
  type PublicKeyMaterial,
  type TokenMeta,
} from '@watt/core';
import type { Bindings } from '../env.ts';
import { DEFAULT_JWT_AUDIENCE, DEFAULT_JWT_ISSUER, PLATFORM_KID } from '../env.ts';

export interface PlatformKeys {
  priv: PrivateKeyMaterial;
  pub: PublicKeyMaterial;
  publicJwk: JWK;
  meta: TokenMeta;
}

/** 从 env 加载平台密钥 + token 元数据。每请求可调用（jose 导入很轻）；后续可加缓存。 */
export async function loadPlatformKeys(env: Bindings): Promise<PlatformKeys> {
  const raw = env.WATT_JWT_PRIVATE_JWK;
  if (!raw) {
    throw new Error('WATT_JWT_PRIVATE_JWK is not configured');
  }
  let jwk: JWK;
  try {
    jwk = JSON.parse(raw) as JWK;
  } catch {
    throw new Error('WATT_JWT_PRIVATE_JWK is not valid JSON');
  }
  const { priv, publicJwk } = await importPrivateJwk(jwk, PLATFORM_KID);
  const pub = await importPublicJwk(publicJwk, PLATFORM_KID);
  const meta: TokenMeta = {
    issuer: env.WATT_JWT_ISSUER ?? DEFAULT_JWT_ISSUER,
    audience: env.WATT_JWT_AUDIENCE ?? DEFAULT_JWT_AUDIENCE,
  };
  return { priv, pub, publicJwk, meta };
}

/** 构造 /.well-known/jwks.json 响应体（公钥集）。 */
export function jwksResponse(keys: PlatformKeys): { keys: JWK[] } {
  return buildJwks([keys.publicJwk]);
}
