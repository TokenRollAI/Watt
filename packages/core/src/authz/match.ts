/**
 * 判定原语：resource 前缀通配、action 匹配、subject 匹配、grantsCover。
 * 全部纯函数、无 I/O。规范来源：Proto §6.2（前缀通配）、§6.4b（subject）、§6.4c（grantsCover）。
 */

import type { Grant, Policy, TokenClaims } from '../types.ts';

/**
 * resource 前缀通配（§6.2 L654）。pattern 以 "*" 结尾时按前缀匹配；否则精确相等。
 * 星号是**前缀**匹配（非正则），"*" 自身 = 全通配。
 * 例：`tool://finance/*` 匹配 `tool://finance/report`，不匹配 `tool://finances/x`。
 */
export function resourceMatches(pattern: string, resource: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return resource.startsWith(prefix);
  }
  return pattern === resource;
}

/** action 匹配：`["*"]`（含 "*" 元素）覆盖任意 action；否则精确包含。 */
export function actionMatches(actions: readonly string[], action: string): boolean {
  return actions.includes('*') || actions.includes(action);
}

/**
 * subject 匹配（§6.4b 五种写法）。
 * - user:/service: → claims.sub 相等
 * - role:<name>    → claims.roles 含该角色
 * - agent:<def>    → claims.agent_def 相等（定义级）
 * - agent-instance:<id> → claims.agent_inst 相等（实例级）
 * - *              → 任意
 */
export function subjectMatches(subject: string, claims: TokenClaims): boolean {
  if (subject === '*') return true;
  if (subject.startsWith('role:')) {
    return claims.roles.includes(subject.slice('role:'.length));
  }
  if (subject.startsWith('agent-instance:')) {
    return claims.agent_inst === subject.slice('agent-instance:'.length);
  }
  if (subject.startsWith('agent:')) {
    return claims.agent_def === subject.slice('agent:'.length);
  }
  // user:/service:（及任何其他前缀）→ 与 sub 整串相等
  return claims.sub === subject;
}

/**
 * principal 许可判定（§6.2 deny 优先 + 默认拒绝）。
 * 在 subject 匹配 claims 的 Policy 中：
 *   任一 deny 覆盖 (resource, action) → deny；
 *   否则任一 allow 覆盖 → allow；
 *   否则 → 默认拒绝。
 */
export function policyAllows(
  policies: readonly Policy[],
  claims: TokenClaims,
  resource: string,
  action: string,
): boolean {
  let hasAllow = false;
  for (const p of policies) {
    if (!subjectMatches(p.subject, claims)) continue;
    if (!resourceMatches(p.resource, resource)) continue;
    if (!actionMatches(p.actions, action)) continue;
    if (p.effect === 'deny') return false; // deny 压倒一切
    hasAllow = true;
  }
  return hasAllow;
}

/**
 * grantsCover（§6.4c）：AgentDefinition.grants / CronJob.action(script).grants 是否覆盖 (resource, action)。
 * 覆盖 = 存在某条 grant，其 resources（前缀通配）含 resource 且 actions（含 "*"）含 action。
 */
export function grantsCover(grants: readonly Grant[], resource: string, action: string): boolean {
  for (const g of grants) {
    const resOk = g.resources.some((pat) => resourceMatches(pat, resource));
    if (resOk && actionMatches(g.actions, action)) return true;
  }
  return false;
}
