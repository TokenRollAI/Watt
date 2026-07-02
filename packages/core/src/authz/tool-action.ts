/**
 * §6.4d 工具动作映射。
 * ToolSpec.scope 存在（非空）时 Check 的 action = 该 scope 字符串（如 "finance.read"）；
 * 否则 action = "invoke"。
 *
 * Phase 1 无 Tool Layer，但 Authorizer 接口须能接受任意 action 字符串，
 * 本函数是 Tool 调用点到 authorize.action 的唯一映射。
 */
export function toolActionFor(scope: string | undefined): string {
  return scope ? scope : 'invoke';
}
