/**
 * Tools 消费面代理（Proto §5.1 ToolProvider / §11.3a HTBP 绑定 + §6.4d 工具动作映射）。
 *
 * 挂载点：`/htbp/tools/*` 全前缀，代理到独立 Worker watt-toolbridge（service binding TOOLBRIDGE，
 * 集成方案 A，见 .llmdoc-tmp/investigations/phase4-tool-agent.md）。管理面（挂载 CRUD，platform://tool）
 * 在 http/routes.ts；本文件是**消费面**（工具 List/描述/调用，资源 tool://<path>）。
 *
 * 请求流水（§R2）：
 *   1. 认证（authMiddleware，无 token → 401）。
 *   2. Check PEP（§6.4d）：资源 tool://<path>；action —— GET/~help（List/描述）→ 'read'；
 *      POST（调用）→ 从 ToolRegistry 查该 path 的 mount，若 virtualize/providerConfig 声明 scope
 *      则 action=scope 字符串，否则缺省 'invoke'（§6.4d：无 scope → "invoke"）。deny → 403。
 *   3. 树同步：把调用者可见（enabled）的 ToolMount 集合转成上游树 JSON，写入共享 KV（tenant:<id> +
 *      apikey:<hash>），用固定 Secret Key 作 Bearer 转发——树配置的运行时同步（无需重部署）。
 *   4. 转发：service binding fetch，路径重写 /htbp/tools/<rest> → 上游 /htbp/<rest>。
 *   5. 错误形状转换：上游 {error:{code,message}} → 裸 WattError（CODE_MAP）。
 *   6. 可见性裁剪：~help 的 resources[]/endpoint.tools[] 按调用者对各子 path 的 Check('read') 过滤，
 *      deny 的剔除（最小实现，量级见 trimHelpVisibility 注释）。
 *
 * 错误 = HTTP 状态（httpStatusFor）+ 裸 WattError（对齐 routes.ts / bare-watterror-body 决策）。
 */

import type { ToolMount } from '@watt/core';
import { type WattError, wattError } from '@watt/shared';
import { type Context, Hono } from 'hono';
import { Authorizer } from '../authz/authorizer.ts';
import { IdentityMapper } from '../authz/identity-mapper.ts';
import { PolicyStore } from '../authz/policy-store.ts';
import { ensureSeedPolicy } from '../authz/seed.ts';
import type { Bindings } from '../env.ts';
import { ToolRegistry } from '../tools/tool-registry.ts';
import { type AuthVars, authMiddleware } from './auth.ts';
import { forbiddenResponse, wattErrorResponse } from './errors.ts';

/** 固定内部租户 id + Secret Key（service binding 内部转发用；租户树由本 gateway 独占写）。 */
const PROXY_TENANT_ID = 'watt-gateway';
const PROXY_SECRET_KEY = 'watt-internal-toolbridge-key';

/** 上游 tool-bridge 错误 code → WattError code（§R2 步骤 5）。未知 code → internal。 */
const UPSTREAM_CODE_MAP: Record<string, WattError['code']> = {
  unauthorized: 'permission_denied',
  not_found: 'not_found',
  bad_request: 'invalid_argument',
  method_not_allowed: 'invalid_argument',
  not_supported: 'unavailable',
  auth_misconfigured: 'internal',
  internal_error: 'internal',
};

function isWattError(v: unknown): v is WattError {
  return typeof v === 'object' && v !== null && 'code' in v && 'message' in v && 'retryable' in v;
}

/** 上游节点类型（部分）——树同步用。 */
interface TreeNode {
  type: string;
  id: string;
  title?: string;
  children?: TreeNode[];
  [k: string]: unknown;
}

/**
 * 把一个 ToolMount 转成上游叶子节点（除 id/type 外的字段来自 providerConfig）。
 * provider（mcp/http/builtin/...）直接作上游 type；providerConfig 透传为节点字段（endpoint /
 * endpoints / builtin 等，形状由上游 registry.ts 校验）。凭证：providerConfig 里以 `$env:`/`${VAR}`
 * 占位的 header 值由上游 materializeHeaders 在转发时替换（凭证不出网关，Reference §2）。
 */
function mountToLeaf(mount: ToolMount, id: string): TreeNode {
  const cfg = (mount.providerConfig ?? {}) as Record<string, unknown>;
  const node: TreeNode = { type: mount.provider, id, ...cfg };
  node.id = id; // providerConfig 不得覆盖 id/type。
  node.type = mount.provider;
  if (mount.virtualize !== undefined) {
    // virtualize 仅对 mcp 节点的 namespace/toolOverrides 有意义；透传由上游消费。
    if (mount.virtualize.prefix !== undefined) node.namespace = mount.virtualize.prefix;
  }
  return node;
}

