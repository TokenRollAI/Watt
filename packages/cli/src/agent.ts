/**
 * `watt agent list|get|spawn|send|terminate|tree`（Proto §3.1 AgentRegistry + §3.2 AgentRuntime）。
 *
 * 挂载点：POST /htbp/platform/agent `{tool,arguments}`（复用 client.ts htbpCall）。
 * 动词映射：
 *  - list      → List          arguments:{opts:{}}                    → 裸 Page{items}（AgentDefinition）
 *  - get       → Get           arguments:{name}                        → { definition }
 *  - spawn     → Spawn         arguments:{request:{definition,instanceKey?,input?,ttl?,expect?}} → { instance, correlationId? }
 *  - send      → Send          arguments:{instanceId,event,expect?}    → { accepted, correlationId? }
 *  - terminate → Terminate     arguments:{instanceId,cascade?}         → { terminated:true }
 *  - tree      → ListInstances arguments:{opts:{tree?}}                → 裸 { items }（AgentInstanceInfo）
 *
 * 响应形状真源：gateway packages/gateway/test/platform-agent.test.ts（§34 禁双形态兜底）。
 */

import { type HttpDeps, htbpCall } from './client.ts';
import { CliError } from './env.ts';

/** AgentDefinition 读投影（list/get 展示）。 */
export interface AgentDefinitionView {
  name: string;
  description: string;
  runtime: string;
  [k: string]: unknown;
}

/** AgentInstanceInfo（§3.2）——spawn/status/tree 展示。 */
export interface AgentInstanceView {
  instanceId: string;
  definition: string;
  state: string;
  parent?: string;
  children: string[];
  createdAt: string;
  lastActiveAt: string;
}

interface DefinitionPage {
  items: AgentDefinitionView[];
}
interface InstancePage {
  items: AgentInstanceView[];
}

/** list → AgentRegistry.List。 */
export async function agentList(
  base: string,
  token: string,
  deps: HttpDeps = {},
): Promise<AgentDefinitionView[]> {
  const body = (await htbpCall(base, token, 'agent', 'List', { opts: {} }, deps)) as DefinitionPage;
  return body.items;
}

/** get → AgentRegistry.Get → { definition }。 */
export async function agentGet(
  base: string,
  token: string,
  name: string,
  deps: HttpDeps = {},
): Promise<AgentDefinitionView> {
  const body = (await htbpCall(base, token, 'agent', 'Get', { name }, deps)) as {
    definition?: AgentDefinitionView;
  };
  if (body.definition === undefined) {
    throw new CliError('server get response missing definition', 1);
  }
  return body.definition;
}

/** spawn → AgentRuntime.Spawn → { instance, correlationId? }。 */
export async function agentSpawn(
  base: string,
  token: string,
  request: {
    definition: string;
    instanceKey?: string;
    input?: unknown;
    ttl?: number;
    expect?: { correlationId?: string; timeoutMs?: number; schema?: unknown };
  },
  deps: HttpDeps = {},
): Promise<{ instance: AgentInstanceView; correlationId?: string }> {
  const body = (await htbpCall(base, token, 'agent', 'Spawn', { request }, deps)) as {
    instance?: AgentInstanceView;
    correlationId?: string;
  };
  if (body.instance === undefined) {
    throw new CliError('server spawn response missing instance', 1);
  }
  return { instance: body.instance, correlationId: body.correlationId };
}

/** send → AgentRuntime.Send → { accepted, correlationId? }。 */
export async function agentSend(
  base: string,
  token: string,
  instanceId: string,
  event: Record<string, unknown>,
  expect: { correlationId?: string; timeoutMs?: number; schema?: unknown } | undefined,
  deps: HttpDeps = {},
): Promise<{ accepted: boolean; correlationId?: string }> {
  const args: Record<string, unknown> = { instanceId, event };
  if (expect !== undefined) args.expect = expect;
  const body = (await htbpCall(base, token, 'agent', 'Send', args, deps)) as {
    accepted?: boolean;
    correlationId?: string;
  };
  if (typeof body.accepted !== 'boolean') {
    throw new CliError('server send response missing accepted', 1);
  }
  return { accepted: body.accepted, correlationId: body.correlationId };
}

/** terminate → AgentRuntime.Terminate → { terminated:true }。 */
export async function agentTerminate(
  base: string,
  token: string,
  instanceId: string,
  cascade: boolean,
  deps: HttpDeps = {},
): Promise<void> {
  await htbpCall(base, token, 'agent', 'Terminate', { instanceId, cascade }, deps);
}

/** tree → AgentRuntime.ListInstances{tree} → 裸 { items }（tree 缺省则全列）。 */
export async function agentTree(
  base: string,
  token: string,
  tree: string | undefined,
  deps: HttpDeps = {},
): Promise<AgentInstanceView[]> {
  const opts = tree !== undefined ? { tree } : {};
  const body = (await htbpCall(
    base,
    token,
    'agent',
    'ListInstances',
    { opts },
    deps,
  )) as InstancePage;
  return body.items;
}

// ── 人类可读渲染 ────────────────────────────────────────────────────────────

export function formatDefinitionListHuman(items: AgentDefinitionView[]): string {
  if (!items.length) return '(no agent definitions)';
  return items.map((d) => `${d.name}\t${d.runtime}\t${d.description}`).join('\n');
}

/** tree 缩进渲染父子关系（按 parent 反查，根在前）。 */
export function formatInstanceTreeHuman(items: AgentInstanceView[]): string {
  if (!items.length) return '(no agent instances)';
  const byParent = new Map<string, AgentInstanceView[]>();
  const ids = new Set(items.map((i) => i.instanceId));
  for (const i of items) {
    // 根 = 无 parent 或 parent 不在集合内。
    const key = i.parent !== undefined && ids.has(i.parent) ? i.parent : '';
    const list = byParent.get(key) ?? [];
    list.push(i);
    byParent.set(key, list);
  }
  const lines: string[] = [];
  const walk = (parentKey: string, depth: number): void => {
    for (const node of byParent.get(parentKey) ?? []) {
      lines.push(`${'  '.repeat(depth)}${node.instanceId}\t${node.definition}\t${node.state}`);
      walk(node.instanceId, depth + 1);
    }
  };
  walk('', 0);
  return lines.join('\n');
}
