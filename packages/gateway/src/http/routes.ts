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

import type {
  AgentDefinition,
  EventInput,
  ModelProvider,
  NamespaceMount,
  Policy,
  Subscription,
  ToolMount,
} from '@watt/core';
import {
  agentDefinitionSchema,
  channelConfigSchema,
  eventInputSchema,
  expectSpecSchema,
  modelProviderSchema,
  namespaceMountSchema,
  type PluginManifest,
  pluginManifestSchema,
  policySchema,
  schedulerCronJobSchema,
  signalRequestSchema,
  signUserToken,
  spawnRequestSchema,
  subscriptionSchema,
  taskWriteRequestSchema,
  toolMountSchema,
} from '@watt/core';
import { type WattError, wattError } from '@watt/shared';
import { Hono } from 'hono';
import { type ListOptions as AgentListOptions, AgentRegistry } from '../agent/agent-registry.ts';
import { AgentRuntime, defaultRuntimeDeps, type ExpectSpec } from '../agent/agent-runtime.ts';
import { ensureManageDefsSeeded } from '../agent/manage/manage-defs.ts';
import {
  ModelProviderRegistry,
  type ListOptions as ProviderListOptions,
} from '../agent/model-provider.ts';
import { newAuthorizer } from '../audit/audit-sink.ts';
import { AuditStore } from '../audit/audit-store.ts';
import { IdentityMapper } from '../authz/identity-mapper.ts';
import { jwksResponse, loadPlatformKeys } from '../authz/keys.ts';
import { type ListOptions, PolicyStore } from '../authz/policy-store.ts';
import { ensureSeedPolicy } from '../authz/seed.ts';
import type { Bindings } from '../env.ts';
import { type ListOptions as ChannelListOptions, ChannelStore } from '../event/channel-store.ts';
import { publish } from '../event/event-bus.ts';
import { type ListOptions as EventListOptions, EventStore } from '../event/event-store.ts';
import { METRIC_NAMES, type MetricQuery, Metrics } from '../metrics/metrics.ts';
import {
  type ListOptions as PluginListOptions,
  PluginRegistry,
  pluginHealth,
  probeRegistrationHealth,
  toManifest,
} from '../plugin/plugin-registry.ts';
import { ensureBuiltinPluginsSeeded } from '../plugin/plugin-seed.ts';
import { RES_SCHEDULER, SchedulerManager } from '../scheduler/scheduler-manager.ts';
import { SecretStore } from '../secrets/secret-store.ts';
import { defaultManagerDeps, TaskManager } from '../task/task-manager.ts';
import type { ListOptions as TaskListOptions } from '../task/task-store.ts';
import { type ListOptions as ToolListOptions, ToolRegistry } from '../tools/tool-registry.ts';
import { type AuthVars, authMiddleware } from './auth.ts';
import { forbiddenResponse, wattErrorResponse } from './errors.ts';

