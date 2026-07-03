/**
 * Platform API 路由（Proto §11.3a HTBP 绑定 + §6/§10）。
 *
 * 规范形态：`/htbp/platform/<module>`，`POST {"tool":"<Method>","arguments":{...}}`（§11.3a L969–973）。
 * 错误 = HTTP 状态 + 裸 WattError（§11.3 / bare-watterror-body 决策）。
 *
 * 注意（Docs 对齐）：任务提示写作 `/v1/...`，但 Proto §11.3a 规范路径是 `/htbp/platform/*`
 * 且调研报告 §8 的 CLI 端点映射亦指向 `/htbp/platform/{policy,audit}`。宪法优先（LOOP 纪律 1）：
 * 采用 `/htbp/platform/*` HTBP 规范形态；whoami 无规范端点，提供 `GET /htbp/platform/whoami`
 * 便捷读端点（CLI 可本地解码或在线校验，调研报告 §8）。
 *
 * 资源 URI（调研报告 §8.1 / §0.1）：platform://policy、platform://audit。
 * action：List/Get → 'read'；Write/Update/Delete → 'manage'（§6.1 action 集合）。
 */

import type { EventInput, NamespaceMount, Policy, Subscription } from '@watt/core';
import {
  channelConfigSchema,
  eventInputSchema,
  namespaceMountSchema,
  policySchema,
  subscriptionSchema,
} from '@watt/core';
import { type WattError, wattError } from '@watt/shared';
import { Hono } from 'hono';
import { Authorizer } from '../authz/authorizer.ts';
import { IdentityMapper } from '../authz/identity-mapper.ts';
import { jwksResponse, loadPlatformKeys } from '../authz/keys.ts';
import { type ListOptions, PolicyStore } from '../authz/policy-store.ts';
import { ensureSeedPolicy } from '../authz/seed.ts';
import type { Bindings } from '../env.ts';
import { type ListOptions as ChannelListOptions, ChannelStore } from '../event/channel-store.ts';
import { publish } from '../event/event-bus.ts';
import { type ListOptions as EventListOptions, EventStore } from '../event/event-store.ts';
import { type AuthVars, authMiddleware } from './auth.ts';
import { forbiddenResponse, wattErrorResponse } from './errors.ts';

const RES_POLICY = 'platform://policy';
const RES_AUDIT = 'platform://audit';
const RES_EVENT = 'platform://event';
const RES_CHANNEL = 'platform://channel';
const RES_CONTEXT = 'platform://context';

function isWattError(v: unknown): v is WattError {
  return typeof v === 'object' && v !== null && 'code' in v && 'message' in v && 'retryable' in v;
}

/** HTBP 方法调用体：{"tool":"<Method>","arguments":{...}}。 */
interface HtbpCall {
  tool?: string;
  arguments?: Record<string, unknown>;
}

