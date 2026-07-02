/**
 * gateway 运行时环境绑定（wrangler.jsonc + secrets/vars）。
 *
 * 资源绑定见 wrangler.jsonc（provision 回填）。secrets（.dev.vars 本地 / wrangler secret 远端）：
 * - WATT_JWT_PRIVATE_JWK：平台 Ed25519 私钥的 JWK JSON 字符串（签发 token + 派生 JWKS 公钥）。
 *   本地测试用一把专用测试密钥（.dev.vars 白名单，见 scripts/gen-dev-vars.mjs）；生产走 wrangler secret。
 * - WATT_ADMIN_PRINCIPAL：初始 admin principal（§6.5c 种子引导），形如 "user:<id>"。
 * - WATT_JWT_ISSUER / WATT_JWT_AUDIENCE：可选，token 的 iss/aud（缺省用内置常量）。
 */

import type { D1Database, Fetcher, KVNamespace, Queue, R2Bucket } from '@cloudflare/workers-types';

export interface Bindings {
  // D1
  DB_POLICIES: D1Database;
  DB_PROVIDERS: D1Database;
  DB_AUDIT: D1Database;
  DB_EVENTS: D1Database;
  // KV
  KV_AUTHZ_CACHE: KVNamespace;
  KV_TENANTS: KVNamespace;
  // R2
  R2_CONTEXT_OBJECTS: R2Bucket;
  R2_ARTIFACTS: R2Bucket;
  // Queues
  QUEUE_EVENTS: Queue;
  // Vectorize（类型宽松，本 Phase 不用）
  VECTORIZE_CONTEXT: Fetcher;

  // secrets / vars
  WATT_JWT_PRIVATE_JWK?: string;
  WATT_ADMIN_PRINCIPAL?: string;
  WATT_JWT_ISSUER?: string;
  WATT_JWT_AUDIENCE?: string;
  /** 平台对外基址（device flow 的 verification_uri 组装用）；缺省取请求 origin。 */
  WATT_BASE_URL?: string;
}

/** token iss/aud 缺省值（与 core TokenMeta 对齐）。 */
export const DEFAULT_JWT_ISSUER = 'watt-platform';
export const DEFAULT_JWT_AUDIENCE = 'watt-api';

/** JWKS 的 kid（单钥场景固定；多钥轮换在后续 Phase）。 */
export const PLATFORM_KID = 'watt-platform-1';
