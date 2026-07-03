/**
 * `watt plugin register|list|health`（Proto §11.1 PluginRegistry + §11.2 PluginLifecycle.Health）。
 *
 * 挂载点：POST /htbp/platform/plugin `{tool,arguments}`（复用 client.ts htbpCall）。
 *  - register → Write   arguments:{manifest:{...}}  → { registration }（+ jwksUrl/platformBaseUrl/pluginToken）
 *  - list     → List    arguments:{opts:{filter?}}  → { items:[PluginManifest] }
 *  - health   → Health  arguments:{pluginId}         → { health:{healthy,detail?} }
 *
 * 响应形状真源：gateway packages/gateway/test/platform-plugin.test.ts（§34 禁双形态兜底）。
 * pluginToken 仅 register 响应回传一次（List/Get 不回显）——register --json 输出含它，供 Plugin 侧对接。
 */

import { type HttpDeps, htbpCall } from './client.ts';
import { CliError } from './env.ts';

/** PluginManifest 读投影（§11.1）。pluginToken 不在此（仅 register 响应有）。 */
export interface PluginManifest {
  id: string;
  kind: string;
  interfaceVersion: string;
  endpoint: string;
  auth: { kind: string; secretRef?: string };
  requiredGrants: { resources: string[]; actions: string[] }[];
  healthPath: string;
  enabled: boolean;
}

/** register 响应（§11.2 PluginRegistration）——manifest + 回调对接三件套。 */
export interface PluginRegistration extends PluginManifest {
  platformBaseUrl: string;
  jwksUrl: string;
  pluginToken: string;
}

export interface PluginHealth {
  healthy: boolean;
  detail?: string;
}

/** register → PluginRegistry.Write → { registration }。 */
export async function pluginRegister(
  base: string,
  token: string,
  manifest: PluginManifest,
  deps: HttpDeps = {},
): Promise<PluginRegistration> {
  const body = (await htbpCall(base, token, 'plugin', 'Write', { manifest }, deps)) as {
    registration?: PluginRegistration;
  };
  if (body.registration === undefined) {
    throw new CliError('server register response missing registration', 1);
  }
  return body.registration;
}

/** list → PluginRegistry.List → { items }（filter kind 可选）。 */
export async function pluginList(
  base: string,
  token: string,
  filter: { kind?: string } = {},
  deps: HttpDeps = {},
): Promise<PluginManifest[]> {
  const opts: Record<string, unknown> = {};
  if (filter.kind !== undefined) opts.filter = { kind: filter.kind };
  const body = (await htbpCall(base, token, 'plugin', 'List', { opts }, deps)) as {
    items?: PluginManifest[];
  };
  // 精确解包（真源=gateway 路由 { items }）；缺 items 即视为契约漂移 → 空列表（不双形态兜底）。
  return body.items ?? [];
}

/** health → PluginLifecycle.Health → { health }。 */
export async function pluginHealth(
  base: string,
  token: string,
  pluginId: string,
  deps: HttpDeps = {},
): Promise<PluginHealth> {
  const body = (await htbpCall(base, token, 'plugin', 'Health', { pluginId }, deps)) as {
    health?: PluginHealth;
  };
  if (body.health === undefined) {
    throw new CliError('server health response missing health', 1);
  }
  return body.health;
}

export function formatPluginListHuman(items: PluginManifest[]): string {
  if (!items.length) return '(no plugins)';
  return items
    .map((p) => `${p.enabled ? ' ' : '-'} ${p.id}\t${p.kind}\t${p.interfaceVersion}\t${p.endpoint}`)
    .join('\n');
}

export function formatPluginHealthHuman(pluginId: string, h: PluginHealth): string {
  return `${pluginId}: ${h.healthy ? 'healthy' : 'UNHEALTHY'}${h.detail ? ` (${h.detail})` : ''}`;
}
