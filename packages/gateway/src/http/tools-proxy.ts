/**
 * Tools 消费面代理（Proto §5.1 ToolProvider / §11.3a HTBP 绑定 + §6.4d 工具动作映射）。
 *
 * 挂载点：`/htbp/tools/*` 全前缀，代理到独立 Worker watt-toolbridge（service binding TOOLBRIDGE，
 * 集成方案 A，见 .llmdoc-tmp/investigations/phase4-tool-agent.md）。管理面（挂载 CRUD，platform://tool）
 * 在 http/routes.ts；本文件是**消费面**（工具 List/描述/调用，资源 tool://<path>）。
 *
 * 本文件 = **Hono 适配层**：解 URL/method → 顶层 Check PEP（call 由 mount scope 推导动作，deny→403）→
 *   委托 tools/tool-invoker.ts 的 executeToolRequest（传输 + 形状归一 + ~help 裁剪，与 Context 解耦）→
 *   ToolInvokeResult 转 Response。传输核心（树同步/转发/错误转换/裁剪）见 tool-invoker.ts。
 *
 * 请求流水（§R2）：
 *   1. 认证（authMiddleware，无 token → 401）。
 *   2. Check PEP（§6.4d）：资源 tool://<path>；GET/~help（List/描述）→ 顶层不门禁（由裁剪逐子节点
 *      'read' 过滤，根节点始终可发现，§11.3a 渐进发现）；POST（调用）→ 从 ToolRegistry 查该 path 的
 *      mount，providerConfig.scope 存在则 action=scope（§6.4d），否则缺省 'invoke'；deny → 403。
 *   3~6. 树同步 / 转发（路径重写 + call body 归一化）/ 错误形状转换 / ~help 裁剪：委托 executeToolRequest。
 *
 * 错误 = HTTP 状态（httpStatusFor）+ 裸 WattError（对齐 routes.ts / bare-watterror-body 决策）。
 */

import { type Context, Hono } from 'hono';
import { newAuthorizer } from '../audit/audit-sink.ts';
import { IdentityMapper } from '../authz/identity-mapper.ts';
import { PolicyStore } from '../authz/policy-store.ts';
import { ensureSeedPolicy } from '../authz/seed.ts';
import type { Bindings } from '../env.ts';
import { executeToolRequest } from '../tools/tool-invoker.ts';
import { ToolRegistry } from '../tools/tool-registry.ts';
import { type AuthVars, authMiddleware } from './auth.ts';
import { forbiddenResponse, wattErrorResponse } from './errors.ts';

// 树映射/同步状态复位从 tool-invoker 抽取（P2）；在此再导出，保持既有测试与消费方 import 路径不破。
export { buildUpstreamTree, resetSyncStateForTests } from '../tools/tool-invoker.ts';

/** /htbp/tools/<rest>[/~help] → tool path（去掉尾部 ~help 段）。空 path → ''（树根）。 */
function toolPathFromUrl(pathname: string): { toolPath: string; isHelp: boolean } {
  const rest = pathname.slice('/htbp/tools'.length).replace(/^\/+/, '');
  const segs = rest.split('/').filter((s) => s.length > 0);
  const isHelp = segs[segs.length - 1] === '~help';
  const pathSegs = isHelp ? segs.slice(0, -1) : segs;
  return { toolPath: pathSegs.join('/'), isHelp };
}

export function toolsProxyRoutes(): Hono<{ Bindings: Bindings; Variables: AuthVars }> {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVars }>();

  // 全部消费面路由需认证（工具 List/描述/调用均鉴权；无免认证 ~help——工具能力可能泄漏可调用面）。
  app.use('/htbp/tools/*', authMiddleware());
  app.use('/htbp/tools', authMiddleware());
  // 种子引导（§6.5c）：与 platform 路由同——首次请求幂等初始化，否则 admin 在 tools 子树无 Policy。
  const seed = async (c: ToolsContext, next: () => Promise<void>): Promise<void> => {
    const store = new PolicyStore(c.env.DB_POLICIES);
    const identities = new IdentityMapper(c.env.DB_POLICIES);
    await ensureSeedPolicy(store, identities, c.env.WATT_ADMIN_PRINCIPAL);
    await next();
  };
  app.use('/htbp/tools/*', seed);
  app.use('/htbp/tools', seed);

  app.all('/htbp/tools', (c) => handle(c));
  app.all('/htbp/tools/*', (c) => handle(c));

  return app;
}

type ToolsContext = Context<{ Bindings: Bindings; Variables: AuthVars }>;

async function handle(c: ToolsContext): Promise<Response> {
  const claims = c.get('claims');
  const authorizer = newAuthorizer(c.env, c.get('callContext').traceId);
  const url = new URL(c.req.url);
  const { toolPath, isHelp } = toolPathFromUrl(url.pathname);
  const method = c.req.method;
  const isCall = method === 'POST' && !isHelp;
  const resource = `tool://${toolPath}`;

  // ── Check PEP（§6.4d）─────────────────────────────────────────────────
  // 调用（POST 非 ~help）→ PEP 门禁：action 由 mount 的 scope 决定（无 scope → 'invoke'，§6.4d）；
  // deny → 403。List/~help（read）**不做顶层门禁**——由裁剪逐子节点 Check('read') 过滤（渐进发现）。
  if (isCall) {
    let action = 'invoke';
    // 从 ToolRegistry 查该 path 的 mount（节点路径，逐级回退去掉 end-path 段）：
    // providerConfig.scope 存在则 action=scope（§6.4d），否则 'invoke'。
    const registry = new ToolRegistry(c.env.DB_PROVIDERS);
    const segs = toolPath.split('/').filter((s) => s.length > 0);
    for (let end = segs.length; end >= 1; end--) {
      const mount = await registry.get(segs.slice(0, end).join('/'));
      if (!('code' in mount)) {
        const scope = (mount.providerConfig as { scope?: unknown } | undefined)?.scope;
        if (typeof scope === 'string' && scope.length > 0) action = scope;
        break;
      }
    }
    const decision = await authorizer.check(claims, resource, action);
    if (!decision.allow) {
      return forbiddenResponse(c, decision.reason ?? `access denied on ${resource}`);
    }
  }

  // ── 委托传输核心（树同步 + 转发 + 错误转换 + ~help 裁剪）───────────────────────────
  // op：POST 非 ~help → call；否则 help（GET/~help 语义等价）。裁剪条件与原 handle 一致：
  //   isHelp || (!isCall && GET)——POST ~help 也裁剪，非 GET 非 help 不裁剪（保守，无行为漂移）。
  const shouldTrim = isHelp || (!isCall && method === 'GET');
  const rawBody = isCall ? await c.req.raw.text() : undefined;
  const accept = c.req.header('accept');
  const result = await executeToolRequest(
    c.env,
    {
      toolPath,
      op: isCall ? 'call' : 'help',
      ...(rawBody !== undefined ? { rawBody } : {}),
      ...(accept ? { accept } : {}),
    },
    shouldTrim
      ? { trim: async (res: string) => (await authorizer.check(claims, res, 'read')).allow }
      : {},
  );

  if (!result.ok) return wattErrorResponse(c, result.error);
  if (result.kind === 'text') {
    return c.text(result.text, 200, { 'content-type': result.contentType });
  }
  // body 为 unknown（上游 JSON / 裁剪后结构）——与原 handle 的 c.json(body) 同，Hono 接受 unknown。
  return c.json(result.body);
}
