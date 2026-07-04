/**
 * Tool 消费面调用核心（Proto §5.1 ToolProvider / §11.3a HTBP 绑定 / §6.4d 工具动作映射）——
 * 与 Hono Context 解耦的可复用单元。两处消费方共用它：
 *   1. `/htbp/tools/*` 代理路由（http/tools-proxy.ts）——外部 HTBP 消费面。
 *   2. Agent 的 HTBP 工具（agent/harness/htbp-tools.ts）——def.toolScopes 注入的三工具 execute。
 *
 * 职责边界（P2 抽取决策）：本模块承接**传输 + 形状归一 + 可见性裁剪**——
 *   ① syncTenantTree（树同步写共享 KV，KV 单键 1 写/秒节流）；
 *   ② service binding TOOLBRIDGE 转发（路径重写 /htbp/tools/<rest> → /htbp/<rest>，call body 按
 *      provider 归一化：http 拆 {arguments} 信封发裸参数 / mcp·builtin 透传，§38）；
 *   ③ 上游 {error:{code,message}} → 裸 WattError（CODE_MAP）；
 *   ④ ~help/~skill 的 resources[] 按注入的 check 回调逐项裁剪。
 *
 * **不承接顶层 Check PEP**：两处消费方的 PEP 语义不同——tools-proxy 的 call 动作由 mount scope 推导
 *   （deny→403 Response），htbp-tools 的动作钉死（htbp_call→invoke / help·skill→read，deny→错误对象
 *   回喂模型）。故顶层门禁留在各调用方，本模块只提供裁剪用的 check 回调注入点。这是有意偏离计划
 *   "Check PEP 一并抽取"的措辞——两者授权动作推导与响应形状发散，强抽会引入分支耦合。
 */

import type { ToolMount } from '@watt/core';
import { type WattError, wattError } from '@watt/shared';
import type { Bindings } from '../env.ts';
import { ToolRegistry } from './tool-registry.ts';

/** 固定内部租户 id + Secret Key（service binding 内部转发用；租户树由本 gateway 独占写）。 */
const PROXY_TENANT_ID = 'watt-gateway';
const PROXY_SECRET_KEY = 'watt-internal-toolbridge-key';

/** 上游 tool-bridge 错误 code → WattError code。未知 code → internal。 */
const UPSTREAM_CODE_MAP: Record<string, WattError['code']> = {
  unauthorized: 'permission_denied',
  not_found: 'not_found',
  bad_request: 'invalid_argument',
  method_not_allowed: 'invalid_argument',
  not_supported: 'unavailable',
  auth_misconfigured: 'internal',
  internal_error: 'internal',
};

