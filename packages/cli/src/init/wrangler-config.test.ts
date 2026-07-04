import { describe, expect, it } from 'vitest';
import {
  isValidNamePrefix,
  renderWranglerConfig,
  resourceNames,
  type TemplateVars,
} from './wrangler-config.ts';

// 内联模板 fixture（占位符形态与 build:deploy 产出一致；测试不依赖 deploy/ 目录）。
const GATEWAY_TMPL = `{
  "name": "__NAME_PREFIX__-gateway",
  "main": "worker.js",
  __ROUTES_BLOCK__,
  "d1_databases": [
    { "binding": "DB_POLICIES", "database_name": "__NAME_PREFIX__-policies", "database_id": "__D1_POLICIES_ID__" },
    { "binding": "DB_PROVIDERS", "database_name": "__NAME_PREFIX__-providers", "database_id": "__D1_PROVIDERS_ID__" },
    { "binding": "DB_AUDIT", "database_name": "__NAME_PREFIX__-audit", "database_id": "__D1_AUDIT_ID__" },
    { "binding": "DB_EVENTS", "database_name": "__NAME_PREFIX__-events", "database_id": "__D1_EVENTS_ID__" },
    { "binding": "DB_CONTEXT", "database_name": "__NAME_PREFIX__-context", "database_id": "__D1_CONTEXT_ID__" }
  ],
  "kv_namespaces": [
    { "binding": "KV_AUTHZ_CACHE", "id": "__KV_AUTHZ_CACHE_ID__" },
    { "binding": "KV_TENANTS", "id": "__KV_TENANTS_ID__" }
  ],
  __SERVICES_BLOCK__,
  "workflows": [{ "name": "__NAME_PREFIX__-task", "binding": "WATT_TASK", "class_name": "WattTaskWorkflow" }]
}
`;

const TOOLBRIDGE_TMPL = `{
  "name": "__NAME_PREFIX__-toolbridge",
  "main": "worker.js",
  "kv_namespaces": [{ "binding": "TENANTS", "id": "__KV_TENANTS_ID__" }]
}
`;

const VARS: TemplateVars = {
  namePrefix: 'wtest',
  d1Ids: { policies: 'p1', providers: 'p2', audit: 'p3', events: 'p4', context: 'p5' },
  kvIds: { authzCache: 'kv1', tenants: 'kv2' },
  feishuEnabled: false,
};

/** 宽松 JSONC → JSON（去块注释/行注释/尾逗号）供 JSON.parse 断言渲染产物合法。 */
function jsoncToJson(s: string): unknown {
  const stripped = s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped);
}

describe('isValidNamePrefix', () => {
  it('accepts lowercase alnum + hyphen', () => {
    expect(isValidNamePrefix('watt')).toBe(true);
    expect(isValidNamePrefix('watt-init-test')).toBe(true);
  });
  it('rejects invalid prefixes', () => {
    expect(isValidNamePrefix('Watt')).toBe(false);
    expect(isValidNamePrefix('1watt')).toBe(false);
    expect(isValidNamePrefix('watt_x')).toBe(false);
    expect(isValidNamePrefix('')).toBe(false);
  });
});

describe('renderWranglerConfig', () => {
  it('replaces all placeholders (no leftover __X__)', () => {
    const out = renderWranglerConfig(GATEWAY_TMPL, VARS);
    expect(out).not.toMatch(/__[A-Z0-9_]+__/);
  });

  it('substitutes prefix into names and ids', () => {
    const out = renderWranglerConfig(GATEWAY_TMPL, VARS);
    const cfg = jsoncToJson(out) as {
      name: string;
      main: string;
      d1_databases: { database_name: string; database_id: string }[];
      kv_namespaces: { binding: string; id: string }[];
    };
    expect(cfg.name).toBe('wtest-gateway');
    expect(cfg.main).toBe('worker.js');
    expect(cfg.d1_databases[0]).toMatchObject({
      database_name: 'wtest-policies',
      database_id: 'p1',
    });
    expect(cfg.kv_namespaces).toContainEqual({ binding: 'KV_TENANTS', id: 'kv2' });
  });

  it('feishu OFF: services has only TOOLBRIDGE, no FEISHU_PLUGIN', () => {
    const out = renderWranglerConfig(GATEWAY_TMPL, { ...VARS, feishuEnabled: false });
    const cfg = jsoncToJson(out) as { services: { binding: string; service: string }[] };
    expect(cfg.services).toEqual([{ binding: 'TOOLBRIDGE', service: 'wtest-toolbridge' }]);
    expect(out).not.toContain('FEISHU_PLUGIN');
  });

  it('feishu ON: services includes FEISHU_PLUGIN binding', () => {
    const out = renderWranglerConfig(GATEWAY_TMPL, { ...VARS, feishuEnabled: true });
    const cfg = jsoncToJson(out) as { services: { binding: string; service: string }[] };
    expect(cfg.services).toEqual([
      { binding: 'TOOLBRIDGE', service: 'wtest-toolbridge' },
      { binding: 'FEISHU_PLUGIN', service: 'wtest-plugin-feishu' },
    ]);
  });

  it('no custom domain: workers.dev only, no routes', () => {
    const out = renderWranglerConfig(GATEWAY_TMPL, VARS);
    const cfg = jsoncToJson(out) as { workers_dev: boolean; routes?: unknown };
    expect(cfg.workers_dev).toBe(true);
    expect(cfg.routes).toBeUndefined();
  });

  it('custom domain: adds routes with custom_domain', () => {
    const out = renderWranglerConfig(GATEWAY_TMPL, { ...VARS, customDomain: 'watt.example.com' });
    const cfg = jsoncToJson(out) as {
      workers_dev: boolean;
      routes: { pattern: string; custom_domain: boolean }[];
    };
    expect(cfg.workers_dev).toBe(true);
    expect(cfg.routes).toEqual([{ pattern: 'watt.example.com', custom_domain: true }]);
  });

  it('toolbridge template: TENANTS shares gateway KV id', () => {
    const out = renderWranglerConfig(TOOLBRIDGE_TMPL, VARS);
    const cfg = jsoncToJson(out) as {
      name: string;
      kv_namespaces: { binding: string; id: string }[];
    };
    expect(cfg.name).toBe('wtest-toolbridge');
    expect(cfg.kv_namespaces[0]).toEqual({ binding: 'TENANTS', id: 'kv2' });
  });

  it('throws on invalid prefix', () => {
    expect(() => renderWranglerConfig(GATEWAY_TMPL, { ...VARS, namePrefix: 'Bad' })).toThrow(
      /invalid name prefix/,
    );
  });

  it('throws if a placeholder is left unreplaced', () => {
    expect(() => renderWranglerConfig('{ "x": "__MISSING_PLACEHOLDER__" }', VARS)).toThrow(
      /unreplaced placeholder/,
    );
  });
});

describe('resourceNames', () => {
  it('derives all resource names from prefix', () => {
    const n = resourceNames('watt-init-test');
    expect(n.d1.policies).toBe('watt-init-test-policies');
    expect(n.kvTenants).toBe('watt-init-test-tenants');
    expect(n.r2Artifacts).toBe('watt-init-test-artifacts');
    expect(n.queueEventsDlq).toBe('watt-init-test-events-dlq');
    expect(n.vectorizeIndex).toBe('watt-init-test-context-index');
    expect(n.gateway).toBe('watt-init-test-gateway');
    expect(n.pluginFeishu).toBe('watt-init-test-plugin-feishu');
  });
});
