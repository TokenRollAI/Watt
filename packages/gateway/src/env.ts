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
  AnalyticsEngineDataset,
  D1Database,
  Fetcher,
  KVNamespace,
  Queue,
  R2Bucket,
  VectorizeIndex,
} from '@cloudflare/workers-types';
import type { AgentCorrelation } from './agent/agent-correlation.ts';
import type { AgentInstance } from './agent/agent-instance.ts';
import type { ContextRegistry } from './context/context-registry.ts';
import type { EventRouter } from './event/event-router.ts';
import type { SchedulerHub } from './scheduler/scheduler-hub.ts';
import type { TaskWorkflowParams } from './task/watt-task-workflow.ts';

// DurableObjectNamespace 用 tsconfig types 里的 @cloudflare/workers-types ambient global 声明
// （非 import 版本），与 vitest-pool-workers 的 runInDurableObject 期望的 DurableObjectStub
// 同源，避免 import 版本与 ambient 版本的 Disposable 分支类型冲突。
// Workflow<PARAMS> 同理用 ambient global（@cloudflare/workers-types index.d.ts 的 declare abstract
// class Workflow）——非 module export，不能 import，与 DurableObjectNamespace 同源处理。

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
  // Service binding（M11 channel-adapter plugin，平台内 Worker 推荐形态）：watt-plugin-feishu。
  //   同账户 workers.dev 互调被平台拦截（404），故不用 HTTPS endpoint；plugin-sender 按注册 endpoint
  //   `binding:FEISHU_PLUGIN` 动态查 env 取此 Fetcher。可选绑定（未部署 plugin 的环境可从 wrangler.jsonc 移除）。
  FEISHU_PLUGIN?: Fetcher;
  // Durable Objects（M2 Agent Runtime，Phase 4）
  //   AGENT_INSTANCE：Agents SDK Agent 实例宿主（每实例一 DO，getAgentByName 恒路由同实例）。
  //   AGENT_CORRELATION：correlation 等待表（§3.4 定向回送/超时/终止代发，单例 idFromName('correlation')）。
  AGENT_INSTANCE: DurableObjectNamespace<AgentInstance>;
  AGENT_CORRELATION: DurableObjectNamespace<AgentCorrelation>;

  // Durable Objects（M6 Scheduler，Phase 5）：SchedulerHub（Agents SDK Agent + this.schedule；
  //   全部 CronJob 存单例 Hub，getAgentByName('hub')，附B SchedulerHub）。到点触发走三 action
  //   （publish|agent|script）+ cron.fired/completed 双留痕（src/scheduler/actions.ts）。
  SCHEDULER_HUB: DurableObjectNamespace<SchedulerHub>;

  // Workflows（M7 Task 引擎，Phase 5）：WattTaskWorkflow（§8 TaskManager / §3.4 Workflows 适配）。
  //   TaskManager 服务经 env.WATT_TASK.create/get/... 编排任务实例；params 见 watt-task-workflow.ts。
  WATT_TASK: Workflow<TaskWorkflowParams>;

  // Analytics Engine（M9 Metrics 时序采集面，Phase 6 R23）：每次模型调用 writeDataPoint 并行打点
  //   （token/cost 高基数时序）。dataset watt_metrics；绑定无需 provision 创建（写入时自建 dataset）。
  //   可选：本地 miniflare 该绑定为 no-op（单测 spy），真实查询走远端 AE SQL API（@metrics 部署冒烟）。
  AE_METRICS?: AnalyticsEngineDataset;

  // secrets / vars
  WATT_JWT_PRIVATE_JWK?: string;
  WATT_ADMIN_PRINCIPAL?: string;
  WATT_JWT_ISSUER?: string;
  WATT_JWT_AUDIENCE?: string;
  /**
   * SecretStore 主密钥（§6.6）——32 字节 base64url，AES-256-GCM 加密运行时密钥。部署期 secret。
   * 缺失 → /htbp/platform/secret 返回 unavailable、resolveSecret 静默跳过 KV 分支（env-only 零回归）。
   * **不从 JWT 私钥派生**（JWT 轮换会静默毁掉全部密文）；与 WATT_JWT_PRIVATE_JWK 同为信任根、env-only。
   */
  WATT_SECRET_ENCRYPTION_KEY?: string;
  /** 平台对外基址（device flow 的 verification_uri 组装用）；缺省取请求 origin。 */
  WATT_BASE_URL?: string;
  /**
   * Dashboard 允许的 CORS origin（M10 Dashboard）——逗号分隔的精确 origin 白名单（如
   * "https://watt-dashboard.pages.dev,http://localhost:5173"）。缺省时仅放行 *.pages.dev（Pages 部署域）
   *   + localhost（开发）。用于浏览器 SPA 跨源调 /htbp/platform/* + Authorization header 预检（见 http/index.ts）。
   */
  WATT_DASHBOARD_ORIGIN?: string;
  /** 模型中转 key（§9 / DoD §6 项3 @llm）——Anthropic Messages 格式，x-api-key。 */
  ANTHROPIC_API_KEY?: string;
  /** 模型中转基址（缺省 https://llm.fantacy.live）。 */
  ANTHROPIC_BASE_URL?: string;
  /** lurker scratch namespace TTL 秒（正整数串）——缺省 120（保 E2E 分钟级过期断言）；生产设 3600。 */
  LURKER_SCRATCH_TTL_SEC?: string;
  /** Root Key 的 SHA-256 摘要（hex，§6.5e）——明文永不进平台；缺省则 /oauth/root/token 报未启用。
   *  设置：scripts/set-root-key.mjs（生成/覆写，明文仅展示一次）或 watt init 向导。 */
  WATT_ROOT_KEY_HASH?: string;
  // 飞书凭据（FEISHU_APP_ID/SECRET/BASE_URL）已随 P1 飞书 plugin 化迁往 watt-plugin-feishu Worker 自持——
  //   gateway 出站经通用分发器（event/plugin-sender.ts）§11.4 调 channel-adapter plugin，不再持有渠道凭据。
}

/** token iss/aud 缺省值（与 core TokenMeta 对齐）。 */
export const DEFAULT_JWT_ISSUER = 'watt-platform';
export const DEFAULT_JWT_AUDIENCE = 'watt-api';

/** JWKS 的 kid（单钥场景固定；多钥轮换在后续 Phase）。 */
export const PLATFORM_KID = 'watt-platform-1';
