/**
 * init 向导：wrangler.jsonc 模板渲染（P5，计划 §P5）。
 *
 * 部署产物随 npm 包分发（`packages/cli/deploy/<worker>/wrangler.template.jsonc`），占位符化：
 *   - `__NAME_PREFIX__`         —— 部署名前缀（默认 watt；资源名/worker 名/service binding 全用它派生）
 *   - `__D1_<LIB>_ID__`         —— 五库 database_id（provision 生成后回填）
 *   - `__KV_AUTHZ_CACHE_ID__` / `__KV_TENANTS_ID__` —— 两 KV namespace id
 *   - `__ROUTES_BLOCK__`        —— gateway 的 workers_dev/routes 段（custom domain 可选）
 *   - `__SERVICES_BLOCK__`      —— gateway 的 service bindings 段（TOOLBRIDGE 常在；FEISHU_PLUGIN 视开关）
 *
 * 本模块是**纯字符串渲染**（无 IO、无 spawn），便于单测：占位符全替换 + 飞书开关影响 binding 段。
 * 渲染后断言无残留 `__...__` 占位符（漏替换即抛，防带坏配置去部署）。
 *
 * 关键约束（计划书实证事实）：同账户 workers.dev 互调被平台拦截 → 飞书启用时 gateway 必须经
 *   service binding FEISHU_PLUGIN 调 plugin worker；飞书**未启用**时 gateway 模板不含该 binding。
 */

/** 五个 D1 库的逻辑名（provision/模板/迁移共用；派生资源名 = `<prefix>-<lib>`）。 */
export const D1_LIBS = ['policies', 'providers', 'audit', 'events', 'context'] as const;
export type D1Lib = (typeof D1_LIBS)[number];

export interface D1Ids {
  policies: string;
  providers: string;
  audit: string;
  events: string;
  context: string;
}

export interface KvIds {
  authzCache: string;
  tenants: string;
}

export interface TemplateVars {
  /** 部署名前缀（默认 watt）。约束 `^[a-z][a-z0-9-]{0,40}$`。 */
  namePrefix: string;
  d1Ids: D1Ids;
  kvIds: KvIds;
  /** gateway：custom domain（缺省 → 仅 workers.dev）。 */
  customDomain?: string;
  /** gateway：飞书是否启用（决定是否含 FEISHU_PLUGIN service binding）。 */
  feishuEnabled: boolean;
}

const PREFIX_RE = /^[a-z][a-z0-9-]{0,40}$/;

/** 校验部署名前缀（wrangler worker 名/资源名的合法子集）。 */
export function isValidNamePrefix(prefix: string): boolean {
  return PREFIX_RE.test(prefix);
}

/** 渲染 gateway 的 `__ROUTES_BLOCK__`：始终保留 workers.dev；提供 customDomain 时追加 routes。 */
function renderRoutesBlock(customDomain?: string): string {
  // workers_dev 显式 true：配置 routes 后 wrangler 默认关掉 workers.dev 子域（toolchain §6）。
  if (!customDomain) return '"workers_dev": true';
  return [
    '"workers_dev": true,',
    '  "routes": [',
    `    { "pattern": ${JSON.stringify(customDomain)}, "custom_domain": true }`,
    '  ]',
  ].join('\n');
}

/** 渲染 gateway 的 `__SERVICES_BLOCK__`：TOOLBRIDGE 常在；飞书启用时追加 FEISHU_PLUGIN。 */
function renderServicesBlock(namePrefix: string, feishuEnabled: boolean): string {
  const entries = [`    { "binding": "TOOLBRIDGE", "service": "${namePrefix}-toolbridge" }`];
  if (feishuEnabled) {
    entries.push(`    { "binding": "FEISHU_PLUGIN", "service": "${namePrefix}-plugin-feishu" }`);
  }
  return ['"services": [', entries.join(',\n'), '  ]'].join('\n');
}

/**
 * 渲染一份 wrangler 模板：先替换块级占位符（含 __NAME_PREFIX__ 派生的 service 名），
 * 再替换标量占位符；结尾断言无残留占位符。
 */
export function renderWranglerConfig(template: string, vars: TemplateVars): string {
  if (!isValidNamePrefix(vars.namePrefix)) {
    throw new Error(
      `invalid name prefix ${JSON.stringify(vars.namePrefix)} (want /^[a-z][a-z0-9-]{0,40}$/)`,
    );
  }
  let out = template;

  // 块级占位符（gateway 专有；其他 worker 模板不含则不动）。
  out = out.replaceAll('__ROUTES_BLOCK__', renderRoutesBlock(vars.customDomain));
  out = out.replaceAll(
    '__SERVICES_BLOCK__',
    renderServicesBlock(vars.namePrefix, vars.feishuEnabled),
  );

  // 标量占位符。
  const scalar: Record<string, string> = {
    __D1_POLICIES_ID__: vars.d1Ids.policies,
    __D1_PROVIDERS_ID__: vars.d1Ids.providers,
    __D1_AUDIT_ID__: vars.d1Ids.audit,
    __D1_EVENTS_ID__: vars.d1Ids.events,
    __D1_CONTEXT_ID__: vars.d1Ids.context,
    __KV_AUTHZ_CACHE_ID__: vars.kvIds.authzCache,
    __KV_TENANTS_ID__: vars.kvIds.tenants,
  };
  for (const [k, v] of Object.entries(scalar)) {
    out = out.replaceAll(k, v);
  }
  // __NAME_PREFIX__ 最后替换（blanket；派生所有资源名/worker 名）。
  out = out.replaceAll('__NAME_PREFIX__', vars.namePrefix);

  // 漏替换护栏：任何残留 __XXX__ 占位符即抛（防带坏配置去 deploy）。
  const leftover = out.match(/__[A-Z0-9_]+__/g);
  if (leftover) {
    throw new Error(
      `unreplaced placeholder(s) in rendered wrangler config: ${leftover.join(', ')}`,
    );
  }
  return out;
}

/** 资源名派生（provision 与模板共用同一命名规则）。 */
export function resourceNames(namePrefix: string): {
  d1: Record<D1Lib, string>;
  kvAuthzCache: string;
  kvTenants: string;
  r2ContextObjects: string;
  r2Artifacts: string;
  queueEvents: string;
  queueEventsDlq: string;
  vectorizeIndex: string;
  gateway: string;
  toolbridge: string;
  pluginFeishu: string;
} {
  return {
    d1: {
      policies: `${namePrefix}-policies`,
      providers: `${namePrefix}-providers`,
      audit: `${namePrefix}-audit`,
      events: `${namePrefix}-events`,
      context: `${namePrefix}-context`,
    },
    kvAuthzCache: `${namePrefix}-authz-cache`,
    kvTenants: `${namePrefix}-tenants`,
    r2ContextObjects: `${namePrefix}-context-objects`,
    r2Artifacts: `${namePrefix}-artifacts`,
    queueEvents: `${namePrefix}-events`,
    queueEventsDlq: `${namePrefix}-events-dlq`,
    vectorizeIndex: `${namePrefix}-context-index`,
    gateway: `${namePrefix}-gateway`,
    toolbridge: `${namePrefix}-toolbridge`,
    pluginFeishu: `${namePrefix}-plugin-feishu`,
  };
}
