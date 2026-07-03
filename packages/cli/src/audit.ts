/**
 * `watt audit list`：POST /htbp/platform/audit `{tool:"List",arguments:{opts}}`（Proto §10）。
 * R23：接真实数据面。opts.filter 支持 principal/agent/resource/decision（§10 List 语义）；limit 可选。
 * 返回体为 §0.2 Page<AuditRecord> 形状 `{items}`（gateway 路由为真源，无 cursor 分页；精确解包，
 * 禁双形态兜底——toolchain §29）。
 */

import type { CallContext } from '@watt/core';
import { type HttpDeps, htbpCall } from './client.ts';

/** AuditRecord（Proto §10）——CLI 侧投影（context 完整派生链）。 */
export interface AuditRecord {
  id: string;
  at: string;
  context: CallContext;
  resource: string;
  action: string;
  decision: 'allow' | 'deny';
  detail?: unknown;
}

export interface AuditListResult {
  items: AuditRecord[];
}

export interface AuditListFilter {
  principal?: string;
  agent?: string;
  resource?: string;
  decision?: string;
  limit?: number;
}

export async function auditList(
  base: string,
  token: string,
  filter: AuditListFilter = {},
  deps: HttpDeps = {},
): Promise<AuditListResult> {
  const f: Record<string, string> = {};
  if (filter.principal !== undefined) f.principal = filter.principal;
  if (filter.agent !== undefined) f.agent = filter.agent;
  if (filter.resource !== undefined) f.resource = filter.resource;
  if (filter.decision !== undefined) f.decision = filter.decision;
  const opts: Record<string, unknown> = { filter: f };
  if (filter.limit !== undefined) opts.limit = filter.limit;
  const res = (await htbpCall(base, token, 'audit', 'List', { opts }, deps)) as {
    items?: AuditRecord[];
  };
  // 精确解包（真源=gateway 路由 { items }）；缺 items 即视为契约漂移 → 空列表（不双形态兜底）。
  return { items: res.items ?? [] };
}

export function formatAuditListHuman(r: AuditListResult): string {
  if (!r.items.length) return '(no audit records)';
  return r.items
    .map(
      (rec) =>
        `${rec.at}  ${rec.decision.toUpperCase().padEnd(5)}  ${rec.context.principal}  ${rec.action} ${rec.resource}`,
    )
    .join('\n');
}
