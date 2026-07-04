/**
 * context domain wrappers（Proto §4.1 ContextProvider 消费面 + §4.2 ContextRegistry 管理面）。
 *
 * 两个挂载点（对齐 CLI packages/cli/src/context.ts 的 htbpCall/contextCall 调用点 = 形状真源）：
 *  - 管理面（namespace mount 注册表）→ htbp('context', ...)（POST /htbp/platform/context）：
 *      List   arguments:{opts:{}}                    → 裸 Page{items}（NamespaceMount）
 *      Write  arguments:{mount:{namespace,provider,ttl?,readOnly?,providerConfig?}} → {mount}
 *      Delete arguments:{namespace}                  → {deleted}（unmount，仅卸载不清数据）
 *  - 消费面（namespace 内条目 CRUD）→ authedFetch POST /htbp/context/<ns> `{tool,arguments}`：
 *      List   arguments:{path, opts:{}}              → Page{items}（ContextEntryMeta）
 *      Get    arguments:{path}                        → {entry}（含 content）
 *      Write  arguments:{path, entry:{content,contentType,metadata?,ifVersion?}} → {meta}
 *      Update arguments:{path, patch:{content?,metadata?,ifVersion?}}            → {meta}
 *
 * 精确解包（禁双形态兜底，toolchain §34）：Get→body.entry、Write/Update→body.meta、mount→body.mount。
 */

import { authedFetch, htbp } from './core.ts';
import type { Page } from './types.ts';

/** ContextEntryMeta 读投影（ls 展示 + Write/Update 回执）。 */
export interface ContextEntryMeta {
  uri: string;
  contentType: string;
  size?: number;
  version: string;
  updatedAt: string;
  metadata: Record<string, string>;
}

/** ContextEntry = Meta + content（cat 读取）。 */
export interface ContextEntry extends ContextEntryMeta {
  content: string | unknown;
}

/** NamespaceMount（管理面 List/Write 回投影）。 */
export interface NamespaceMount {
  namespace: string;
  provider: string;
  providerConfig?: Record<string, unknown>;
  ttl?: number;
  readOnly?: boolean;
}

export interface PutEntryInput {
  content: string;
  contentType?: string;
  metadata?: Record<string, string>;
  ifVersion?: string;
}

export interface PatchEntryInput {
  content?: string;
  metadata?: Record<string, string>;
  ifVersion?: string;
}

export interface ContextMountInput {
  namespace: string;
  provider: string;
  ttl?: number;
  readOnly?: boolean;
  providerConfig?: Record<string, unknown>;
}

/**
 * POST 一个 HTBP 方法到 context 消费子树 <base>/htbp/context/<ns>（ContextProvider 四动词）。
 * 与 CLI contextCall 同构：authedFetch 带 Bearer + {tool,arguments} 信封，非 2xx 抛 ApiError。
 */
async function contextCall<T>(
  namespace: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = await authedFetch(`/htbp/context/${namespace}`, {
    method: 'POST',
    body: { tool, arguments: args },
  });
  return (await res.json()) as T;
}

export const contextApi = {
  // ── 管理面（ContextRegistry）───────────────────────────────────────────
  /** namespace 挂载列表（§4.2 ContextRegistry.List）。 */
  listMounts: () => htbp<Page<NamespaceMount>>('context', 'List', { opts: {} }),
  /** 挂载/整体替换 provider（§4.2 Write，upsert）。 */
  mount: (input: ContextMountInput) => {
    const mount: Record<string, unknown> = {
      namespace: input.namespace,
      provider: input.provider,
    };
    if (input.ttl !== undefined) mount.ttl = input.ttl;
    if (input.readOnly !== undefined) mount.readOnly = input.readOnly;
    if (input.providerConfig !== undefined) mount.providerConfig = input.providerConfig;
    return htbp<{ mount: NamespaceMount }>('context', 'Write', { mount });
  },
  /** 卸载 namespace（§4.2 Delete，仅卸载不清数据）。 */
  unmount: (namespace: string) => htbp<{ deleted: boolean }>('context', 'Delete', { namespace }),

  // ── 消费面（ContextProvider，走 /htbp/context/<ns>）─────────────────────
  /** 列 namespace 内条目（ls）。 */
  listEntries: (namespace: string, path = '') =>
    contextCall<Page<ContextEntryMeta>>(namespace, 'List', { path, opts: {} }),
  /** 读单条目含 content（cat）。精确解包 body.entry。 */
  getEntry: async (namespace: string, path: string): Promise<ContextEntry> => {
    const body = await contextCall<{ entry?: ContextEntry }>(namespace, 'Get', { path });
    if (body.entry === undefined) throw new Error('server Get response missing entry');
    return body.entry;
  },
  /** 新建/覆盖条目（put，幂等 upsert）。contentType 缺省 text/plain（对齐 CLI）。精确解包 body.meta。 */
  putEntry: async (
    namespace: string,
    path: string,
    input: PutEntryInput,
  ): Promise<ContextEntryMeta> => {
    const entry: Record<string, unknown> = {
      content: input.content,
      contentType: input.contentType ?? 'text/plain',
    };
    if (input.metadata !== undefined) entry.metadata = input.metadata;
    if (input.ifVersion !== undefined) entry.ifVersion = input.ifVersion;
    const body = await contextCall<{ meta?: ContextEntryMeta }>(namespace, 'Write', {
      path,
      entry,
    });
    if (body.meta === undefined) throw new Error('server Write response missing meta');
    return body.meta;
  },
  /** 局部更新条目（patch，浅合并；不存在→not_found）。精确解包 body.meta。 */
  patchEntry: async (
    namespace: string,
    path: string,
    input: PatchEntryInput,
  ): Promise<ContextEntryMeta> => {
    const patch: Record<string, unknown> = {};
    if (input.content !== undefined) patch.content = input.content;
    if (input.metadata !== undefined) patch.metadata = input.metadata;
    if (input.ifVersion !== undefined) patch.ifVersion = input.ifVersion;
    const body = await contextCall<{ meta?: ContextEntryMeta }>(namespace, 'Update', {
      path,
      patch,
    });
    if (body.meta === undefined) throw new Error('server Update response missing meta');
    return body.meta;
  },
};
