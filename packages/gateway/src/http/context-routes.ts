/**
 * Context Layer 路由（Proto §4.1 ContextProvider / §4.2 ContextRegistry + §11.3a HTBP 绑定）。
 *
 * 两个挂载点（调研 §R3）：
 * - `/htbp/platform/context`：ContextRegistry 管理面（mount/unmount 等），POST {tool,arguments}。
 *   五动词 List/Get/Write/Update/Delete → CONTEXT_REGISTRY DO RPC。资源 platform://context。
 *   tool→action：List/Get=read；Write/Update/Delete=manage（对齐 routes.ts platform 子树）。
 * - `/htbp/context/<namespace>/...`：消费面，POST {tool,arguments}。四动词 List/Get/Write/Update
 *   （+ provider 声明的 Search）→ 按 mount.provider 构造 provider 调用。namespace 可含 '/'
 *   （"feedback/bugs"），故用通配 `/htbp/context/*` 自行解析路径段（尾段之外均为 namespace）。
 *   资源 context://<ns>/<path>，读动词 → 'read'、写动词 → 'write'（DoD §5 "context:// read/write"）。
 *
 * ~help（DoD §5 项 3，§11.3a 渐进发现义务）：`GET /htbp/context/<ns>/~help` → text/plain
 *   Help DSL（core generateContextHelp）。**实现自由决策**：~help 免认证（§11.3a 渐进发现精神——
 *   调用方需先能读到能力清单才能构造带权调用；help 只暴露方法形状不含数据，无泄漏面）。因此
 *   ~help 注册在认证中间件之前（记 doc-gap 候选：~help 鉴权层级规范未明）。
 *
 * 错误 = HTTP 状态（httpStatusFor）+ 裸 WattError（对齐 routes.ts / bare-watterror-body 决策）。
 */

import {
  type ContextCapabilities,
  contextEntryInputSchema,
  contextPatchSchema,
  generateContextHelp,
  type NamespaceMount,
} from '@watt/core';
import { type WattError, wattError } from '@watt/shared';
import { Hono } from 'hono';
import { Authorizer } from '../authz/authorizer.ts';
import { PolicyStore } from '../authz/policy-store.ts';
import type { ContextProvider, ListOptions } from '../context/provider.ts';
import { ObjectContextProvider } from '../context/providers/object.ts';
import { StructuredContextProvider } from '../context/providers/structured.ts';
import {
  type Embedder,
  VectorContextProvider,
  type VectorIndex,
  type VectorMatch,
  type VectorRecord,
} from '../context/providers/vector.ts';
import type { Bindings } from '../env.ts';
import { type AuthVars, authMiddleware } from './auth.ts';
import { forbiddenResponse, wattErrorResponse } from './errors.ts';

/** embedding 模型（1024 维 bge-m3，与 Vectorize 索引一致，调研 §3）。 */
const EMBED_MODEL = '@cf/baai/bge-m3';

function isWattError(v: unknown): v is WattError {
  return typeof v === 'object' && v !== null && 'code' in v && 'message' in v && 'retryable' in v;
}

/** HTBP 方法调用体：{"tool":"<Method>","arguments":{...}}。 */
interface HtbpCall {
  tool?: string;
  arguments?: Record<string, unknown>;
}

async function readCall(c: {
  req: { json: () => Promise<unknown> };
}): Promise<HtbpCall | WattError> {
  try {
    return (await c.req.json()) as HtbpCall;
  } catch {
    return wattError('invalid_argument', 'request body must be JSON', false);
  }
}

// ── vector provider 适配器：真实 env 绑定 → provider 窄接口（vector.ts Embedder/VectorIndex）─
// 单测经窄接口注入 fake；此处把 ambient Vectorize/Ai 绑定收窄，本地 miniflare 对 Vectorize
// 只 WARNING（toolchain §10），真实召回验证留部署冒烟。

function makeEmbedder(ai: Bindings['AI']): Embedder {
  return {
    async embed(text: string): Promise<number[]> {
      // Workers AI bge-m3 → { data: number[][] }（单条文本取第 0 条）。
      const out = (await ai.run(EMBED_MODEL, { text: [text] })) as { data: number[][] };
      return out.data[0] ?? [];
    },
  };
}

