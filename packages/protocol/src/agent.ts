/**
 * AgentSpec（V1：6 字段）与 ContextPackage（V1：5 字段）。
 * 见 docs/protocol-v1.md。字段范围已拍板，只加不改。
 */
import { z } from 'zod';
import { ResourceRef } from './ids.js';

/**
 * outputSchema 用完整 JSON Schema（draft 2020-12）。协议层只约束
 * "是一个 JSON 对象"；校验器选型（Workers 兼容、无 eval）属于
 * runtime 实现。Planner 应引导模型生成尽量扁平的 schema。
 */
export const JsonSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchema>;

export const ToolGrant = z.object({
  /** Tool 注册表中的名字 */
  tool: z.string().min(1),
  /** 工具级约束，如 github 工具限定 repo 白名单 */
  scope: z.record(z.string(), z.unknown()).optional(),
});
export type ToolGrant = z.infer<typeof ToolGrant>;

export const RuntimeTarget = z.enum(['worker', 'actor', 'sandbox']);
export type RuntimeTarget = z.infer<typeof RuntimeTarget>;

export const Lifecycle = z.enum(['ephemeral', 'persistent']);
export type Lifecycle = z.infer<typeof Lifecycle>;

export const ModelSettings = z.object({
  /** 形如 "deepseek/deepseek-chat" 的 specifier */
  id: z
    .string()
    .regex(/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/, { error: 'model id must be "provider/model"' }),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});
export type ModelSettings = z.infer<typeof ModelSettings>;

/** Agent Factory 的输出、AgentVersion 的数据本体。纯数据，无代码。 */
export const AgentSpec = z.object({
  /** 1. 职责：进入 system prompt 的角色与职责描述 */
  instructions: z.string().min(1),
  /** 2. 输出契约：runtime 据此注入 finish/give_up 工具 */
  outputSchema: JsonSchema,
  /** 3. 工具授权白名单 */
  tools: z.array(ToolGrant),
  /** 4. 模型设置 */
  model: ModelSettings,
  /** 5. Runtime target */
  runtime: RuntimeTarget,
  /** 6. 生命周期策略 */
  lifecycle: Lifecycle,
});
export type AgentSpec = z.infer<typeof AgentSpec>;

export const ContextRef = z.object({
  /** 带前缀资源 ID 或外部 URI */
  ref: z.union([ResourceRef, z.url()]),
  /** 一句话摘要，决定 Agent 是否解析 */
  summary: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type ContextRef = z.infer<typeof ContextRef>;

export const Budget = z.object({
  /** 模型+工具成本上限（USD） */
  maxCostUsd: z.number().positive(),
  /** 单次 AgentRun 墙钟上限 */
  maxWallClockMs: z.number().int().positive(),
  /** 工具调用次数上限 */
  maxToolCalls: z.number().int().positive(),
});
export type Budget = z.infer<typeof Budget>;

/** Orchestrator / Manager 传给 Agent 的结构化上下文包。大内容走 ref。 */
export const ContextPackage = z.object({
  /** 1. 目标：本次 AgentRun 要完成什么 */
  objective: z.string().min(1),
  /** 2. 输入引用 */
  inputs: z.array(ContextRef),
  /** 3. 预算限制 */
  budget: Budget,
  /** 4. 期望输出：对 outputSchema 的补充说明 */
  expectedOutput: z.string().min(1),
  /** 5. 权限范围 */
  permissions: z.object({
    /** 可解析哪些 ref 类型/前缀 */
    contextScope: z.array(z.string()),
    /** 对 AgentSpec.tools 的进一步收窄（运行时交集） */
    toolScope: z.array(z.string()).optional(),
  }),
});
export type ContextPackage = z.infer<typeof ContextPackage>;
