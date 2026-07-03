/**
 * `watt provider list|add|set-default`（Proto §9 ModelProviderRegistry 最小版）。
 *
 * 挂载点：POST /htbp/platform/provider `{tool,arguments}`（复用 client.ts htbpCall）。
 *  - list        → List       arguments:{opts:{}}            → 裸 Page{items}（脱敏，无 secretRef）
 *  - add         → Write      arguments:{provider:{...}}     → { provider }
 *  - set-default → SetDefault arguments:{providerId}          → { provider }
 *
 * 响应形状真源：gateway packages/gateway/test/platform-provider.test.ts（§34 禁双形态兜底）。
 * secretRef 永不回显（§9）——CLI 展示投影不含它。
 */

import { type HttpDeps, htbpCall } from './client.ts';
import { CliError } from './env.ts';

/** ModelProvider 脱敏读投影（无 secretRef）。 */
export interface ProviderView {
  id: string;
  vendor: string;
  models: string[];
  priority: number;
  default: boolean;
  enabled: boolean;
}

interface ProviderPage {
  items: ProviderView[];
}

/** add 入参（secretRef 必填——密钥引用名，永不回显明文）。 */
export interface ProviderInput {
  id: string;
  vendor: string;
  models: string[];
  priority: number;
  default: boolean;
  secretRef: string;
  enabled: boolean;
}

/** list → ModelProviderRegistry.List。 */
export async function providerList(
  base: string,
  token: string,
  deps: HttpDeps = {},
): Promise<ProviderView[]> {
  const body = (await htbpCall(
    base,
    token,
    'provider',
    'List',
    { opts: {} },
    deps,
  )) as ProviderPage;
  return body.items;
}

/** add → ModelProviderRegistry.Write → { provider }。 */
export async function providerAdd(
  base: string,
  token: string,
  provider: ProviderInput,
  deps: HttpDeps = {},
): Promise<ProviderView> {
  const body = (await htbpCall(base, token, 'provider', 'Write', { provider }, deps)) as {
    provider?: ProviderView;
  };
  if (body.provider === undefined) {
    throw new CliError('server add response missing provider', 1);
  }
  return body.provider;
}

/** set-default → ModelProviderRegistry.SetDefault → { provider }。 */
export async function providerSetDefault(
  base: string,
  token: string,
  providerId: string,
  deps: HttpDeps = {},
): Promise<ProviderView> {
  const body = (await htbpCall(base, token, 'provider', 'SetDefault', { providerId }, deps)) as {
    provider?: ProviderView;
  };
  if (body.provider === undefined) {
    throw new CliError('server set-default response missing provider', 1);
  }
  return body.provider;
}

export function formatProviderListHuman(items: ProviderView[]): string {
  if (!items.length) return '(no model providers)';
  return items
    .map(
      (p) =>
        `${p.default ? '*' : ' '} ${p.id}\t${p.vendor}\t[${p.models.join(',')}]\t${
          p.enabled ? 'enabled' : 'disabled'
        }`,
    )
    .join('\n');
}