function makeVectorIndex(index: Bindings['VECTORIZE_CONTEXT']): VectorIndex {
  return {
    async upsert(vectors: VectorRecord[]): Promise<unknown> {
      return await index.upsert(vectors);
    },
    async query(values: number[], opts: { topK: number }): Promise<{ matches: VectorMatch[] }> {
      const res = await index.query(values, { topK: opts.topK, returnMetadata: 'all' });
      const matches: VectorMatch[] = res.matches.map((m) => ({
        id: m.id,
        score: m.score,
        metadata: (m.metadata ?? {}) as Record<string, string>,
      }));
      return { matches };
    },
    async getByIds(ids: string[]): Promise<VectorRecord[]> {
      const recs = await index.getByIds(ids);
      return recs.map((r) => ({
        id: r.id,
        values: (r.values as number[] | undefined) ?? [],
        metadata: (r.metadata ?? {}) as Record<string, string>,
      }));
    },
  };
}

/**
 * 按 mount.provider 构造消费面 provider（object/structured/vector）。
 * 未知 provider id（plugin provider 尚未落地）→ unavailable（501 语义）。
 */
function buildProvider(
  provider: string,
  namespace: string,
  env: Bindings,
): ContextProvider | WattError {
  switch (provider) {
    case 'object':
      return new ObjectContextProvider(env.R2_CONTEXT_OBJECTS, namespace);
    case 'structured':
      return new StructuredContextProvider(env.DB_CONTEXT, namespace);
    case 'vector':
      return new VectorContextProvider(
        makeVectorIndex(env.VECTORIZE_CONTEXT),
        makeEmbedder(env.AI),
        namespace,
      );
    default:
      return wattError('unavailable', `unknown context provider: ${provider}`, false);
  }
}

/** 消费面 provider → capabilities（Help DSL 生成用）。 */
function providerCapabilities(provider: string): ContextCapabilities {
  switch (provider) {
    case 'vector':
      return { search: true, delete: false };
    case 'object':
    case 'structured':
      return { search: false, delete: true };
    default:
      return {};
  }
}

/** 消费面 tool → 授权动作（读动词 read / 写动词 write）；未知 tool → undefined。 */
const CONTEXT_TOOL_ACTIONS: Record<string, 'read' | 'write'> = {
  List: 'read',
  Get: 'read',
  Search: 'read',
  Write: 'write',
  Update: 'write',
};

/** 写动词集合（readOnly mount 对其直接拒绝）。 */
const WRITE_VERBS = new Set(['Write', 'Update']);

