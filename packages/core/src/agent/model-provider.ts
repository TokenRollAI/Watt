import { z } from 'zod';

/**
 * ModelProvider 类型层（Proto §9 ModelProviderRegistry 最小版）——纯 zod，无 Cloudflare 绑定。
 * gateway 经 @watt/core 消费此 schema（gateway 不得直接 import zod，toolchain-pitfalls §26）。
 */

// ─── ModelProvider（§9 L856-864）─────────────────────────────────────────
// secretRef 密钥引用名（永不回显明文，§9 L862）；default 全局唯一由实现保证（§9 L861）。
export const modelProviderSchema = z.object({
  id: z.string(),
  vendor: z.string(),
  models: z.array(z.string()),
  priority: z.number(),
  default: z.boolean(),
  secretRef: z.string(),
  enabled: z.boolean(),
});
export type ModelProvider = z.infer<typeof modelProviderSchema>;

/** 脱敏投影（对外 list/get；无 secretRef）。 */
export type ModelProviderPublic = Omit<ModelProvider, 'secretRef'>;