/**
 * 把 enabled 的 ToolMount 集合合并成一棵上游树（path 斜杠分段 → 目录，叶子为 provider 节点）。
 * 例：finance/reports(mcp) + echo/svc(http) → root{children:[finance{children:[reports(mcp)]},
 * echo{children:[svc(http)]}]}。
 */
export function buildUpstreamTree(mounts: ToolMount[]): TreeNode {
  const root: TreeNode = { type: 'directory', id: 'root', title: 'Watt Tools', children: [] };
  for (const mount of mounts) {
    if (!mount.enabled) continue;
    const segs = mount.path.split('/').filter((s) => s.length > 0);
    if (segs.length === 0) continue;
    let dir = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i] as string;
      let child = dir.children?.find((c) => c.id === seg && c.type === 'directory');
      if (!child) {
        child = { type: 'directory', id: seg, children: [] };
        dir.children = dir.children ?? [];
        dir.children.push(child);
      }
      dir = child;
    }
    const leafId = segs[segs.length - 1] as string;
    dir.children = dir.children ?? [];
    // 同 id 叶子覆盖（后写覆盖，对齐 ToolRegistry.write 幂等语义）。
    const existing = dir.children.findIndex((c) => c.id === leafId);
    const leaf = mountToLeaf(mount, leafId);
    if (existing >= 0) dir.children[existing] = leaf;
    else dir.children.push(leaf);
  }
  return root;
}

/** hex sha256（KV apikey 键；与上游 tenant.ts sha256Hex 一致）。 */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 把当前 ToolRegistry 的树写入共享 KV，返回转发用的 Secret Key。
 * 写 tenant:<id>（树 JSON）+ apikey:<hash>（key→tenant 映射），上游按 Secret Key 加载该租户树。
 */
async function syncTenantTree(env: Bindings): Promise<string> {
  const registry = new ToolRegistry(env.DB_PROVIDERS);
  const page = await registry.list({ limit: 200 });
  const mounts = isWattError(page) ? [] : page.items;
  const tree = buildUpstreamTree(mounts);
  const hash = await sha256Hex(PROXY_SECRET_KEY);
  await env.KV_TENANTS.put(`tenant:${PROXY_TENANT_ID}`, JSON.stringify(tree));
  await env.KV_TENANTS.put(`apikey:${hash}`, JSON.stringify({ tenantId: PROXY_TENANT_ID }));
  return PROXY_SECRET_KEY;
}

/** /htbp/tools/<rest>[/~help] → tool path（去掉尾部 ~help 段）。空 path → ''（树根）。 */
function toolPathFromUrl(pathname: string): { toolPath: string; isHelp: boolean } {
  const rest = pathname.slice('/htbp/tools'.length).replace(/^\/+/, '');
  const segs = rest.split('/').filter((s) => s.length > 0);
  const isHelp = segs[segs.length - 1] === '~help';
  const pathSegs = isHelp ? segs.slice(0, -1) : segs;
  return { toolPath: pathSegs.join('/'), isHelp };
}

/**
 * ~help 响应的可见性裁剪（§R2 步骤 6）：对 resources[]（下一层子节点）逐项 Check('read')，deny
 * 的剔除。量级：一次 ~help 最多 Check N 个直接子节点（非递归全树）——最小实现，深层子树在其自身
 * ~help 请求时再裁剪（渐进发现天然分摊）。endpoint.tools[]（mcp 内嵌工具）同理按工具 scope 裁剪，
 * 但工具无独立 path（同一 end-path），故此处只裁 resources[]；工具级裁剪留 backlog（记 doc-gap 候选）。
 */