const RES_POLICY = 'platform://policy';
const RES_AUDIT = 'platform://audit';
const RES_EVENT = 'platform://event';
const RES_CHANNEL = 'platform://channel';
const RES_CONTEXT = 'platform://context';
const RES_TOOL = 'platform://tool';
const RES_AGENT = 'platform://agent';
const RES_PROVIDER = 'platform://provider';
const RES_TASK = 'platform://task';
const RES_METRICS = 'platform://metrics';
const RES_PLUGIN = 'platform://plugin';
const RES_SECRET = 'platform://secret';

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
    // manage/* 内置 AgentDefinition 种子（M10）：与策略种子同幂等语义，供 manage/cron 等对话入口 spawn。
    await ensureManageDefsSeeded(new AgentRegistry(c.env.DB_PROVIDERS));
    // 内置 Plugin 种子（M11）：webhook/feishu channel-adapter 注册为 built_in Plugin，供 plugin list/health。
    await ensureBuiltinPluginsSeeded(new PluginRegistry(c.env.DB_PROVIDERS));
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
    // MapIdentity（§6.3 渠道身份→principal 写入口）：绑定授权域数据，与写策略同为 manage 动作。
    // 复用 platform://policy 资源（身份映射是授权配置的一部分，不新增资源 URI）。
    MapIdentity: 'manage',
  };
  app.post('/htbp/platform/policy', async (c) => {
    const claims = c.get('claims');
    const store = new PolicyStore(c.env.DB_POLICIES);
    const authorizer = newAuthorizer(c.env, c.get('callContext').traceId);

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
      case 'MapIdentity': {
        // 渠道身份→principal 绑定（§6.3）。arguments:{channel, channelUserId, principal}。
        const { channel, channelUserId, principal } = args;
        if (
          typeof channel !== 'string' ||
          typeof channelUserId !== 'string' ||
          typeof principal !== 'string'
        ) {
          return wattErrorResponse(
            c,
            wattError(
              'invalid_argument',
              'channel, channelUserId and principal are required',
              false,
            ),
          );
        }
        const identities = new IdentityMapper(c.env.DB_POLICIES);
        await identities.bindChannelIdentity(channel, channelUserId, principal);
        return c.json({ channel, channelUserId, principal });
      }
    }
  });

  // ── POST /htbp/platform/audit → AuditLog（§10 List/Get，R23 数据面接真实查询）─
  // List/Get 均为读动作（§6.4d）；资源 platform://audit。数据面挂 DB_AUDIT（AuditStore）。
  app.post('/htbp/platform/audit', async (c) => {
    const claims = c.get('claims');
    const authorizer = newAuthorizer(c.env, c.get('callContext').traceId);

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
    if (tool !== 'List' && tool !== 'Get') {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', `unknown tool: ${String(tool)}`, false),
      );
    }
    const decision = await authorizer.check(claims, RES_AUDIT, 'read');
    if (!decision.allow) {
      return forbiddenResponse(c, decision.reason ?? 'access denied on platform://audit');
    }

    const args = call.arguments ?? {};
    const auditStore = new AuditStore(c.env.DB_AUDIT);
    if (tool === 'Get') {
      const recordId = args.recordId;
      if (typeof recordId !== 'string') {
        return wattErrorResponse(c, wattError('invalid_argument', 'recordId is required', false));
      }
      const record = await auditStore.get(recordId);
      if (isWattError(record)) return wattErrorResponse(c, record);
      return c.json({ record });
    }
    // List：filter principal/agent/resource/decision + limit（§10 / §0.2 Page{items}）。
    const opts = (args.opts ?? {}) as { filter?: Record<string, string>; limit?: number };
    const page = await auditStore.list(opts);
    if (isWattError(page)) return wattErrorResponse(c, page);
    return c.json(page);
  });

  // ── POST /htbp/platform/metrics → Metrics.Query（§10，R23 最小面）─────────
  // tool=Query（read）；资源 platform://metrics。tokens/cost 走 usage 表（DB_AUDIT）；events/tasks 走
  //   DB_EVENTS；authz_denials 走 audit_records；cache_hit_rate/tool_calls 本轮空 series（实现声明）。
  app.post('/htbp/platform/metrics', async (c) => {
    const claims = c.get('claims');
    const authorizer = newAuthorizer(c.env, c.get('callContext').traceId);

    let call: HtbpCall;
    try {
      call = (await c.req.json()) as HtbpCall;
    } catch {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', 'request body must be JSON', false),
      );
    }
    if (call.tool !== 'Query') {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', `unknown tool: ${String(call.tool)}`, false),
      );
    }
    const decision = await authorizer.check(claims, RES_METRICS, 'read');
    if (!decision.allow) {
      return forbiddenResponse(c, decision.reason ?? 'access denied on platform://metrics');
    }
    const q = (call.arguments?.query ?? {}) as Partial<MetricQuery>;
    if (
      typeof q.metric !== 'string' ||
      !(METRIC_NAMES as readonly string[]).includes(q.metric) ||
      q.range === undefined ||
      typeof q.range.from !== 'string' ||
      typeof q.range.to !== 'string'
    ) {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', 'query.metric and query.range{from,to} are required', false),
      );
    }
    const metrics = new Metrics(c.env.DB_AUDIT, c.env.DB_EVENTS);
    const series = await metrics.query(q as MetricQuery);
    return c.json({ series });
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
    const authorizer = newAuthorizer(c.env, c.get('callContext').traceId);

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
        // §2.3 规约（规范性）+ §2.1 push 型豁免（R27 关门 C5）：
        //   默认：外部系统经 Platform API（Bearer/OAuth）直接 Publish 时，事件规约为
        //   source.kind='webhook'，与入站 webhook 同权处理——调用方自报的 system/agent/cron
        //   等 kind 不得命中 sourceKind 订阅。
        //   豁免：调用主体是已注册且 enabled 的 channel-adapter plugin（claims.sub=
        //   'plugin:<id>'，pluginToken 由 PluginRegistry.Write 签发）时——push 型 adapter
        //   （飞书 WS 经 CLI connect）自行规约后 Publish，字段义务同 Decode（§2.1），保留其
        //   自报 source.kind；白名单仅 'im'（IM 渠道规约产物），防冒用 system/cron 等特权 kind。
        let publishKind: 'webhook' | 'im' = 'webhook';
        if (parsedEvent.data.source.kind === 'im' && claims.sub.startsWith('plugin:')) {
          const pluginId = claims.sub.slice('plugin:'.length);
          const plugin = await new PluginRegistry(c.env.DB_PROVIDERS).get(pluginId);
          if (!isWattError(plugin) && plugin.kind === 'channel-adapter' && plugin.enabled) {
            publishKind = 'im';
          }
        }
        const eventInput: EventInput = {
          ...(parsedEvent.data as EventInput),
          source: { ...parsedEvent.data.source, kind: publishKind },
        };
        // IdentityMapper.Resolve 接线（§1 L115-116，与 inbound.ts webhook 路径同）：channelUser
        //   存在且 principal 缺省时补齐 principal（channel_identities 命中 → 绑定 principal；未命中
        //   → 'user:anonymous'）。飞书 WS 入站唯一路径 = CLI connect → 此 Publish；缺此注入则
        //   channelUser(open_id) 永不解析，HITL signal Check 因 principal 缺省被拒（MapIdentity 失效）。
        const identities = new IdentityMapper(c.env.DB_POLICIES);
        const result = await publish(eventInput, {
          store: new EventStore(c.env.DB_EVENTS),
          authorizer,
          queue: {
            async send(event) {
              await c.env.QUEUE_EVENTS.send(event);
            },
          },
          claims,
          resolvePrincipal: async (channel, userId) =>
            (await identities.resolve(channel, userId)).principal,
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
    const authorizer = newAuthorizer(c.env, c.get('callContext').traceId);
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
    const authorizer = newAuthorizer(c.env, c.get('callContext').traceId);

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

  // ── POST /htbp/platform/tool → ToolRegistry 管理面（§5.2 工具源挂载注册表）──────
  // 四动词 List/Get/Write/Update → ToolRegistry（D1 watt-providers 库 tool_mounts 表）。
  // tool → action：List/Get=read；Write/Update=manage（对齐 §6.4d，与 policy/context 管理面同）。
  // 资源 URI：platform://tool（挂载管理面）。
  //
  // 重要（边界）：这是 tools **管理面**（挂载 CRUD），资源 platform://tool；与未来 tools
  // **消费面** `/htbp/tools/<mount-path>/...`（工具 List/描述/调用，资源 tool://...，走 tool-bridge
  // 代理 + Check PEP）是两个不同的接口。消费面留代理轮（等 tool-bridge 上游 effect/scope 就绪）。
  const TOOL_TOOL_ACTIONS: Record<string, string> = {
    List: 'read',
    Get: 'read',
    Write: 'manage',
    Update: 'manage',
  };
  app.post('/htbp/platform/tool', async (c) => {
    const claims = c.get('claims');
    const authorizer = newAuthorizer(c.env, c.get('callContext').traceId);
    const registry = new ToolRegistry(c.env.DB_PROVIDERS);

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

    const action = tool ? TOOL_TOOL_ACTIONS[tool] : undefined;
    if (action === undefined) {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', `unknown tool: ${String(tool)}`, false),
      );
    }
    const decision = await authorizer.check(claims, RES_TOOL, action);
    if (!decision.allow) {
      return forbiddenResponse(c, decision.reason ?? 'access denied on platform://tool');
    }

    switch (tool) {
      case 'List': {
        const opts = (args.opts ?? {}) as ToolListOptions;
        const page = await registry.list(opts);
        if (isWattError(page)) return wattErrorResponse(c, page);
        return c.json(page);
      }
      case 'Get': {
        const path = args.path;
        if (typeof path !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'path is required', false));
        }
        const mount = await registry.get(path);
        if (isWattError(mount)) return wattErrorResponse(c, mount);
        return c.json({ mount });
      }
      case 'Write': {
        const parsed = toolMountSchema.safeParse(args.mount);
        if (!parsed.success) {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', `invalid tool mount: ${parsed.error.message}`, false),
          );
        }
        const written = await registry.write(parsed.data as ToolMount);
        return c.json({ mount: written });
      }
      case 'Update': {
        const path = args.path;
        if (typeof path !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'path is required', false));
        }
        // patch 经 schema 校验（path 不可改、其余可选、严格键集）——防写入畸形字段。
        const parsedPatch = toolMountSchema
          .omit({ path: true })
          .partial()
          .strict()
          .safeParse(args.patch ?? {});
        if (!parsedPatch.success) {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', `invalid patch: ${parsedPatch.error.message}`, false),
          );
        }
        const result = await registry.update(path, parsedPatch.data as Partial<ToolMount>);
        if (isWattError(result)) return wattErrorResponse(c, result);
        return c.json({ mount: result });
      }
    }
  });

  // ── POST /htbp/platform/agent → AgentRegistry（§3.1）+ AgentRuntime（§3.2）────────
  // Registry 动词：List/Get/Write/Update；Runtime 动词：Spawn/Send/Status/Terminate/ListInstances。
  // tool → action（§6.4d）：读=read（List/Get/Status/ListInstances）；
  //   manage=Write/Update/Spawn/Send/Terminate（"派生/投递/终止/改定义"均为管理动作）。
  // 资源 URI：platform://agent。Write 时 subscriptions[] 联动 EventRouter.subscribe（§2.3 规则 1）。
  const AGENT_TOOL_ACTIONS: Record<string, string> = {
    List: 'read',
    Get: 'read',
    Status: 'read',
    ListInstances: 'read',
    Write: 'manage',
    Update: 'manage',
    Spawn: 'manage',
    Send: 'manage',
    Terminate: 'manage',
  };
  app.post('/htbp/platform/agent', async (c) => {
    const claims = c.get('claims');
    const authorizer = newAuthorizer(c.env, c.get('callContext').traceId);
    const registry = new AgentRegistry(c.env.DB_PROVIDERS);

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

    const action = tool ? AGENT_TOOL_ACTIONS[tool] : undefined;
    if (action === undefined) {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', `unknown tool: ${String(tool)}`, false),
      );
    }
    const decision = await authorizer.check(claims, RES_AGENT, action);
    if (!decision.allow) {
      return forbiddenResponse(c, decision.reason ?? 'access denied on platform://agent');
    }

    const router = c.env.EVENT_ROUTER.get(c.env.EVENT_ROUTER.idFromName('router'));
    const runtime = new AgentRuntime(defaultRuntimeDeps(c.env));

    switch (tool) {
      // ── Registry（§3.1）──
      case 'List': {
        const opts = (args.opts ?? {}) as AgentListOptions;
        const page = await registry.list(opts);
        if (isWattError(page)) return wattErrorResponse(c, page);
        return c.json(page);
      }
      case 'Get': {
        const name = args.name;
        if (typeof name !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'name is required', false));
        }
        const def = await registry.get(name);
        if (isWattError(def)) return wattErrorResponse(c, def);
        return c.json({ definition: def });
      }
      case 'Write': {
        const parsed = agentDefinitionSchema.safeParse(args.definition);
        if (!parsed.success) {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', `invalid definition: ${parsed.error.message}`, false),
          );
        }
        const written = await registry.write(parsed.data as AgentDefinition, router);
        return c.json({ definition: written });
      }
      case 'Update': {
        const name = args.name;
        if (typeof name !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'name is required', false));
        }
        const parsedPatch = agentDefinitionSchema
          .omit({ name: true })
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
          name,
          parsedPatch.data as Partial<AgentDefinition>,
          router,
        );
        if (isWattError(result)) return wattErrorResponse(c, result);
        return c.json({ definition: result });
      }
      // ── Runtime（§3.2）──
      case 'Spawn': {
        const parsed = spawnRequestSchema.safeParse(args.request);
        if (!parsed.success) {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', `invalid spawn request: ${parsed.error.message}`, false),
          );
        }
        // parent（可选）：派生关系（§3.4 规则 2 / ListInstances tree）——路由透传给 runtime。
        const parent = typeof args.parent === 'string' ? args.parent : undefined;
        // claims 透传（委托链，§6.4a / M10）：manage/* Agent 的工具 execute 用它过 Check + createdBy
        //   （agent 替调用者操作）。非 manage / echo def 忽略 claims，无影响。
        const res = await runtime.spawn(parsed.data, { parent, claims });
        if (isWattError(res)) return wattErrorResponse(c, res);
        return c.json(res);
      }
      case 'Send': {
        const instanceId = args.instanceId;
        if (typeof instanceId !== 'string') {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', 'instanceId is required', false),
          );
        }
        // event 用 eventInputSchema 校验后补齐 Omit 三字段（Send 的 event 是完整信封的最小面）。
        const eventInput = eventInputSchema.safeParse(args.event);
        if (!eventInput.success) {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', `invalid event: ${eventInput.error.message}`, false),
          );
        }
        let expect: ExpectSpec | undefined;
        if (args.expect !== undefined) {
          const parsedExpect = expectSpecSchema.safeParse(args.expect);
          if (!parsedExpect.success) {
            return wattErrorResponse(
              c,
              wattError('invalid_argument', `invalid expect: ${parsedExpect.error.message}`, false),
            );
          }
          expect = parsedExpect.data;
        }
        const event = {
          ...eventInput.data,
          id: crypto.randomUUID(),
          occurredAt: new Date().toISOString(),
          traceId: c.req.header('X-Watt-Trace') ?? crypto.randomUUID(),
        };
        const res = await runtime.send(instanceId, event, expect, undefined, claims);
        if (isWattError(res)) return wattErrorResponse(c, res);
        return c.json(res);
      }
      case 'Status': {
        const instanceId = args.instanceId;
        if (typeof instanceId !== 'string') {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', 'instanceId is required', false),
          );
        }
        const info = await runtime.status(instanceId);
        if (isWattError(info)) return wattErrorResponse(c, info);
        return c.json({ instance: info });
      }
      case 'Terminate': {
        const instanceId = args.instanceId;
        if (typeof instanceId !== 'string') {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', 'instanceId is required', false),
          );
        }
        const cascade = args.cascade === true;
        await runtime.terminate(instanceId, { cascade });
        return c.json({ terminated: true });
      }
      case 'ListInstances': {
        const opts = (args.opts ?? {}) as { limit?: number; tree?: string };
        const page = await runtime.listInstances(opts);
        return c.json(page);
      }
    }
  });

  // ── POST /htbp/platform/task → TaskManager（§8）────────────────────────────
  // 七动词 List/Get/ListDefinitions/Write/Update/Cancel/Signal。
  // tool → action（§6.4d）：List/Get/ListDefinitions=read；Write/Update/Cancel=manage；
  //   Signal=signal（独立 action，与 §1.1 规则 2 的 Check(task://,'signal') 同名——人类确认是
  //   与"管理任务定义/生命周期"不同的授权维度，故不并入 manage）。资源 platform://task。
  const TASK_TOOL_ACTIONS: Record<string, string> = {
    List: 'read',
    Get: 'read',
    ListDefinitions: 'read',
    Write: 'manage',
    Update: 'manage',
    Cancel: 'manage',
    Signal: 'signal',
  };
  app.post('/htbp/platform/task', async (c) => {
    const claims = c.get('claims');
    const authorizer = newAuthorizer(c.env, c.get('callContext').traceId);

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

    const action = tool ? TASK_TOOL_ACTIONS[tool] : undefined;
    if (action === undefined) {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', `unknown tool: ${String(tool)}`, false),
      );
    }
    const decision = await authorizer.check(claims, RES_TASK, action);
    if (!decision.allow) {
      return forbiddenResponse(c, decision.reason ?? 'access denied on platform://task');
    }

    const manager = new TaskManager(defaultManagerDeps(c.env));

    switch (tool) {
      case 'List': {
        const opts = (args.opts ?? {}) as TaskListOptions;
        const page = await manager.list(opts);
        if (isWattError(page)) return wattErrorResponse(c, page);
        return c.json(page);
      }
      case 'Get': {
        const taskId = args.taskId;
        if (typeof taskId !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'taskId is required', false));
        }
        const detail = await manager.get(taskId);
        if (isWattError(detail)) return wattErrorResponse(c, detail);
        return c.json({ task: detail });
      }
      case 'ListDefinitions': {
        return c.json(manager.listDefinitions());
      }
      case 'Write': {
        const parsed = taskWriteRequestSchema.safeParse(args.request);
        if (!parsed.success) {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', `invalid task request: ${parsed.error.message}`, false),
          );
        }
        // createdBy = 调用方 principal（claims.sub，§8 TaskInfo.createdBy）——非入参，防伪造。
        const info = await manager.write(parsed.data, claims.sub);
        if (isWattError(info)) return wattErrorResponse(c, info);
        return c.json({ task: info });
      }
      case 'Update': {
        const taskId = args.taskId;
        if (typeof taskId !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'taskId is required', false));
        }
        const patch = (args.patch ?? {}) as { note?: string };
        const info = await manager.update(taskId, patch);
        if (isWattError(info)) return wattErrorResponse(c, info);
        return c.json({ task: info });
      }
      case 'Cancel': {
        const taskId = args.taskId;
        if (typeof taskId !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'taskId is required', false));
        }
        const reason = typeof args.reason === 'string' ? args.reason : undefined;
        const res = await manager.cancel(taskId, reason);
        if (res && isWattError(res)) return wattErrorResponse(c, res);
        return c.json({ cancelled: true });
      }
      case 'Signal': {
        const taskId = args.taskId;
        if (typeof taskId !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'taskId is required', false));
        }
        const parsed = signalRequestSchema.safeParse(args.signal);
        if (!parsed.success) {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', `invalid signal: ${parsed.error.message}`, false),
          );
        }
        const res = await manager.signal(taskId, parsed.data);
        if (res && isWattError(res)) return wattErrorResponse(c, res);
        return c.json({ signalled: true });
      }
    }
  });

  // ── POST /htbp/platform/scheduler → Scheduler（§7 CronJob）────────────────────
  // 六动词 List/Get/Write/Update/Delete + Trigger。
  // tool → action（§6.4d）：List/Get=read；Write/Update/Delete/Trigger=manage（"登记/改/删/触发"
  //   均为管理动作）。资源 platform://scheduler。CronJob.createdBy 由路由从 claims.sub 注入（防伪造，
  //   与 TaskManager.Write 同）——script grants≤createdBy 不做静态校验（§7 步骤 3，推迟到运行时）。
  const SCHEDULER_TOOL_ACTIONS: Record<string, string> = {
    List: 'read',
    Get: 'read',
    Write: 'manage',
    Update: 'manage',
    Delete: 'manage',
    Trigger: 'manage',
  };
  app.post('/htbp/platform/scheduler', async (c) => {
    const claims = c.get('claims');
    const authorizer = newAuthorizer(c.env, c.get('callContext').traceId);

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

    const action = tool ? SCHEDULER_TOOL_ACTIONS[tool] : undefined;
    if (action === undefined) {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', `unknown tool: ${String(tool)}`, false),
      );
    }
    const decision = await authorizer.check(claims, RES_SCHEDULER, action);
    if (!decision.allow) {
      return forbiddenResponse(c, decision.reason ?? 'access denied on platform://scheduler');
    }

    const scheduler = new SchedulerManager(c.env);

    switch (tool) {
      case 'List': {
        const opts = (args.opts ?? {}) as Record<string, unknown>;
        // Scheduler List 只支持 limit（Hub.listJobs 无 filter/cursor）——对齐 task List 口径：
        //   未声明键给 invalid_argument（不静默丢弃，避免调用方以为 filter 生效实则被吞）。
        for (const key of Object.keys(opts)) {
          if (key !== 'limit') {
            return wattErrorResponse(
              c,
              wattError('invalid_argument', `unknown list option: ${key}`, false),
            );
          }
        }
        const page = await scheduler.list(opts as { limit?: number });
        return c.json(page);
      }
      case 'Get': {
        const jobId = args.jobId;
        if (typeof jobId !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'jobId is required', false));
        }
        const job = await scheduler.get(jobId);
        if (isWattError(job)) return wattErrorResponse(c, job);
        return c.json({ job });
      }
      case 'Write': {
        // createdBy = 调用方 principal（claims.sub，§7 CronJob.createdBy）——非入参，防伪造。
        const merged = { ...(args.job as Record<string, unknown>), createdBy: claims.sub };
        const parsed = schedulerCronJobSchema.safeParse(merged);
        if (!parsed.success) {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', `invalid cron job: ${parsed.error.message}`, false),
          );
        }
        const written = await scheduler.write(parsed.data);
        if (isWattError(written)) return wattErrorResponse(c, written);
        return c.json({ job: written });
      }
      case 'Update': {
        const jobId = args.jobId;
        if (typeof jobId !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'jobId is required', false));
        }
        // patch 经 schema 校验（id/createdBy 不可改、其余可选、严格键集）——防写入畸形字段。
        const parsedPatch = schedulerCronJobSchema
          .omit({ id: true, createdBy: true })
          .partial()
          .strict()
          .safeParse(args.patch ?? {});
        if (!parsedPatch.success) {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', `invalid patch: ${parsedPatch.error.message}`, false),
          );
        }
        const result = await scheduler.update(jobId, parsedPatch.data);
        if (isWattError(result)) return wattErrorResponse(c, result);
        return c.json({ job: result });
      }
      case 'Delete': {
        const jobId = args.jobId;
        if (typeof jobId !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'jobId is required', false));
        }
        await scheduler.delete(jobId);
        return c.json({ deleted: true });
      }
      case 'Trigger': {
        const jobId = args.jobId;
        if (typeof jobId !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'jobId is required', false));
        }
        const result = await scheduler.trigger(jobId);
        if (isWattError(result)) return wattErrorResponse(c, result);
        return c.json(result);
      }
    }
  });

  // ── POST /htbp/platform/provider → ModelProviderRegistry（§9 最小版）────────────
  // tool → action（§6.4d）：List/Get=read；Write/Update/SetDefault=manage。资源 platform://provider。
  const PROVIDER_TOOL_ACTIONS: Record<string, string> = {
    List: 'read',
    Get: 'read',
    Write: 'manage',
    Update: 'manage',
    SetDefault: 'manage',
  };
  app.post('/htbp/platform/provider', async (c) => {
    const claims = c.get('claims');
    const authorizer = newAuthorizer(c.env, c.get('callContext').traceId);
    const registry = new ModelProviderRegistry(c.env.DB_PROVIDERS);

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

    const action = tool ? PROVIDER_TOOL_ACTIONS[tool] : undefined;
    if (action === undefined) {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', `unknown tool: ${String(tool)}`, false),
      );
    }
    const decision = await authorizer.check(claims, RES_PROVIDER, action);
    if (!decision.allow) {
      return forbiddenResponse(c, decision.reason ?? 'access denied on platform://provider');
    }

    switch (tool) {
      case 'List': {
        const opts = (args.opts ?? {}) as ProviderListOptions;
        const page = await registry.list(opts);
        if (isWattError(page)) return wattErrorResponse(c, page);
        return c.json(page);
      }
      case 'Get': {
        const providerId = args.providerId;
        if (typeof providerId !== 'string') {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', 'providerId is required', false),
          );
        }
        const provider = await registry.get(providerId);
        if (isWattError(provider)) return wattErrorResponse(c, provider);
        return c.json({ provider });
      }
      case 'Write': {
        const parsed = modelProviderSchema.safeParse(args.provider);
        if (!parsed.success) {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', `invalid provider: ${parsed.error.message}`, false),
          );
        }
        const written = await registry.write(parsed.data as ModelProvider);
        return c.json({ provider: written });
      }
      case 'Update': {
        const providerId = args.providerId;
        if (typeof providerId !== 'string') {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', 'providerId is required', false),
          );
        }
        const parsedPatch = modelProviderSchema
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
        const result = await registry.update(
          providerId,
          parsedPatch.data as Partial<ModelProvider>,
        );
        if (isWattError(result)) return wattErrorResponse(c, result);
        return c.json({ provider: result });
      }
      case 'SetDefault': {
        const providerId = args.providerId;
        if (typeof providerId !== 'string') {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', 'providerId is required', false),
          );
        }
        const result = await registry.setDefault(providerId);
        if (isWattError(result)) return wattErrorResponse(c, result);
        return c.json({ provider: result });
      }
    }
  });

  // ── POST /htbp/platform/plugin → PluginRegistry（§11.1）+ PluginLifecycle.Health（§11.2）──
  // tool → action（§6.4d）：List/Get/Health=read；Write/Update=manage。资源 platform://plugin。
  //
  // Write 返回 PluginRegistration（§11.2 注册响应）：manifest + platformBaseUrl + jwksUrl + pluginToken。
  //   pluginToken 最小面（实现声明）：复用 signUserToken 签发 principal=`plugin:<id>`、roles=[] 的平台 token
  //   （不新增 token 型）——Plugin 回调平台的权限由 PolicyStore 对 `plugin:<id>` 的策略控制，而非 token 内嵌
  //   scope。§11.2 的"scope=requiredGrants"由 requiredGrants 声明 + 策略配置共同表达。pluginToken 仅此响应
  //   回传一次（List/Get 不回显，与 ModelProvider.secretRef 同脱敏纪律）。
  const PLUGIN_TOOL_ACTIONS: Record<string, string> = {
    List: 'read',
    Get: 'read',
    Health: 'read',
    Write: 'manage',
    Update: 'manage',
  };
  app.post('/htbp/platform/plugin', async (c) => {
    const claims = c.get('claims');
    const authorizer = newAuthorizer(c.env, c.get('callContext').traceId);
    const registry = new PluginRegistry(c.env.DB_PROVIDERS);

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

    const action = tool ? PLUGIN_TOOL_ACTIONS[tool] : undefined;
    if (action === undefined) {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', `unknown tool: ${String(tool)}`, false),
      );
    }
    const decision = await authorizer.check(claims, RES_PLUGIN, action);
    if (!decision.allow) {
      return forbiddenResponse(c, decision.reason ?? 'access denied on platform://plugin');
    }

    switch (tool) {
      case 'List': {
        const opts = (args.opts ?? {}) as PluginListOptions;
        const page = await registry.list(opts);
        if (isWattError(page)) return wattErrorResponse(c, page);
        // 对外投影为 PluginManifest（去 built_in 存储细节，§11.1 形状）。
        return c.json({ items: page.items.map(toManifest) });
      }
      case 'Get': {
        const pluginId = args.pluginId;
        if (typeof pluginId !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'pluginId is required', false));
        }
        const plugin = await registry.get(pluginId);
        if (isWattError(plugin)) return wattErrorResponse(c, plugin);
        return c.json({ plugin: toManifest(plugin) });
      }
      case 'Write': {
        const parsed = pluginManifestSchema.safeParse(args.manifest);
        if (!parsed.success) {
          return wattErrorResponse(
            c,
            wattError(
              'invalid_argument',
              `invalid plugin manifest: ${parsed.error.message}`,
              false,
            ),
          );
        }
        // §11.1 注册契约校验（探活面）：外部 endpoint GET healthPath 不通 → 拒绝注册（不落库、
        //   不签 pluginToken）；binding: 前缀（平台内能力）跳过。~help/~describe 校验延后
        //   （doc-gaps #30）。
        const probe = await probeRegistrationHealth(parsed.data as PluginManifest);
        if (!probe.healthy) {
          return wattErrorResponse(
            c,
            wattError(
              'invalid_argument',
              `plugin endpoint failed registration health probe: ${probe.detail ?? 'unreachable'}`,
              false,
            ),
          );
        }
        const written = await registry.write(parsed.data as PluginManifest);
        // 组装 PluginRegistration（§11.2）：platformBaseUrl + jwksUrl + pluginToken。
        const baseUrl = (c.env.WATT_BASE_URL ?? new URL(c.req.url).origin).replace(/\/+$/, '');
        let pluginToken: string;
        try {
          const keys = await loadPlatformKeys(c.env);
          pluginToken = await signUserToken(
            { principal: `plugin:${written.id}`, roles: [], trace: c.get('callContext').traceId },
            keys.priv,
            keys.meta,
          );
        } catch {
          return wattErrorResponse(
            c,
            wattError('unavailable', 'platform signing key is not configured', false),
          );
        }
        return c.json({
          registration: {
            ...toManifest(written),
            platformBaseUrl: baseUrl,
            jwksUrl: `${baseUrl}/.well-known/jwks.json`,
            pluginToken,
          },
        });
      }
      case 'Update': {
        const pluginId = args.pluginId;
        if (typeof pluginId !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'pluginId is required', false));
        }
        // patch 经 schema 校验（id 不可改、其余可选、严格键集）——防写入畸形字段。
        const parsedPatch = pluginManifestSchema
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
        const result = await registry.update(pluginId, parsedPatch.data);
        if (isWattError(result)) return wattErrorResponse(c, result);
        return c.json({ plugin: toManifest(result) });
      }
      case 'Health': {
        // PluginLifecycle.Health（§11.2）：built_in 直接 ok；外部 plugin 探活 endpoint+healthPath。
        const pluginId = args.pluginId;
        if (typeof pluginId !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'pluginId is required', false));
        }
        const plugin = await registry.get(pluginId);
        if (isWattError(plugin)) return wattErrorResponse(c, plugin);
        const health = await pluginHealth(plugin);
        return c.json({ health });
      }
    }
  });

  // ── POST /htbp/platform/secret → SecretStore 四动词（§6.6）─────────────────
  // Write/Delete=manage、List/Get=read（种子 admin policy 天然覆盖）。**永不回显明文**：
  //   Write 回 {name,updatedAt}；List/Get 只回元数据 + shadowedByEnv（env 同名会先命中、KV 值不生效）。
  // 主密钥 WATT_SECRET_ENCRYPTION_KEY 缺失 → unavailable（部署未配主密钥，端点不可用）。
  const SECRET_TOOL_ACTIONS: Record<string, string> = {
    List: 'read',
    Get: 'read',
    Write: 'manage',
    Delete: 'manage',
  };
  app.post('/htbp/platform/secret', async (c) => {
    const claims = c.get('claims');
    const authorizer = newAuthorizer(c.env, c.get('callContext').traceId);

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

    const action = tool ? SECRET_TOOL_ACTIONS[tool] : undefined;
    if (action === undefined) {
      return wattErrorResponse(
        c,
        wattError('invalid_argument', `unknown tool: ${String(tool)}`, false),
      );
    }
    const decision = await authorizer.check(claims, RES_SECRET, action);
    if (!decision.allow) {
      return forbiddenResponse(c, decision.reason ?? 'access denied on platform://secret');
    }

    // 主密钥缺失 → 端点不可用（§6.6：resolveSecret 静默降级，但写端点必须显式报 unavailable）。
    const encKey = c.env.WATT_SECRET_ENCRYPTION_KEY;
    if (encKey === undefined || encKey.length === 0) {
      return wattErrorResponse(
        c,
        wattError(
          'unavailable',
          'secret store is not configured (WATT_SECRET_ENCRYPTION_KEY missing)',
          false,
        ),
      );
    }
    const store = new SecretStore(c.env.KV_TENANTS, encKey);
    // env 同名命中检测（shadowedByEnv）——env secret 会在 resolveSecret 里先命中，KV 值不生效。
    const envRecord = c.env as unknown as Record<string, unknown>;
    const shadowed = (name: string): boolean => typeof envRecord[name] === 'string';

    switch (tool) {
      case 'List': {
        const metas = await store.list();
        return c.json({
          items: metas.map((m) => ({
            name: m.name,
            updatedAt: m.updatedAt,
            shadowedByEnv: shadowed(m.name),
          })),
        });
      }
      case 'Get': {
        const name = args.name;
        if (typeof name !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'name is required', false));
        }
        const meta = await store.getMeta(name);
        if (meta === null) {
          // KV 无此 secret：若 env 有同名影子仍如实反映（值永不回显，仅元数据）。
          if (shadowed(name)) {
            return c.json({ secret: { name, updatedAt: null, shadowedByEnv: true } });
          }
          return wattErrorResponse(c, wattError('not_found', `secret not found: ${name}`, false));
        }
        return c.json({
          secret: { name: meta.name, updatedAt: meta.updatedAt, shadowedByEnv: shadowed(name) },
        });
      }
      case 'Write': {
        const { name, value } = args;
        if (typeof name !== 'string' || typeof value !== 'string') {
          return wattErrorResponse(
            c,
            wattError('invalid_argument', 'name and value are required strings', false),
          );
        }
        const result = await store.write(name, value);
        if (isWattError(result)) return wattErrorResponse(c, result);
        // 永不回显 value——只回元数据（§6.6）。
        return c.json({ secret: { name: result.name, updatedAt: result.updatedAt } });
      }
      case 'Delete': {
        const name = args.name;
        if (typeof name !== 'string') {
          return wattErrorResponse(c, wattError('invalid_argument', 'name is required', false));
        }
        const result = await store.delete(name);
        if (isWattError(result)) return wattErrorResponse(c, result);
        return c.json(result);
      }
    }
  });

  return app;
}