export function isWattError(v: unknown): v is WattError {
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

/** hex sha256（KV apikey 键 / 树 hash；与上游 tenant.ts sha256Hex 一致）。 */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// isolate 级同步状态（KV 单键 1 写/秒限制：每请求盲写会撞限流）。
//   lastTreeHash：上次写入 KV 的树 JSON hash——树未变则跳过 tenant:<id> 写。冷启动为 undefined，
//     首请求会 get KV 现值算 hash 比对（避免冷启动误重写），仍不匹配才写。
//   apikeyWritten：apikey:<hash> 常量映射键的 once-guard——写过一次后本 isolate 不再 get/put。
let lastTreeHash: string | undefined;
let apikeyWritten = false;

// 测试复位（同文件 isolate 跨用例存活模块级单例，对齐 seed once-guard 复位，toolchain §23）。
export function resetSyncStateForTests(): void {
  lastTreeHash = undefined;
  apikeyWritten = false;
}

/**
 * 把当前 ToolRegistry 的树写入共享 KV，返回转发用的 Secret Key。
 * 写 tenant:<id>（树 JSON）+ apikey:<hash>（key→tenant 映射），上游按 Secret Key 加载该租户树。
 *
 * KV 限流规避（finding 3）：**变更时才写**——树 JSON hash 与 isolate 缓存（或冷启动时 KV 现值）比对，
 * 变了才 put tenant 键；apikey 常量键只在缺失时写一次（isolate once-guard + KV get 判存在）。
 * 稳态（树不变的热 isolate）对这两个键零写，不再撞 KV 单键 1 写/秒限制。
 */
export async function syncTenantTree(env: Bindings): Promise<string> {
  const registry = new ToolRegistry(env.DB_PROVIDERS);
  const page = await registry.list({ limit: 200 });
  const mounts = isWattError(page) ? [] : page.items;
  const treeJson = JSON.stringify(buildUpstreamTree(mounts));
  const treeHash = await sha256Hex(treeJson);
  const tenantKey = `tenant:${PROXY_TENANT_ID}`;

  if (lastTreeHash !== treeHash) {
    // isolate 缓存未命中（冷启动/首请求）：先看 KV 现值是否已是同树，是则只更新缓存、不写。
    if (lastTreeHash === undefined) {
      const existing = await env.KV_TENANTS.get(tenantKey);
      if (existing !== null && (await sha256Hex(existing)) === treeHash) {
        lastTreeHash = treeHash;
      }
    }
    if (lastTreeHash !== treeHash) {
      await env.KV_TENANTS.put(tenantKey, treeJson);
      lastTreeHash = treeHash;
    }
  }

  if (!apikeyWritten) {
    const apikeyKey = `apikey:${await sha256Hex(PROXY_SECRET_KEY)}`;
    const existing = await env.KV_TENANTS.get(apikeyKey);
    if (existing === null) {
      await env.KV_TENANTS.put(apikeyKey, JSON.stringify({ tenantId: PROXY_TENANT_ID }));
    }
    apikeyWritten = true;
  }

  return PROXY_SECRET_KEY;
}

/**
 * ~help/~skill 响应的可见性裁剪：对 resources[]（下一层子节点）逐项 check，deny 的剔除。
 * 量级：一次 describe 最多 check N 个直接子节点（非递归全树）——深层子树在其自身 ~help 请求时再裁剪
 * （渐进发现天然分摊）。check 回调由调用方注入（tools-proxy / htbp-tools 各用自己的 authorizer+claims）。
 */
export async function trimHelpVisibility(
  body: unknown,
  basePath: string,
  check: (resource: string) => Promise<boolean>,
): Promise<unknown> {
  if (typeof body !== 'object' || body === null) return body;
  const help = body as { resources?: Array<{ name: string; path: string }> };
  if (!Array.isArray(help.resources)) return body;
  const kept: Array<{ name: string; path: string }> = [];
  for (const res of help.resources) {
    // res.path 是相对路径（"./child"）；拼成 tool://<basePath>/<child> 做 check。
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

/**
 * 从含 end-path 段的 toolPath 解出对应的 ToolMount：mount.path 是节点路径（如 echo/svc），toolPath
 * 含端点/工具名（如 echo/svc/ping）。从最长前缀逐级回退 get，命中即返回（对齐上游 findNode 走到叶子、
 * 剩余段作 adapter sub 的语义）。全不命中 → undefined（provider 未知，body 按 mcp/builtin 默认透传）。
 */
async function resolveMount(
  registry: ToolRegistry,
  toolPath: string,
): Promise<ToolMount | undefined> {
  const segs = toolPath.split('/').filter((s) => s.length > 0);
  for (let end = segs.length; end >= 1; end--) {
    const candidate = segs.slice(0, end).join('/');
    const mount = await registry.get(candidate);
    if (!isWattError(mount)) return mount;
  }
  return undefined;
}

/**
 * 按 provider 归一化调用 body（§38）：CLI/agent 统一发 {arguments:{...}} 信封。
 * - http：上游 http adapter 把 body **整包**转发到远端 URL（不解信封）→ 代理拆掉信封发裸参数，
 *   否则远端 API 收到 {arguments:{...}} 包裹（漂移面）。
 * - mcp/builtin/其他/未知：原样透传——上游 adapter 的 extractArguments 解 {arguments} 信封（或整体
 *   当参数），透传信封是它期待的形状；未知 provider 也按此保守透传（不猜测远端语义）。
 */
function normalizeCallBody(rawBody: string, provider: string | undefined): string {
  if (provider !== 'http') return rawBody;
  let parsed: unknown;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return rawBody; // 非 JSON body 原样透传（上游会自行报错）。
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'arguments' in parsed) {
    return JSON.stringify((parsed as { arguments?: unknown }).arguments ?? {});
  }
  return rawBody;
}

/** 单次工具调用请求（Hono-decoupled）。 */
export interface ToolInvokeRequest {
  /** 工具节点路径，无 /htbp/tools 前缀、无 ~help/~skill 后缀。'' = 树根。 */
  toolPath: string;
  /** 'help' → GET ~help（渐进发现）；'skill' → GET ~skill（技能文档）；'call' → POST {arguments}。 */
  op: 'help' | 'skill' | 'call';
  /** call 的原始 body 字符串（{arguments} 信封）；help/skill 忽略。 */
  rawBody?: string;
  /** 转发的 Accept 头（help/skill）。 */
  accept?: string;
}

/** 工具调用结果（成功 json / 成功 text / 失败 WattError）——调用方按需转 Response 或错误对象。 */
export type ToolInvokeResult =
  | { ok: true; kind: 'json'; body: unknown }
  | { ok: true; kind: 'text'; contentType: string; text: string }
  | { ok: false; error: WattError };

/** executeToolRequest 选项：~help/~skill 的 resources[] 可见性裁剪回调（缺省不裁剪）。 */
export interface ToolInvokeOpts {
  /** 逐子节点资源 → 是否可见（tools-proxy/htbp-tools 各用自己的 authorizer+claims）。 */
  trim?: (resource: string) => Promise<boolean>;
}

/**
 * 执行一次工具调用（传输 + 形状归一 + 可见性裁剪，无顶层 PEP，见文件头）。
 *   op='call'：先 resolveMount 取 provider 归一化 body（http 拆信封）→ POST。
 *   op='help'/'skill'：GET ~help/~skill，JSON 响应经 opts.trim 裁剪 resources[]。
 * 转发不可达 → unavailable；上游非 2xx → convertUpstreamError；text/* → 透传文本。
 */
export async function executeToolRequest(
  env: Bindings,
  req: ToolInvokeRequest,
  opts: ToolInvokeOpts = {},
): Promise<ToolInvokeResult> {
  const isCall = req.op === 'call';

  // call：解 provider 以归一化 body（http 拆信封发裸参数）。
  let provider: string | undefined;
  let body: string | undefined;
  if (isCall) {
    const registry = new ToolRegistry(env.DB_PROVIDERS);
    const mount = await resolveMount(registry, req.toolPath);
    provider = mount?.provider;
    body = normalizeCallBody(req.rawBody ?? '', provider);
  }

  const secretKey = await syncTenantTree(env);
  const suffix = req.op === 'help' ? '/~help' : req.op === 'skill' ? '/~skill' : '';
  const upstreamPath = `/htbp${req.toolPath ? `/${req.toolPath}` : ''}${suffix}`;
  const upstreamUrl = `https://toolbridge.internal${upstreamPath}`;

  const fwdHeaders = new Headers();
  fwdHeaders.set('Authorization', `Bearer ${secretKey}`);
  if (req.accept) fwdHeaders.set('Accept', req.accept);

  let upstreamRes: Response;
  try {
    if (isCall) {
      fwdHeaders.set('Content-Type', 'application/json');
      upstreamRes = await env.TOOLBRIDGE.fetch(upstreamUrl, {
        method: 'POST',
        headers: fwdHeaders,
        body,
      });
    } else {
      upstreamRes = await env.TOOLBRIDGE.fetch(upstreamUrl, { method: 'GET', headers: fwdHeaders });
    }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      error: wattError('unavailable', `tool bridge unreachable: ${detail}`, true),
    };
  }

  const contentType = upstreamRes.headers.get('content-type') ?? '';

  if (!upstreamRes.ok) {
    let errBody: unknown;
    try {
      errBody = await upstreamRes.json();
    } catch {
      errBody = undefined;
    }
    return { ok: false, error: convertUpstreamError(upstreamRes.status, errBody) };
  }

  // text/plain·markdown（~help/~skill DSL）：直接透传（裁剪只对 JSON 结构做）。
  if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
    return { ok: true, kind: 'text', contentType, text: await upstreamRes.text() };
  }

  let jsonBody: unknown;
  try {
    jsonBody = await upstreamRes.json();
  } catch {
    return { ok: false, error: wattError('internal', 'tool bridge returned malformed JSON', true) };
  }
  // help/skill（describe）：裁剪 resources[]；call 结果原样透传。
  if (!isCall && opts.trim !== undefined) {
    return {
      ok: true,
      kind: 'json',
      body: await trimHelpVisibility(jsonBody, req.toolPath, opts.trim),
    };
  }
  return { ok: true, kind: 'json', body: jsonBody };
}
