/**
 * `watt policy list|add|rm`：POST /htbp/platform/policy `{tool,arguments}`。
 *
 * tool 名对齐 gateway 现状（packages/gateway/src/http/routes.ts）：List / Write / Delete。
 *  - list → tool:"List"，arguments:{opts:{filter:{subject?}}}（Proto ListOptions，§0.2/§6.2）
 *  - add  → tool:"Write"，arguments:{policy:{id,subject,resource,actions,effect}}
 *  - rm   → tool:"Delete"，arguments:{id}
 */

import { type HttpDeps, htbpCall } from './client.ts';

export interface Policy {
  id: string;
  subject: string;
  resource: string;
  actions: string[];
  effect: 'allow' | 'deny';
  condition?: Record<string, string>;
}

export async function policyList(
  base: string,
  token: string,
  opts: { subject?: string } = {},
  deps: HttpDeps = {},
): Promise<Policy[]> {
  // ListOptions.filter 承载 subject（Proto §0.2：filter 是键值对象，不平铺到 opts 顶层）。
  const listOpts: Record<string, unknown> = opts.subject
    ? { filter: { subject: opts.subject } }
    : {};
  const body = (await htbpCall(base, token, 'policy', 'List', { opts: listOpts }, deps)) as {
    items: Policy[];
  };
  return body.items;
}

export interface AddPolicyInput {
  id?: string;
  subject: string;
  resource: string;
  actions: string[];
  effect: 'allow' | 'deny';
}

export async function policyAdd(
  base: string,
  token: string,
  input: AddPolicyInput,
  deps: HttpDeps = {},
): Promise<Policy> {
  const id = input.id ?? `pol-${crypto.randomUUID()}`;
  const policy = {
    id,
    subject: input.subject,
    resource: input.resource,
    actions: input.actions,
    effect: input.effect,
  };
  const body = (await htbpCall(base, token, 'policy', 'Write', { policy }, deps)) as {
    policy: Policy;
  };
  return body.policy;
}

export async function policyRm(
  base: string,
  token: string,
  id: string,
  deps: HttpDeps = {},
): Promise<{ deleted: true }> {
  return (await htbpCall(base, token, 'policy', 'Delete', { id }, deps)) as { deleted: true };
}

export interface MapIdentityResult {
  channel: string;
  channelUserId: string;
  principal: string;
}

/**
 * `watt policy map`：绑定渠道身份 → principal（IdentityMapper.Resolve 数据面，§6.3）。
 * tool:"MapIdentity"，arguments:{channel, channelUserId, principal}。返回体真源 = gateway 路由
 * { channel, channelUserId, principal }（精确解包，禁双形态兜底）。
 */
export async function policyMapIdentity(
  base: string,
  token: string,
  input: MapIdentityResult,
  deps: HttpDeps = {},
): Promise<MapIdentityResult> {
  return (await htbpCall(
    base,
    token,
    'policy',
    'MapIdentity',
    { channel: input.channel, channelUserId: input.channelUserId, principal: input.principal },
    deps,
  )) as MapIdentityResult;
}

export function formatPolicyListHuman(policies: Policy[]): string {
  if (!policies.length) return '(no policies)';
  return policies
    .map((p) => `${p.id}\t${p.effect}\t${p.subject}\t${p.resource}\t[${p.actions.join(',')}]`)
    .join('\n');
}
