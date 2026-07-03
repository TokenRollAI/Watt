/**
 * `watt context ls|cat|put|patch|mount|unmount`（Proto §4.1 ContextProvider / §4.2 ContextRegistry）。
 *
 * 两个挂载点（R3 命令映射表）：
 *  - 消费面（ls/cat/put/patch）→ POST /htbp/context/<ns> `{tool,arguments}`（ContextProvider 四动词）。
 *    htbpCall 硬编码 /htbp/platform/<module>，消费面走 context 子树，故用本文件的 contextCall。
 *  - 管理面（mount/unmount）→ POST /htbp/platform/context `{tool,arguments}`（ContextRegistry），复用 htbpCall。
 *
 * 动词映射（§11.4a：opts/entry/patch 作整体对象，不平铺）：
 *  - ls    → List   arguments:{path, opts:{}}         → Page{items}（ContextEntryMeta）
 *  - cat   → Get    arguments:{path}                   → ContextEntry（含 content）
 *  - put   → Write  arguments:{path, entry:{content, contentType?, metadata?, ifVersion?}}（幂等 upsert §0.4）
 *  - patch → Update arguments:{path, patch:{content?, metadata?, ifVersion?}}（浅合并；不存在→not_found）
 *  - mount → Write  arguments:{mount:{namespace, provider, ttl?, readOnly?, providerConfig?}}
 *  - unmount → Delete arguments:{namespace}
 *
 * 退出码分层（对齐 event.ts/client.ts）：本地无 token → CliError(2)（requireToken）；
 * 服务端非 2xx（含 401/conflict/not_found）→ CliError(1)（contextCall/htbpCall），WattError.message 透传。
 */

import { type HttpDeps, htbpCall } from './client.ts';
import { CliError } from './env.ts';

/** ContextEntryMeta 的最小读投影（ls 展示用；完整字段在服务端）。 */
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

interface EntryPage {
  items: ContextEntryMeta[];
}

/**
 * POST 一个 HTBP 方法调用到 context 消费子树 `<base>/htbp/context/<ns>`（ContextProvider 四动词）。
 * 与 client.ts 的 htbpCall 同构（Bearer + {tool,arguments} + 401 特判 exit 1），只是路径打 context 子树。
 */
