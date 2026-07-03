/**
 * `watt tool mount|ls`（Proto §5.2 ToolRegistry 管理面）。
 *
 * 挂载点：管理面 → POST /htbp/platform/tool `{tool,arguments}`（ToolRegistry），复用 client.ts 的 htbpCall。
 *  - ls    → List   arguments:{opts:{}}                         → 裸 Page{items}（ToolMount）
 *  - mount → Write  arguments:{mount:{path, provider, providerConfig?, virtualize?, enabled}}（幂等 upsert §0.4）
 *
 * describe/call（消费面 tool://... 工具描述与调用）留代理轮：等 tool-bridge 上游 effect/scope 就绪后
 * 经 /htbp/tools 子树代理实现，非本文件职责。
 *
 * 响应形状真源：以 gateway packages/gateway/test/platform-tool.test.ts 锁定的服务端响应为准
 * （管理面 Get/Write/Update → { mount }；List → 裸 Page{items}）。禁双形态兜底（toolchain §34）。
 *
 * 退出码分层（对齐 context.ts/client.ts）：本地无 token → CliError(2)（requireToken）；
 * 服务端非 2xx（含 401/not_found）→ CliError(1)（htbpCall），WattError.message 透传。
 */

import { type HttpDeps, htbpCall } from './client.ts';
import { CliError } from './env.ts';

/** ToolMount 的读投影（ls 展示 / mount 回显）。 */
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

interface MountPage {
  items: ToolMount[];
}

export interface MountInput {
  path: string;
  provider: string;
  providerConfig?: Record<string, unknown>;
  enabled: boolean;
}

/** ls → ToolRegistry.List（管理面视角，返回全部挂载）。 */
export async function toolList(
  base: string,
  token: string,
  deps: HttpDeps = {},
): Promise<ToolMount[]> {
  const body = (await htbpCall(base, token, 'tool', 'List', { opts: {} }, deps)) as MountPage;
  return body.items;
}

/** mount → ToolRegistry.Write（幂等 upsert）。服务端返回 { mount }（platform-tool.test.ts 锁定）。 */
export async function toolMount(
  base: string,
  token: string,
  input: MountInput,
  deps: HttpDeps = {},
): Promise<ToolMount> {
  const mount: Record<string, unknown> = {
    path: input.path,
    provider: input.provider,
    enabled: input.enabled,
  };
  if (input.providerConfig !== undefined) mount.providerConfig = input.providerConfig;
  const body = (await htbpCall(base, token, 'tool', 'Write', { mount }, deps)) as {
    mount?: ToolMount;
  };
  // 精确解包 body.mount：不兜底 body 本身——双形态兼容会掩盖两侧漂移（context 曾两次致线上 bug）。
  if (body.mount === undefined) {
    throw new CliError('server mount response missing mount', 1);
  }
  return body.mount;
}

/** ls 的人类可读行（path / provider / enabled）。 */
export function formatMountLine(m: ToolMount): string {
  return `${m.path}\t${m.provider}\t${m.enabled ? 'enabled' : 'disabled'}`;
}

export function formatMountListHuman(items: ToolMount[]): string {
  if (!items.length) return '(no tool mounts)';
  return items.map(formatMountLine).join('\n');
}
