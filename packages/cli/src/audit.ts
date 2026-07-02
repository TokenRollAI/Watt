/**
 * `watt audit list`：POST /htbp/platform/audit `{tool:"List",arguments:{opts}}`。
 * Phase 1：数据面 Phase 6 才完整，此处接口通、返回空 Page 结构（DOD §3 "先通接口"）。
 * 返回体为 §0.2 Page<T> 形状 `{items}`（Phase 1 无 cursor 分页，省略 cursor 字段）。
 */

import { type HttpDeps, htbpCall } from './client.ts';

export interface AuditListResult {
  items: unknown[];
}

export async function auditList(
  base: string,
  token: string,
  deps: HttpDeps = {},
): Promise<AuditListResult> {
  return (await htbpCall(base, token, 'audit', 'List', { opts: {} }, deps)) as AuditListResult;
}

export function formatAuditListHuman(r: AuditListResult): string {
  if (!r.items.length) return '(no audit records)';
  return `${r.items.length} audit record(s)`;
}
