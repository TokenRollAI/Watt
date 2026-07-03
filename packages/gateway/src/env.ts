/**
 * gateway 运行时环境绑定（wrangler.jsonc + secrets/vars）。
 *
 * 资源绑定见 wrangler.jsonc（provision 回填）。secrets（.dev.vars 本地 / wrangler secret 远端）：
 * - WATT_JWT_PRIVATE_JWK：平台 Ed25519 私钥的 JWK JSON 字符串（签发 token + 派生 JWKS 公钥）。
 *   本地测试用一把专用测试密钥（.dev.vars 白名单，见 scripts/gen-dev-vars.mjs）；生产走 wrangler secret。
 * - WATT_ADMIN_PRINCIPAL：初始 admin principal（§6.5c 种子引导），形如 "user:<id>"。
 * - WATT_JWT_ISSUER / WATT_JWT_AUDIENCE：可选，token 的 iss/aud（缺省用内置常量）。
 */

import type {
  Ai,
  D1Database,
  Fetcher,
  KVNamespace,
  Queue,
  R2Bucket,
  VectorizeIndex,
} from '@cloudflare/workers-types';
import type { ContextRegistry } from './context/context-registry.ts';
import type { EventRouter } from './event/event-router.ts';

// DurableObjectNamespace 用 tsconfig types 里的 @cloudflare/workers-types ambient global 声明
// （非 import 版本），与 vitest-pool-workers 的 runInDurableObject 期望的 DurableObjectStub
// 同源，避免 import 版本与 ambient 版本的 Disposable 分支类型冲突。

export interface Bindings {
  // D1
  DB_POLICIES: D1Database;
  DB_PROVIDERS: D1Database;
  DB_AUDIT: D1Database;
  DB_EVENTS: D1Database;
  // M3 Context structured provider（附B 未列专库 → 新建独立库 watt-context，doc-gap 候选）。
  DB_CONTEXT: D1Database;
  // KV
  KV_AUTHZ_CACHE: KVNamespace;
  KV_TENANTS: KVNamespace;
  // R2
  R2_CONTEXT_OBJECTS: R2Bucket;
  R2_ARTIFACTS: R2Bucket;
  // Queues
  QUEUE_EVENTS: Queue;
  // Durable Objects（M1 Event Bus 订阅表 + Session Mapper，Phase 2）
  EVENT_ROUTER: DurableObjectNamespace<EventRouter>;
  // Durable Objects（M3 Context namespace 挂载注册表 + TTL，Phase 3）
  CONTEXT_REGISTRY: DurableObjectNamespace<ContextRegistry>;
  // Vectorize（M3 vector Context provider，1024 维 bge-m3 cosine）
  VECTORIZE_CONTEXT: VectorizeIndex;
  // Workers AI（M3 vector provider embeddings，@cf/baai/bge-m3）
  AI: Ai;
  // Service binding（M4 Tool Gateway）：/htbp/tools/* 代理到独立 Worker watt-toolbridge
  // （集成方案 A；转发 + Check PEP + 错误形状转换在 http/tools-proxy.ts）。
  TOOLBRIDGE: Fetcher;

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
