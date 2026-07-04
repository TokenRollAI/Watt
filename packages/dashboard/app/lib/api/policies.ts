/**
 * policies domain wrappers（视图族 C）——POST /htbp/platform/policy {tool,arguments}。
 *
 * 请求形状真源：packages/cli/src/policy.ts（htbpCall 调用点）+ gateway 路由测试。禁自创形状、禁双形态兜底解析（§34）。
 * 动词映射：
 *  - list → List        {opts:{filter:{subject?}}}                         → 裸 { items }（Policy）
 *  - add  → Write       {policy:{id,subject,resource,actions,effect}}       → { policy }
 *  - rm   → Delete      {id}                                               → { deleted:true }
 *  - map  → MapIdentity {channel,channelUserId,principal}                   → { channel,channelUserId,principal }
 */

import { htbp } from './core.ts';

export interface Policy {
  id: string;
  subject: string;
  resource: string;
  actions: string[];
  effect: 'allow' | 'deny';
  condition?: Record<string, string>;
}

export interface PolicyInput {
  id: string;
  subject: string;
  resource: string;
  actions: string[];
  effect: 'allow' | 'deny';
}

export interface IdentityMapping {
  channel: string;
  channelUserId: string;
  principal: string;
}

export const policiesApi = {
  // List：filter.subject 承载在 opts.filter（Proto §0.2，不平铺到 opts 顶层）。
  listPolicies: (subject?: string) =>
    htbp<{ items: Policy[] }>('policy', 'List', {
      opts: subject ? { filter: { subject } } : {},
    }),
  // add → Write：整体 policy 体（id 由视图层生成，与 CLI policyAdd 一致）。
  writePolicy: (policy: PolicyInput) => htbp<{ policy: Policy }>('policy', 'Write', { policy }),
  // rm → Delete。
  deletePolicy: (id: string) => htbp<{ deleted: boolean }>('policy', 'Delete', { id }),
  // map → MapIdentity：外部身份 → principal（IdentityMapper 数据面，§6.3）。
  mapIdentity: (input: IdentityMapping) =>
    htbp<IdentityMapping>('policy', 'MapIdentity', {
      channel: input.channel,
      channelUserId: input.channelUserId,
      principal: input.principal,
    }),
};