export async function contextCall(
  base: string,
  token: string,
  namespace: string,
  tool: string,
  args: Record<string, unknown>,
  deps: HttpDeps = {},
): Promise<unknown> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const url = `${base}/htbp/context/${namespace}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ tool, arguments: args }),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new CliError(`Failed to reach ${url}: ${detail}`, 1);
  }
  if (!res.ok) {
    const detail = await safeErrDetail(res);
    if (res.status === 401) {
      throw new CliError(`Unauthorized (HTTP 401): ${detail}`, 1);
    }
    throw new CliError(`${url} returned HTTP ${res.status}: ${detail}`, 1);
  }
  return res.json();
}

/** 从错误响应体提取 WattError.message（conflict/not_found 等透传给用户）。 */
async function safeErrDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function contextList(
  base: string,
  token: string,
  namespace: string,
  path: string,
  deps: HttpDeps = {},
): Promise<ContextEntryMeta[]> {
  const body = (await contextCall(
    base,
    token,
    namespace,
    'List',
    { path, opts: {} },
    deps,
  )) as EntryPage;
  return body.items;
}

export async function contextGet(
  base: string,
  token: string,
  namespace: string,
  path: string,
  deps: HttpDeps = {},
): Promise<ContextEntry> {
  const body = (await contextCall(base, token, namespace, 'Get', { path }, deps)) as {
    entry?: ContextEntry;
  };
  // 服务端 Get 返回 { entry }（context-routes.ts，gateway test 锁定）。精确解包，不兜底 body 本身。
  if (body.entry === undefined) {
    throw new CliError('server Get response missing entry', 1);
  }
  return body.entry;
}

/** put 的 entry 输入（Write：ContextEntryInput）。 */
export interface PutEntryInput {
  content: string;
  contentType?: string;
  metadata?: Record<string, string>;
  ifVersion?: string;
}

export async function contextPut(
  base: string,
  token: string,
  namespace: string,
  path: string,
  input: PutEntryInput,
  deps: HttpDeps = {},
): Promise<ContextEntryMeta> {
  // ContextEntryInput.contentType 必填（Proto §4.1）；CLI 缺省补 text/plain。
  const entry: Record<string, unknown> = {
    content: input.content,
    contentType: input.contentType ?? 'text/plain',
  };
  if (input.metadata !== undefined) entry.metadata = input.metadata;
  if (input.ifVersion !== undefined) entry.ifVersion = input.ifVersion;
  const body = (await contextCall(base, token, namespace, 'Write', { path, entry }, deps)) as {
    meta?: ContextEntryMeta;
  };
  // 服务端消费面 Write 返回 { meta }（context-routes.ts，其 gateway test 已锁定该形状）。
  // 精确解包 body.meta：不再兜底 body 本身——双形态兼容会掩盖两侧漂移（曾两次致线上 bug）。
  if (body.meta === undefined) {
    throw new CliError('server Write response missing meta', 1);
  }
  return body.meta;
}

/** patch 的输入（Update：ContextPatch）。content 可选（只改 metadata 时省略）。 */
export interface PatchInput {
  content?: string;
  metadata?: Record<string, string>;
  ifVersion?: string;
}

export async function contextPatch(
  base: string,
  token: string,
  namespace: string,
  path: string,
  input: PatchInput,
  deps: HttpDeps = {},
): Promise<ContextEntryMeta> {
  const patch: Record<string, unknown> = {};
  if (input.content !== undefined) patch.content = input.content;
  if (input.metadata !== undefined) patch.metadata = input.metadata;
  if (input.ifVersion !== undefined) patch.ifVersion = input.ifVersion;
  const body = (await contextCall(base, token, namespace, 'Update', { path, patch }, deps)) as {
    meta?: ContextEntryMeta;
  };
  // 服务端消费面 Update 返回 { meta }（context-routes.ts，gateway test 锁定）。精确解包，见 contextPut。
  if (body.meta === undefined) {
    throw new CliError('server Update response missing meta', 1);
  }
  return body.meta;
}

/** NamespaceMount 的读投影（mount 回显 / unmount 无 body）。 */
export interface NamespaceMount {
  namespace: string;
  provider: string;
  providerConfig?: Record<string, unknown>;
  ttl?: number;
  readOnly?: boolean;
}

export interface MountInput {
  namespace: string;
  provider: string;
  ttl?: number;
  readOnly?: boolean;
  providerConfig?: Record<string, unknown>;
}

export async function contextMount(
  base: string,
  token: string,
  input: MountInput,
  deps: HttpDeps = {},
): Promise<NamespaceMount> {
  const mount: Record<string, unknown> = {
    namespace: input.namespace,
    provider: input.provider,
  };
  if (input.ttl !== undefined) mount.ttl = input.ttl;
  if (input.readOnly !== undefined) mount.readOnly = input.readOnly;
  if (input.providerConfig !== undefined) mount.providerConfig = input.providerConfig;
  // 管理面走 platform 子树（htbpCall → /htbp/platform/context），ContextRegistry.Write。
  // 服务端返回 { mount }（routes.ts platform context Write，gateway context-routes.test.ts 锁定）。
  const body = (await htbpCall(base, token, 'context', 'Write', { mount }, deps)) as {
    mount?: NamespaceMount;
  };
  if (body.mount === undefined) {
    throw new CliError('server mount response missing mount', 1);
  }
  return body.mount;
}

export async function contextUnmount(
  base: string,
  token: string,
  namespace: string,
  deps: HttpDeps = {},
): Promise<unknown> {
  return htbpCall(base, token, 'context', 'Delete', { namespace }, deps);
}

/** ls 的人类可读行（uri / contentType / version / 大小）。 */
export function formatEntryMetaLine(m: ContextEntryMeta): string {
  return `${m.uri}\t${m.contentType}\t${m.version}\t${m.size ?? '-'}`;
}

export function formatEntryListHuman(items: ContextEntryMeta[]): string {
  if (!items.length) return '(no entries)';
  return items.map(formatEntryMetaLine).join('\n');
}

/**
 * 解析可重复的 `--metadata k=v`（commander collect）为 Record。
 * 无 `=` 或空键 → CliError(2)（本地参数错误，对齐 --settings 校验先例）。
 */
export function parseMetadata(pairs: string[] | undefined): Record<string, string> | undefined {
  if (!pairs?.length) return undefined;
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new CliError(`--metadata must be in key=value form, got "${pair}"`, 2);
    }
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}
