/**
 * 工具系统：Tool 接口与白名单交集逻辑。
 *
 * 可用工具 = AgentSpec.tools（ToolGrant 白名单）∩ ContextPackage.permissions
 * .toolScope（运行时收窄）。模型调用了不在交集内的工具 → 拒绝（作为失败的
 * 工具结果回给模型，不执行）。交集由确定性代码计算，不经模型。
 */

import type { AgentSpec, ContextPackage } from '@watt/protocol';

/** 工具执行结果：output 进消息回填给模型，costUsd 计入预算。 */
export interface ToolResult {
  /** 回填给模型的内容（会被 JSON 序列化进 tool 消息） */
  output: unknown;
  /** 本次工具调用成本（USD），默认 0；成本是一等公民 */
  costUsd?: number;
}

/**
 * Tool 接口：name + JSON Schema 参数 + execute。
 * execute 拿到模型给的已解析 args，返回结果。execute 内不做预算/权限检查
 * （那是 runtime 在调用前的确定性职责）。
 */
export interface Tool {
  name: string;
  description?: string;
  /** 参数 JSON Schema（draft 2020-12 子集） */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<ToolResult> | ToolResult;
}

/**
 * 计算运行时可用工具名集合：ToolGrant 白名单 ∩ toolScope。
 * - toolScope 缺省（undefined）：不额外收窄，可用集 = 白名单全集。
 * - toolScope 存在：取交集（只有同时在白名单与 scope 里的工具可用）。
 *
 * 注意：finish / give_up 是 runtime 注入的，不在 AgentSpec.tools 里，
 * 由调用方单独加入允许集（见 run.ts），不受此交集约束。
 */
export function allowedToolNames(spec: AgentSpec, ctx: ContextPackage): Set<string> {
  const granted = new Set(spec.tools.map((g) => g.tool));
  const scope = ctx.permissions.toolScope;
  if (scope === undefined) return granted;
  const scopeSet = new Set(scope);
  return new Set([...granted].filter((name) => scopeSet.has(name)));
}