export function contextRoutes(): Hono<{ Bindings: Bindings; Variables: AuthVars }> {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVars }>();

  // ── ~help（免认证，注册在认证中间件之前，§11.3a 渐进发现）───────────────
  // GET /htbp/context/<ns>/~help → 200 text/plain Help DSL。未挂载 ns → 404。
  // 通配捕获 ns（含 '/'）：路径尾段固定为 "~help"，其余为 namespace。
  app.get('/htbp/context/*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (!path.endsWith('/~help')) return await next();
    const nsPart = path.slice('/htbp/context/'.length, -'/~help'.length);
    const namespace = decodeURIComponent(nsPart);
    if (namespace === '') {
      return wattErrorResponse(c, wattError('not_found', 'no namespace for ~help', false));
    }
    const registry = c.env.CONTEXT_REGISTRY.get(c.env.CONTEXT_REGISTRY.idFromName('registry'));
    const mount = (await registry.get(namespace)) as NamespaceMount | WattError;
    if (isWattError(mount)) return wattErrorResponse(c, mount);
    const help = generateContextHelp(namespace, providerCapabilities(mount.provider));
    return c.text(help, 200, { 'content-type': 'text/plain; charset=utf-8' });
  });

  // 以下路由全过认证中间件（消费面读写均需鉴权）。
  app.use('/htbp/context/*', authMiddleware());

  // ── POST /htbp/context/<namespace> → 消费面四动词（+ Search）────────────
  app.post('/htbp/context/*', async (c) => {
    const claims = c.get('claims');
    const authorizer = new Authorizer(new PolicyStore(c.env.DB_POLICIES));

    const path = new URL(c.req.url).pathname;
    const nsPart = path.slice('/htbp/context/'.length);
    const namespace = decodeURIComponent(nsPart);
    if (namespace === '') {
      return wattErrorResponse(c, wattError('invalid_argument', 'namespace is required', false));
    }

    const call = await readCall(c);
    if (isWattError(call)) return wattErrorResponse(c, call);
    const tool = call.tool;
    const args = call.arguments ?? {};

    // 未知 tool → 先判 invalid_argument（鉴权前，避免 read-only 调用者误收 403，对齐 routes.ts）。
    const action = tool ? CONTEXT_TOOL_ACTIONS[tool] : undefined;
    if (action === undefined) {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', `unknown tool: ${String(tool)}`, false),
      );
    }

    // resolve/get mount（不存在或 TTL 过期 → 404 not_found，惰性回收在 DO 内）。
    const registry = c.env.CONTEXT_REGISTRY.get(c.env.CONTEXT_REGISTRY.idFromName('registry'));
    const mount = (await registry.get(namespace)) as NamespaceMount | WattError;
    if (isWattError(mount)) return wattErrorResponse(c, mount);

    // 权限拦截：资源 context://<ns>/<path>（path 从 arguments 取，缺省用 ns 根）。
    const resourcePath = typeof args.path === 'string' ? args.path : '';
    const resource = `context://${namespace}/${resourcePath}`;
    const decision = await authorizer.check(claims, resource, action);
    if (!decision.allow) {
      return forbiddenResponse(c, decision.reason ?? `access denied on ${resource}`);
    }

    // readOnly mount 对写动词直接拒（**实现声明**：用 permission_denied 而非 invalid_argument——
    // 语义是"此挂载不授予写权限"，与 authorizer deny 同类，403 更贴切；记 doc-gap 候选）。
    if (mount.readOnly && WRITE_VERBS.has(tool as string)) {
      return forbiddenResponse(c, `namespace is mounted read-only: ${namespace}`);
    }

    const provider = buildProvider(mount.provider, namespace, c.env);
    if (isWattError(provider)) return wattErrorResponse(c, provider);

    switch (tool) {
      case 'List': {
        const opts = (args.opts ?? {}) as ListOptions;
        const p = typeof args.path === 'string' ? args.path : '';
        const page = await provider.list(p, opts);
        if (isWattError(page)) return wattErrorResponse(c, page);
        return c.json(page);
      }
      case 'Get': {
        const p = args.path;
        if (typeof p !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'path is required', false));
        }
        const entry = await provider.get(p);
        if (isWattError(entry)) return wattErrorResponse(c, entry);
        return c.json({ entry });
      }
      case 'Write': {
        const p = args.path;
        if (typeof p !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'path is required', false));
        }
        const parsed = contextEntryInputSchema.safeParse(args.entry);
        if (!parsed.success) {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', `invalid entry: ${parsed.error.message}`, false),
          );
        }
        const meta = await provider.write(p, parsed.data);
        if (isWattError(meta)) return wattErrorResponse(c, meta);
        return c.json({ meta });
      }
      case 'Update': {
        const p = args.path;
        if (typeof p !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'path is required', false));
        }
        const parsed = contextPatchSchema.safeParse(args.patch);
        if (!parsed.success) {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', `invalid patch: ${parsed.error.message}`, false),
          );
        }
        const meta = await provider.update(p, parsed.data);
        if (isWattError(meta)) return wattErrorResponse(c, meta);
        return c.json({ meta });
      }
      case 'Search': {
        // Search 仅 provider 声明该能力时暴露（vector）；否则 invalid_argument（对齐"未知 tool"面）。
        if (provider.search === undefined) {
          return wattErrorResponse(
            c,
            wattError(
              'invalid_argument',
              `provider does not support Search: ${mount.provider}`,
              false,
            ),
          );
        }
        const query = args.query;
        if (typeof query !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'query is required', false));
        }
        const opts = (args.opts ?? {}) as ListOptions;
        const page = await provider.search(query, opts);
        if (isWattError(page)) return wattErrorResponse(c, page);
        return c.json(page);
      }
    }
  });

  return app;
}
