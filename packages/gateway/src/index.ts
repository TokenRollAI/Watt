import type { WattError } from '@watt/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import pkg from '../package.json' with { type: 'json' };
import type { Bindings } from './env.ts';
import { defaultConsumerDeps, handleQueue } from './event/consumer.ts';
import type { AuthVars } from './http/auth.ts';
import { contextRoutes } from './http/context-routes.ts';
import { inboundRoutes } from './http/inbound.ts';
import { oauthRoutes } from './http/oauth.ts';
import { platformRoutes } from './http/routes.ts';
import { toolsProxyRoutes } from './http/tools-proxy.ts';

// MessageBatch 用 @cloudflare/workers-types ambient global（tsconfig types）。

// ContextRegistry DO（M3 namespace 挂载注册表 + TTL）从入口 export，供 wrangler DO 绑定实例化。
export { ContextRegistry } from './context/context-registry.ts';
// EventRouter DO（M1 订阅表 + Session Mapper）从入口 export，供 wrangler DO 绑定实例化。
export { EventRouter } from './event/event-router.ts';

/**
 * watt-gateway Worker。
 * 真源：DOD.md §2（Phase 0 骨架）、§3（Phase 1 Auth 内核 + Platform API）。
 * Phase 0：healthz + inbound 占位。Phase 1：JWKS + Platform API（whoami/policy/audit）+ 认证。
 */

const app = new Hono<{ Bindings: Bindings; Variables: AuthVars }>();

/** GET /healthz — 健康探针（DOD §2、Phase 0 DoD 项 3）。 */
app.get('/healthz', (c) => {
  return c.json({
    ok: true,
    version: pkg.version,
    service: 'watt-gateway',
  });
});

/**
 * POST /channels/:channelId/inbound — 通用 webhook 入站（Phase 2 / Event Gateway）。
 * 无认证（验签即认证，§2.1）；飞书走 WebSocket push 型不经此入口。实现见 http/inbound.ts。
 * 显式注册在规范树占位与认证中间件之前（此路径不经 platform 认证）。
 */
app.route('/', inboundRoutes());

/**
 * 规范树占位（§11.3a）：这些子树在宪法里声明存在，但对应模块尚未落地。
 * 显式注册在业务路由之前、且**不经认证中间件**（未实现的路径认证无意义，501 优先于 401）——
 * 否则 `/htbp/platform/*` 会先被 platformRoutes 的认证中间件拦成 401。
 * 命中 → 501 unavailable、retryable:false（"重试无意义，需等实现落地"，Proto §0.2 补充）。
 * 注意：`/htbp/platform/event` 已在 Phase 2 落地（platformRoutes），从此表移除。
 * 注意：`/htbp/context` 已在 Phase 3 落地（contextRoutes 消费面 + platformRoutes 管理面），从此表移除。
 * 注意：`/htbp/tools` 已在 Phase 4 落地（toolsProxyRoutes 消费面代理到 watt-toolbridge），从此表移除。
 */
const SPEC_TREE_PREFIXES = [
  '/htbp/platform/agent',
  '/htbp/platform/task',
  '/htbp/platform/scheduler',
];

for (const prefix of SPEC_TREE_PREFIXES) {
  const handler = (c: Context) => {
    const body: WattError = {
      code: 'unavailable',
      message: `${new URL(c.req.url).pathname} is a specified route that is not implemented yet.`,
      retryable: false,
    };
    return c.json(body, 501);
  };
  app.all(prefix, handler);
  app.all(`${prefix}/*`, handler);
}

// Phase 1：JWKS + Platform API（认证 + Authorizer + PolicyStore）。
app.route('/', platformRoutes());

// Phase 3：Context Layer 消费面（§4.1 四动词 + Search + ~help）。
// contextRoutes 内部自管认证顺序：GET .../~help 免认证注册在认证中间件之前（§11.3a 渐进发现）。
app.route('/', contextRoutes());

// Phase 4：Tool Layer 消费面（§5.1 List/描述/调用）——代理到 watt-toolbridge（service binding）。
// toolsProxyRoutes 内部认证 + Check PEP（tool://<path>）+ 错误形状转换 + ~help 可见性裁剪。
app.route('/', toolsProxyRoutes());

// Phase 1：CLI 设备授权 device flow（§6.5d，RFC 8628）。
app.route('/', oauthRoutes());

/**
 * notFound（Proto §0.2 补充 / §11.3 传输绑定）：未知路径统一裸 WattError body，无信封，
 * code not_found、retryable:false（规范树占位已由上方显式路由处理为 501）。
 */
app.notFound((c) => {
  const body: WattError = {
    code: 'not_found',
    message: `no route for ${c.req.method} ${new URL(c.req.url).pathname}`,
    retryable: false,
  };
  return c.json(body, 404);
});

/**
 * onError（Proto §0.2 / §11.3）：未捕获异常统一裸 WattError body，无信封。
 * HTTPException 先走其自身响应（认证/中间件等显式抛出的 HTTP 状态）；其余 → 500 internal，
 * message 不泄漏内部细节（内部错误经 console.error 记录 method/path/err）。
 */
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  const path = new URL(c.req.url).pathname;
  console.error('gateway unhandled error', { method: c.req.method, path, err });
  const body: WattError = {
    code: 'internal',
    message: 'internal error',
    retryable: true,
  };
  return c.json(body, 500);
});

/**
 * Worker 入口导出（§11.3 传输绑定 + §2.3 EventBus consumer）。
 * - fetch：Hono app（HTTP 面）。
 * - queue：watt-events 消费分发（consumer.ts）。
 * app 亦具名导出，供测试在 matcher 构建前挂测试专用路由（§toolchain-pitfalls 24）。
 */
export { app };

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: Bindings): Promise<void> {
    await handleQueue(batch, defaultConsumerDeps(env));
  },
};