async function trimHelpVisibility(
  body: unknown,
  basePath: string,
  check: (resource: string) => Promise<boolean>,
): Promise<unknown> {
  if (typeof body !== 'object' || body === null) return body;
  const help = body as { resources?: Array<{ name: string; path: string }> };
  if (!Array.isArray(help.resources)) return body;
  const kept: Array<{ name: string; path: string }> = [];
  for (const res of help.resources) {
    // res.path 是相对路径（"./child"）；拼成 tool://<basePath>/<child> 做 Check。
    const childSeg = res.path.replace(/^\.\//, '').replace(/^\/+/, '');
    const childPath = basePath ? `${basePath}/${childSeg}` : childSeg;
    if (await check(`tool://${childPath}`)) kept.push(res);
  }
  return { ...help, resources: kept };
}

/** 上游错误 body → 裸 WattError（保留 message）。 */
function convertUpstreamError(status: number, body: unknown): WattError {
  const err = (body as { error?: { code?: string; message?: string } })?.error;
  const upstreamCode = err?.code ?? '';
  const code = UPSTREAM_CODE_MAP[upstreamCode] ?? 'internal';
  const message = err?.message ?? `tool bridge returned HTTP ${status}`;
  return wattError(code, message);
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
  const authorizer = new Authorizer(new PolicyStore(c.env.DB_POLICIES));
  const url = new URL(c.req.url);
  const { toolPath, isHelp } = toolPathFromUrl(url.pathname);
  const isCall = c.req.method === 'POST' && !isHelp;
  const resource = `tool://${toolPath}`;

  // ── Check PEP（§6.4d）─────────────────────────────────────────────────
  // 调用（POST 非 ~help）→ PEP 门禁：action 由 mount 的 scope 决定（无 scope → 'invoke'，§6.4d）；
  // deny → 403。List/~help（read）**不做顶层门禁**——按 Proto §5.1 由 Tool Gateway 对结果做可见性裁剪
  // （见 trimHelpVisibility），根节点始终可发现（§11.3a 渐进发现），无权子节点在响应里剔除。
  if (isCall) {
    let action = 'invoke';
    // 从 ToolRegistry 查该 path 的 mount：providerConfig.scope 存在则 action=scope（§6.4d），否则 'invoke'。
    const registry = new ToolRegistry(c.env.DB_PROVIDERS);
    const mount = await registry.get(toolPath);
    if (!isWattError(mount)) {
      const scope = (mount.providerConfig as { scope?: unknown } | undefined)?.scope;
      if (typeof scope === 'string' && scope.length > 0) action = scope;
    }
    const decision = await authorizer.check(claims, resource, action);
    if (!decision.allow) {
      return forbiddenResponse(c, decision.reason ?? `access denied on ${resource}`);
    }
  }

  // ── 树同步 + 转发（service binding，路径重写）────────────────────────────
  const secretKey = await syncTenantTree(c.env);
  const upstreamPath = `/htbp${toolPath ? `/${toolPath}` : ''}${isHelp ? '/~help' : ''}`;
  const upstreamUrl = `https://toolbridge.internal${upstreamPath}`;
  const fwdHeaders = new Headers();
  fwdHeaders.set('Authorization', `Bearer ${secretKey}`);
  const accept = c.req.header('accept');
  if (accept) fwdHeaders.set('Accept', accept);
  let upstreamRes: Response;
  try {
    if (isCall) {
      fwdHeaders.set('Content-Type', 'application/json');
      const rawBody = await c.req.raw.text();
      upstreamRes = await c.env.TOOLBRIDGE.fetch(upstreamUrl, {
        method: 'POST',
        headers: fwdHeaders,
        body: rawBody,
      });
    } else {
      upstreamRes = await c.env.TOOLBRIDGE.fetch(upstreamUrl, {
        method: 'GET',
        headers: fwdHeaders,
      });
    }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return wattErrorResponse(
      c,
      wattError('unavailable', `tool bridge unreachable: ${detail}`, true),
    );
  }

  const contentType = upstreamRes.headers.get('content-type') ?? '';

  // ── 错误形状转换 ────────────────────────────────────────────────────────
  if (!upstreamRes.ok) {
    let body: unknown;
    try {
      body = await upstreamRes.json();
    } catch {
      body = undefined;
    }
    return wattErrorResponse(c, convertUpstreamError(upstreamRes.status, body));
  }

  // ── text/plain（~help DSL）：直接透传（裁剪只对 JSON 结构做，DSL 保持原样）──
  if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
    const textBody = await upstreamRes.text();
    return c.text(textBody, 200, { 'content-type': contentType });
  }

  // ── JSON：~help 裁剪 resources[]；调用结果原样透传 ────────────────────────
  let body: unknown;
  try {
    body = await upstreamRes.json();
  } catch {
    return wattErrorResponse(c, wattError('internal', 'tool bridge returned malformed JSON', true));
  }
  if (isHelp || (!isCall && c.req.method === 'GET')) {
    const trimmed = await trimHelpVisibility(body, toolPath, async (res) => {
      const d = await authorizer.check(claims, res, 'read');
      return d.allow;
    });
    return c.json(trimmed);
  }
  return c.json(body);
}
