import { z } from 'zod';

/**
 * Tool Layer 类型层（Proto §5.2 ToolRegistry / §5.1 ToolProvider）——ToolMount 形状。
 * 全部以 zod 定义、推导 TS 类型（LOOP 纪律 4：校验用 zod）。字段名以 Proto §5.2 原文为准。
 *
 * 本轮只出 ToolMount（ToolRegistry 挂载管理面数据形状）。ToolMeta/ToolSpec/ToolResult
 * （§5.1 ToolProvider 面）留到 tools 消费面代理轮（等 tool-bridge 上游 effect/scope 字段就绪）。
 */

// ─── ToolMount.virtualize（§5.2 L605-610，Reference §2.2 工具虚拟化四项）─────────
// prefix：namespace 前缀（对外工具名加前缀）；rename：原名→新名映射；
// hide：隐藏的工具名列表；describeOverride：工具名→覆盖描述文本。
export const toolVirtualizeSchema = z
  .object({
    prefix: z.string().optional(),
    rename: z.record(z.string(), z.string()).optional(),
    hide: z.array(z.string()).optional(),
    describeOverride: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type ToolVirtualize = z.infer<typeof toolVirtualizeSchema>;

// ─── ToolMount（§5.2 L601-612）───────────────────────────────────────────
// path：工具树位置（"observability/logs"）；provider：plugin id 或内置 "mcp"|"http"|"builtin"；
// providerConfig：上游 endpoint 等（凭证走 Secrets 引用，不落库明文）；
// virtualize：工具虚拟化（可选）；enabled：挂载启停。
//
// provider 用 z.string()（非 enum）：Proto 原文明写"plugin id 或内置 mcp|http|builtin"，
// plugin id 是开放集合——收窄成 enum 会拒绝合法 plugin 挂载。内置三值仅作文档提示，不做枚举约束。
export const toolMountSchema = z
  .object({
    path: z.string(),
    provider: z.string(),
    providerConfig: z.record(z.string(), z.unknown()).optional(),
    virtualize: toolVirtualizeSchema.optional(),
    enabled: z.boolean(),
  })
  .strict();
export type ToolMount = z.infer<typeof toolMountSchema>;
