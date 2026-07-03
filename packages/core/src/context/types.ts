import { z } from 'zod';
import { timestampSchema, uriSchema } from '../types.ts';

/**
 * Context Layer 类型层（Proto §4.1 ContextProvider / §4.2 ContextRegistry）——
 * NamespaceMount / ContextEntryMeta / ContextEntry / ContextPatch / ContextEntryInput 形状。
 * 全部以 zod 定义、推导 TS 类型（LOOP 纪律 4：校验用 zod）。字段名以 Proto §4.1/§4.2 原文为准。
 */

// ─── NamespaceMount（§4.2 L541-547）──────────────────────────────────────
// namespace 可含 '/'（"feedback/bugs"）；provider 为内置 "object"|"structured"|"vector" 或 plugin id。
// ttl 秒（正整数，到期整个 namespace 回收）；readOnly 标记只读挂载。
export const namespaceMountSchema = z.object({
  namespace: z.string(),
  provider: z.string(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
  ttl: z.number().int().positive().optional(),
  readOnly: z.boolean().optional(),
});
export type NamespaceMount = z.infer<typeof namespaceMountSchema>;

// ─── ContextEntryMeta（§4.1 L480-487）────────────────────────────────────
// uri = context://<namespace>/<path>；version 承载乐观并发；metadata 为 Provider 自定标签。
export const contextEntryMetaSchema = z.object({
  uri: uriSchema, // context://<namespace>/<path>
  contentType: z.string(),
  size: z.number().optional(),
  version: z.string(),
  updatedAt: timestampSchema,
  metadata: z.record(z.string(), z.string()),
});
export type ContextEntryMeta = z.infer<typeof contextEntryMetaSchema>;

// ─── ContextEntry（§4.1 L489-491）────────────────────────────────────────
// extends Meta + content（文本或 JSON；大对象可返回 { $ref: URI }）。
export const contextEntrySchema = contextEntryMetaSchema.extend({
  content: z.union([z.string(), z.unknown()]),
});
export type ContextEntry = z.infer<typeof contextEntrySchema>;

// ─── ContextPatch（§4.1 L500-504）────────────────────────────────────────
// content 提供则替换；metadata 浅合并；ifVersion 不匹配 → conflict。
export const contextPatchSchema = z.object({
  content: z.union([z.string(), z.unknown()]).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  ifVersion: z.string().optional(),
});
export type ContextPatch = z.infer<typeof contextPatchSchema>;

// ─── ContextEntryInput（§4.1 L493-498）───────────────────────────────────
// Write 入参：整体创建或替换；ifVersion 不匹配 → conflict。
// content 必填：z.unknown() 本身允许缺省（键可省），会让缺 content 的 Write 穿过校验、
// 到 provider 内才炸成 500——契约上应 400。故 content 分支用 z.unknown().refine 断言"存在且
// 非 undefined"，收紧为必填；类型面仍是 string | unknown（union 坍缩为 unknown，与 §4.1 一致）。
export const contextEntryInputSchema = z.object({
  contentType: z.string(),
  content: z.union([
    z.string(),
    z.unknown().refine((v) => v !== undefined, { message: 'content is required' }),
  ]),
  metadata: z.record(z.string(), z.string()).optional(),
  ifVersion: z.string().optional(),
});
export type ContextEntryInput = z.infer<typeof contextEntryInputSchema>;
