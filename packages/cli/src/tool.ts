/**
 * `watt tool mount|ls|describe|call`（Proto §5.2 ToolRegistry 管理面 + §5.1 ToolProvider 消费面）。
 *
 * 两个挂载点：
 *  - 管理面 → POST /htbp/platform/tool `{tool,arguments}`（ToolRegistry），复用 client.ts 的 htbpCall。
 *    - ls    → List   arguments:{opts:{}}                         → 裸 Page{items}（ToolMount）
 *    - mount → Write  arguments:{mount:{path, provider, providerConfig?, virtualize?, enabled}}（幂等 upsert §0.4）
 *  - 消费面 → /htbp/tools/<path>（代理到 watt-toolbridge，Check PEP + 裁剪在 gateway tools-proxy）。
 *    - describe → GET  /htbp/tools/<path>/~help（Accept: text/plain）→ text/plain HTBP DSL（人类可读能力清单）
 *    - call     → POST /htbp/tools/<path>/<tool> `{arguments}`       → {resource,result}（透传上游调用结果）
 *      端点/工具名走 URL end-path 段（上游按 path 定位，不读 body 的 tool 字段，toolchain §36）。
 *
 * 响应形状真源：管理面以 gateway packages/gateway/test/platform-tool.test.ts 为准（Get/Write/Update →
 * { mount }；List → 裸 Page{items}）；消费面以 packages/gateway/test/tools-proxy.test.ts 为准（call →
 * {resource,result}；describe → text/plain 透传）。禁双形态兜底（toolchain §34）。
 *
 * 退出码分层（对齐 context.ts/client.ts）：本地无 token → CliError(2)（requireToken）；
 * 服务端非 2xx（含 401/403/not_found）→ CliError(1)，WattError.message 透传。
 */

import { type HttpDeps, htbpCall } from './client.ts';
import { CliError } from './env.ts';

/** ToolMount 的读投影（ls 展示 / mount 回显）。 */
export interface ToolMount {
  path: string;
  provider: string;
  providerConfig?: Record<string, unknown>;
  virtualize?: {
    prefix?: string;
    rename?: Record<string, string>;
    hide?: string[];
    describeOverride?: Record<string, string>;
  };
  enabled: boolean;
}

interface MountPage {
  items: ToolMount[];
}

export interface MountInput {
  path: string;
  provider: string;
  providerConfig?: Record<string, unknown>;
  enabled: boolean;
}

/** ls → ToolRegistry.List（管理面视角，返回全部挂载）。 */
export async function toolList(
  base: string,
  token: string,
  deps: HttpDeps = {},
): Promise<ToolMount[]> {
  const body = (await htbpCall(base, token, 'tool', 'List', { opts: {} }, deps)) as MountPage;
  return body.items;
}

/** mount → ToolRegistry.Write（幂等 upsert）。服务端返回 { mount }（platform-tool.test.ts 锁定）。 */
export async function toolMount(
  base: string,
  token: string,
  input: MountInput,
  deps: HttpDeps = {},
): Promise<ToolMount> {
  const mount: Record<string, unknown> = {
    path: input.path,
    provider: input.provider,
    enabled: input.enabled,
  };
  if (input.providerConfig !== undefined) mount.providerConfig = input.providerConfig;
  const body = (await htbpCall(base, token, 'tool', 'Write', { mount }, deps)) as {
    mount?: ToolMount;
  };
  // 精确解包 body.mount：不兜底 body 本身——双形态兼容会掩盖两侧漂移（context 曾两次致线上 bug）。
  if (body.mount === undefined) {
    throw new CliError('server mount response missing mount', 1);
  }
  return body.mount;
}

/** ls 的人类可读行（path / provider / enabled）。 */
export function formatMountLine(m: ToolMount): string {
  return `${m.path}\t${m.provider}\t${m.enabled ? 'enabled' : 'disabled'}`;
}

export function formatMountListHuman(items: ToolMount[]): string {
  if (!items.length) return '(no tool mounts)';
  return items.map(formatMountLine).join('\n');
}

// ── 消费面（/htbp/tools/<path>，代理到 watt-toolbridge）────────────────────────
// 独立 fetch（不经 htbpCall——那是 /htbp/platform/<module> 管理面）。base 已去尾斜杠（requireBaseUrl）。

/** describe → GET /htbp/tools/<path>/~help（Accept: text/plain）→ HTBP DSL 文本。 */
export async function toolDescribe(
  base: string,
  token: string,
  path: string,
  deps: HttpDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const clean = path.replace(/^\/+|\/+$/g, '');
  const url = `${base}/htbp/tools${clean ? `/${clean}` : ''}/~help`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'text/plain' },
    });
  } catch (cause) {
    throw new CliError(
      `Failed to reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
      1,
    );
  }
  if (!res.ok) throw await consumerHttpError(url, res);
  return res.text();
}

/**
 * call → POST /htbp/tools/<path>/<tool> `{arguments}` → {resource,result}（透传上游结果）。
 *
 * 契约（toolchain §36）：上游用 **URL path 段** 定位端点/工具（http endpoint 名 / mcp·builtin 工具名），
 * body 是参数信封。故 toolName 拼进 URL 的 end-path 段（不是 body 的 `tool` 字段——上游根本不读它）。
 * body 用 `{arguments}` 信封：mcp/builtin 上游 extractArguments 解包；http 由 gateway 代理层按 provider
 * 拆信封发裸参数（http adapter 整包转发，见 tools-proxy.ts 的 provider-aware body 处理）。
 */
export async function toolCall(
  base: string,
  token: string,
  path: string,
  toolName: string,
  args: Record<string, unknown>,
  deps: HttpDeps = {},
): Promise<{ resource?: string; result: unknown }> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const clean = path.replace(/^\/+|\/+$/g, '');
  const tool = toolName.replace(/^\/+|\/+$/g, '');
  const url = `${base}/htbp/tools/${clean}/${encodeURIComponent(tool)}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ arguments: args }),
    });
  } catch (cause) {
    throw new CliError(
      `Failed to reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
      1,
    );
  }
  if (!res.ok) throw await consumerHttpError(url, res);
  // 精确解包：服务端返回 {resource,result}（tools-proxy 透传上游 resolveCall）。禁双形态兜底。
  const body = (await res.json()) as { resource?: string; result?: unknown };
  if (!('result' in body)) {
    throw new CliError('server call response missing result', 1);
  }
  return { resource: body.resource, result: body.result };
}

/** 消费面非 2xx → CliError（透传裸 WattError.message；401/403 特判提示，退出码 1）。 */
async function consumerHttpError(url: string, res: Response): Promise<CliError> {
  let detail = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { message?: string };
    if (body.message) detail = body.message;
  } catch {
    // 非 JSON 错误体，保留 HTTP 状态。
  }
  if (res.status === 401) return new CliError(`Unauthorized (HTTP 401): ${detail}`, 1);
  if (res.status === 403) return new CliError(`Forbidden (HTTP 403): ${detail}`, 1);
  return new CliError(`${url} returned HTTP ${res.status}: ${detail}`, 1);
}