export function platformRoutes(): Hono<{ Bindings: Bindings; Variables: AuthVars }> {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVars }>();

  // ── GET /.well-known/jwks.json（公开，无认证）──────────────────────────
  app.get('/.well-known/jwks.json', async (c) => {
    let keys: Awaited<ReturnType<typeof loadPlatformKeys>>;
    try {
      keys = await loadPlatformKeys(c.env);
    } catch {
      return wattErrorResponse(
        c,
        wattError('unavailable', 'platform signing key is not configured', false),
      );
    }
    return c.json(jwksResponse(keys));
  });

  // 以下路由全过认证中间件 + 种子引导（首次请求幂等）。
  app.use('/htbp/platform/*', authMiddleware());
  app.use('/htbp/platform/*', async (c, next) => {
    // 种子引导（§6.5c）：首次请求/部署后幂等初始化。放认证后、业务前。
    const store = new PolicyStore(c.env.DB_POLICIES);
    const identities = new IdentityMapper(c.env.DB_POLICIES);
    await ensureSeedPolicy(store, identities, c.env.WATT_ADMIN_PRINCIPAL);
    await next();
  });

  // ── GET /htbp/platform/whoami → CallContext 摘要 ───────────────────────
  app.get('/htbp/platform/whoami', (c) => {
    const ctx = c.get('callContext');
    return c.json({
      principal: ctx.principal,
      roles: ctx.roles,
      traceId: ctx.traceId,
      agent: ctx.agent ?? null,
    });
  });

  // ── POST /htbp/platform/policy → PolicyStore 四动词 + Delete ───────────
  // tool → action 映射（§6.4d：List/Get=read，写动词=manage）。不在表中的 tool 名
  // 在鉴权前即判 invalid_argument（read-only 调用者不会先收到 403，finding [MINOR]）。
  const TOOL_ACTIONS: Record<string, string> = {
    List: 'read',
    Get: 'read',
    Write: 'manage',
    Update: 'manage',
    Delete: 'manage',
  };
  app.post('/htbp/platform/policy', async (c) => {
    const claims = c.get('claims');
    const store = new PolicyStore(c.env.DB_POLICIES);
    const authorizer = new Authorizer(store);

    let call: HtbpCall;
    try {
      call = (await c.req.json()) as HtbpCall;
    } catch {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', 'request body must be JSON', false),
      );
    }
    const tool = call.tool;
    const args = call.arguments ?? {};

    // 未知 tool → 先判 invalid_argument（在鉴权之前，避免 read-only 调用者误收 403）。
    const action = tool ? TOOL_ACTIONS[tool] : undefined;
    if (action === undefined) {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', `unknown tool: ${String(tool)}`, false),
      );
    }

    const decision = await authorizer.check(claims, RES_POLICY, action);
    if (!decision.allow) {
      return forbiddenResponse(c, decision.reason ?? 'access denied on platform://policy');
    }

    switch (tool) {
      case 'List': {
        const opts = (args.opts ?? {}) as ListOptions;
        const page = await store.list(opts);
        if (isWattError(page)) return wattErrorResponse(c, page);
        return c.json(page);
      }
      case 'Get': {
        const id = args.id;
        if (typeof id !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'id is required', false));
        }
        const policy = await store.get(id);
        if (policy === null) {
          return wattErrorResponse(c, wattError('not_found', `policy not found: ${id}`, false));
        }
        return c.json({ policy });
      }
      case 'Write': {
        const parsed = policySchema.safeParse(args.policy);
        if (!parsed.success) {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', `invalid policy: ${parsed.error.message}`, false),
          );
        }
        const written = await store.write(parsed.data as Policy);
        return c.json({ policy: written });
      }
      case 'Update': {
        const id = args.id;
        if (typeof id !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'id is required', false));
        }
        // patch 经 schema 校验（id 不可改，其余字段可选、严格键集）——防写入畸形 actions 等。
        const parsedPatch = policySchema
          .omit({ id: true })
          .partial()
          .strict()
          .safeParse(args.patch ?? {});
        if (!parsedPatch.success) {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', `invalid patch: ${parsedPatch.error.message}`, false),
          );
        }
        const result = await store.update(id, parsedPatch.data);
        if (isWattError(result)) return wattErrorResponse(c, result);
        return c.json({ policy: result });
      }
      case 'Delete': {
        const id = args.id;
        if (typeof id !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'id is required', false));
        }
        const result = await store.delete(id);
        if (isWattError(result)) return wattErrorResponse(c, result);
        return c.json(result);
      }
    }
  });

  // ── POST /htbp/platform/audit → AuditLog（Phase 1 先通接口，数据面 Phase 6）─
  app.post('/htbp/platform/audit', async (c) => {
    const claims = c.get('claims');
    const store = new PolicyStore(c.env.DB_POLICIES);
    const authorizer = new Authorizer(store);

    let call: HtbpCall;
    try {
      call = (await c.req.json()) as HtbpCall;
    } catch {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', 'request body must be JSON', false),
      );
    }
    const decision = await authorizer.check(claims, RES_AUDIT, 'read');
    if (!decision.allow) {
      return forbiddenResponse(c, decision.reason ?? 'access denied on platform://audit');
    }
    if (call.tool !== 'List') {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', `unknown tool: ${String(call.tool)}`, false),
      );
    }
    // Phase 1：数据面 Phase 6 才完整；返回空 Page 形状 { items }（§0.2，无 cursor 分页）。
    return c.json({ items: [] });
  });

  // ── POST /htbp/platform/event → EventStore + EventBus + EventRouter（§2.3/§2.4）─
  // tool → action（§6.4d）：List/Get/ListSubscriptions=read；Publish/Subscribe/Unsubscribe=manage。
  // Publish 的出站 event:// write 二次判定在 event-bus publish 内部（对 type=outbound.message）。
  const EVENT_TOOL_ACTIONS: Record<string, string> = {
    List: 'read',
    Get: 'read',
    ListSubscriptions: 'read',
    Publish: 'manage',
    Subscribe: 'manage',
    Unsubscribe: 'manage',
  };
  app.post('/htbp/platform/event', async (c) => {
    const claims = c.get('claims');
    const store = new PolicyStore(c.env.DB_POLICIES);
    const authorizer = new Authorizer(store);

    let call: HtbpCall;
    try {
      call = (await c.req.json()) as HtbpCall;
    } catch {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', 'request body must be JSON', false),
      );
    }
    const tool = call.tool;
    const args = call.arguments ?? {};

    const action = tool ? EVENT_TOOL_ACTIONS[tool] : undefined;
    if (action === undefined) {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', `unknown tool: ${String(tool)}`, false),
      );
    }
    const decision = await authorizer.check(claims, RES_EVENT, action);
    if (!decision.allow) {
      return forbiddenResponse(c, decision.reason ?? 'access denied on platform://event');
    }

    const router = c.env.EVENT_ROUTER.get(c.env.EVENT_ROUTER.idFromName('router'));

    switch (tool) {
      case 'List': {
        const opts = (args.opts ?? {}) as EventListOptions;
        const page = await new EventStore(c.env.DB_EVENTS).list(opts);
        if (isWattError(page)) return wattErrorResponse(c, page);
        return c.json(page);
      }
      case 'Get': {
        const eventId = args.eventId;
        if (typeof eventId !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'eventId is required', false));
        }
        const event = await new EventStore(c.env.DB_EVENTS).get(eventId);
        if (isWattError(event)) return wattErrorResponse(c, event);
        return c.json({ event });
      }
      case 'Publish': {
        const parsedEvent = eventInputSchema.safeParse(args.event);
        if (!parsedEvent.success) {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', `invalid event: ${parsedEvent.error.message}`, false),
          );
        }
        // §2.3 规约（规范性）：外部系统经 Platform API（Bearer/OAuth）直接 Publish 时，
        // 事件被规约为 source.kind='webhook'，与入站 webhook 同权处理——调用方自报的
        // system/agent/cron 等 kind 不得命中 sourceKind 订阅。Phase 2 只有 user/admin token，
        // 无豁免面，故一律覆写。Phase 4 引入 agent token（claims.agent 字段）后，由 claims
        // 区分 agent 出站（type=outbound.message，走出站鉴权而非 webhook 规约）的豁免。
        const eventInput: EventInput = {
          ...(parsedEvent.data as EventInput),
          source: { ...parsedEvent.data.source, kind: 'webhook' },
        };
        const result = await publish(eventInput, {
          store: new EventStore(c.env.DB_EVENTS),
          authorizer,
          queue: {
            async send(event) {
              await c.env.QUEUE_EVENTS.send(event);
            },
          },
          claims,
          genId: () => crypto.randomUUID(),
          now: () => new Date().toISOString(),
          genTraceId: () => crypto.randomUUID(),
          traceId: c.req.header('X-Watt-Trace'),
        });
        if (isWattError(result)) return wattErrorResponse(c, result);
        return c.json(result);
      }
      case 'Subscribe': {
        const parsed = subscriptionSchema.safeParse(args.subscription);
        if (!parsed.success) {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', `invalid subscription: ${parsed.error.message}`, false),
          );
        }
        const out = await router.subscribe(parsed.data as Subscription);
        return c.json(out);
      }
      case 'Unsubscribe': {
        const id = args.subscriptionId;
        if (typeof id !== 'string') {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', 'subscriptionId is required', false),
          );
        }
        await router.unsubscribe(id);
        return c.json({ deleted: true });
      }
      case 'ListSubscriptions': {
        const opts = (args.opts ?? {}) as { limit?: number };
        const page = await router.listSubscriptions(opts);
        return c.json(page);
      }
    }
  });

  // ── POST /htbp/platform/channel → ChannelRegistry 四动词（§2.2）────────
  // tool → action：List/Get=read；Write/Update=manage。
  const CHANNEL_TOOL_ACTIONS: Record<string, string> = {
    List: 'read',
    Get: 'read',
    Write: 'manage',
    Update: 'manage',
  };
  app.post('/htbp/platform/channel', async (c) => {
    const claims = c.get('claims');
    const authorizer = new Authorizer(new PolicyStore(c.env.DB_POLICIES));
    const channels = new ChannelStore(c.env.DB_EVENTS);

    let call: HtbpCall;
    try {
      call = (await c.req.json()) as HtbpCall;
    } catch {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', 'request body must be JSON', false),
      );
    }
    const tool = call.tool;
    const args = call.arguments ?? {};

    const action = tool ? CHANNEL_TOOL_ACTIONS[tool] : undefined;
    if (action === undefined) {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', `unknown tool: ${String(tool)}`, false),
      );
    }
    const decision = await authorizer.check(claims, RES_CHANNEL, action);
    if (!decision.allow) {
      return forbiddenResponse(c, decision.reason ?? 'access denied on platform://channel');
    }

    switch (tool) {
      case 'List': {
        const opts = (args.opts ?? {}) as ChannelListOptions;
        const page = await channels.list(opts);
        if (isWattError(page)) return wattErrorResponse(c, page);
        return c.json(page);
      }
      case 'Get': {
        const channelId = args.channelId;
        if (typeof channelId !== 'string') {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', 'channelId is required', false),
          );
        }
        const config = await channels.get(channelId);
        if (isWattError(config)) return wattErrorResponse(c, config);
        return c.json({ channel: config });
      }
      case 'Write': {
        const parsed = channelConfigSchema.safeParse(args.channel);
        if (!parsed.success) {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', `invalid channel config: ${parsed.error.message}`, false),
          );
        }
        const written = await channels.write(parsed.data);
        return c.json({ channel: written });
      }
      case 'Update': {
        const channelId = args.channelId;
        if (typeof channelId !== 'string') {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', 'channelId is required', false),
          );
        }
        const result = await channels.update(channelId, (args.patch ?? {}) as never);
        if (isWattError(result)) return wattErrorResponse(c, result);
        return c.json({ channel: result });
      }
    }
  });

  // ── POST /htbp/platform/context → ContextRegistry 管理面（§4.2 挂载注册表）───
  // 五动词 List/Get/Write/Update/Delete → CONTEXT_REGISTRY DO RPC（单例 idFromName('registry')）。
  // tool → action：List/Get=read；Write/Update/Delete=manage（对齐 §6.4d，与 policy 管理面同）。
  // 消费面（context://<ns>/<path> 四动词）在 http/context-routes.ts；此处仅挂载管理（platform://context）。
  const CONTEXT_TOOL_ACTIONS: Record<string, string> = {
    List: 'read',
    Get: 'read',
    Write: 'manage',
    Update: 'manage',
    Delete: 'manage',
  };
  app.post('/htbp/platform/context', async (c) => {
    const claims = c.get('claims');
    const authorizer = new Authorizer(new PolicyStore(c.env.DB_POLICIES));

    let call: HtbpCall;
    try {
      call = (await c.req.json()) as HtbpCall;
    } catch {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', 'request body must be JSON', false),
      );
    }
    const tool = call.tool;
    const args = call.arguments ?? {};

    const action = tool ? CONTEXT_TOOL_ACTIONS[tool] : undefined;
    if (action === undefined) {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', `unknown tool: ${String(tool)}`, false),
      );
    }
    const decision = await authorizer.check(claims, RES_CONTEXT, action);
    if (!decision.allow) {
      return forbiddenResponse(c, decision.reason ?? 'access denied on platform://context');
    }

    const registry = c.env.CONTEXT_REGISTRY.get(c.env.CONTEXT_REGISTRY.idFromName('registry'));

    switch (tool) {
      case 'List': {
        const opts = (args.opts ?? {}) as { limit?: number };
        const page = await registry.list(opts);
        return c.json(page);
      }
      case 'Get': {
        const namespace = args.namespace;
        if (typeof namespace !== 'string') {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', 'namespace is required', false),
          );
        }
        const mount = await registry.get(namespace);
        if (isWattError(mount)) return wattErrorResponse(c, mount);
        return c.json({ mount });
      }
      case 'Write': {
        const parsed = namespaceMountSchema.safeParse(args.mount);
        if (!parsed.success) {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', `invalid mount: ${parsed.error.message}`, false),
          );
        }
        const written = await registry.write(parsed.data as NamespaceMount);
        if (isWattError(written)) return wattErrorResponse(c, written);
        return c.json({ mount: written });
      }
      case 'Update': {
        const namespace = args.namespace;
        if (typeof namespace !== 'string') {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', 'namespace is required', false),
          );
        }
        // patch 经 schema 校验（namespace 不可改、其余可选、严格键集）——防写入畸形字段。
        const parsedPatch = namespaceMountSchema
          .omit({ namespace: true })
          .partial()
          .strict()
          .safeParse(args.patch ?? {});
        if (!parsedPatch.success) {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', `invalid patch: ${parsedPatch.error.message}`, false),
          );
        }
        const result = await registry.update(
          namespace,
          parsedPatch.data as Partial<NamespaceMount>,
        );
        if (isWattError(result)) return wattErrorResponse(c, result);
        return c.json({ mount: result });
      }
      case 'Delete': {
        const namespace = args.namespace;
        if (typeof namespace !== 'string') {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', 'namespace is required', false),
          );
        }
        await registry.delete(namespace);
        return c.json({ deleted: true });
      }
    }
  });

  return app;
}
