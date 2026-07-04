/**
 * tools domain wrappers（Proto §5.2 ToolRegistry 管理面 + §5.1 ToolProvider 消费面）。
 *
 * 两个挂载点（对齐 CLI packages/cli/src/tool.ts 的 htbpCall/独立 fetch 调用点 = 形状真源）：
 *  - 管理面（ToolRegistry）→ htbp('tool', ...)（POST /htbp/platform/tool）：
 *      List  arguments:{opts:{}}                                             → 裸 Page{items}（ToolMount）
 *      Write arguments:{mount:{path,provider,providerConfig?,enabled}}       → {mount}（幂等 upsert）
 *  - 消费面（代理到 watt-toolbridge）→ authedFetch /htbp/tools/<path>：
 *      describe → GET  /htbp/tools/<path>/~help（Accept: text/plain）        → text/plain HTBP DSL
 *      call     → POST /htbp/tools/<path>/<tool> `{arguments}`               → {resource,result}
 *
 * call 契约（toolchain §36）：上游用 URL end-path 段定位端点/工具（不读 body.tool），body 是 {arguments} 信封。
 * http mount 的 providerConfig 必须是上游 HttpEndpointConfig 形状 {endpoints:[...]}（对照 cli/src/tool.ts）。
 * 精确解包（禁双形态兜底，toolchain §34）：Write→body.mount、call→body.result（'result' in body）。
 */

import { authedFetch, htbp } from './core.ts';
import type { Page } from './types.ts';

/** ToolMount 读投影（ls 展示 + mount 回执）。 */
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

export interface ToolMountInput {
  path: string;
  provider: string;
  providerConfig?: Record<string, unknown>;
  enabled: boolean;
}

export interface ToolCallResult {
  resource?: string;
  result: unknown;
}

/** URL path 段清洗（去首尾斜杠，对齐 CLI clean）。 */
function cleanPath(p: string): string {
  return p.replace(/^\/+|\/+$/g, '');
}

export const toolsApi = {
  // ── 管理面（ToolRegistry）───────────────────────────────────────────────
  /** 工具挂载列表（§5.2 ToolRegistry.List）。 */
  listMounts: () => htbp<Page<ToolMount>>('tool', 'List', { opts: {} }),
  /** 挂载/整体替换工具 provider（§5.2 Write，upsert）。精确解包 body.mount。 */
  mount: (input: ToolMountInput) => {
    const mount: Record<string, unknown> = {
      path: input.path,
      provider: input.provider,
      enabled: input.enabled,
    };
    if (input.providerConfig !== undefined) mount.providerConfig = input.providerConfig;
    return htbp<{ mount: ToolMount }>('tool', 'Write', { mount });
  },

  // ── 消费面（/htbp/tools/<path>，代理到 watt-toolbridge）────────────────────
  /** describe → GET /htbp/tools/<path>/~help（Accept: text/plain）→ HTBP DSL 文本。 */
  describe: async (path: string): Promise<string> => {
    const clean = cleanPath(path);
    const res = await authedFetch(`/htbp/tools${clean ? `/${clean}` : ''}/~help`, {
      headers: { accept: 'text/plain' },
    });
    return res.text();
  },
  /**
   * call → POST /htbp/tools/<path>/<tool> `{arguments}` → {resource,result}。
   * toolName 拼进 URL end-path 段（上游按 path 定位，不读 body.tool）；body 是 {arguments} 信封。
   * 精确解包 body.result（禁双形态兜底）。
   */
  call: async (
    path: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult> => {
    const clean = cleanPath(path);
    const tool = cleanPath(toolName);
    const res = await authedFetch(`/htbp/tools/${clean}/${encodeURIComponent(tool)}`, {
      method: 'POST',
      body: { arguments: args },
    });
    const body = (await res.json()) as { resource?: string; result?: unknown };
    if (!('result' in body)) throw new Error('server call response missing result');
    return { resource: body.resource, result: body.result };
  },
};
