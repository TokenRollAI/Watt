/**
 * resolveSecret —— 引用名 → 密钥值的统一解析（Proto §6.6 回退链）。
 *
 * 语义：① `env.<ref>` 命中（部署期 secret）→ 直接返回，**env 优先**；② 未命中且主密钥存在 →
 *   查 SecretStore（KV `secret:<ref>` 解密）返回；③ 双缺失 → undefined。
 * 主密钥 `WATT_SECRET_ENCRYPTION_KEY` 缺失 → **静默跳过 KV 分支**（env-only 零回归）。
 *
 * isolate 级 60s TTL 缓存（含负缓存）——KV 写入到线上生效有最长约 1 分钟窗口（KV 最终一致 + TTL 叠加）。
 * env 命中不进缓存（本就零成本、恒新鲜）；只缓存 KV 分支结果。测试用 resetSecretCacheForTests() 清。
 *
 * **信任根排除**：`WATT_JWT_PRIVATE_JWK`（authz/keys.ts）不经此解析——那是验证根，走 env-only。
 */

import type { Bindings } from '../env.ts';
import { SecretStore } from './secret-store.ts';

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: string | undefined;
  expiresAt: number;
}

/** isolate 级缓存（模块态跨请求存活；仅缓存 KV 分支结果）。 */
const cache = new Map<string, CacheEntry>();

/** 清缓存（单测用；对齐 resetSeedGuardForTests 习惯）。 */
export function resetSecretCacheForTests(): void {
  cache.clear();
}

/**
 * 解析引用名 → 密钥值。env 优先 → KV 解密 → undefined。
 * @param nowMs 当前时刻注入（测试用；缺省 Date.now）。
 */
export async function resolveSecret(
  env: Bindings,
  ref: string,
  nowMs: number = Date.now(),
): Promise<string | undefined> {
  // ① env 命中优先（部署期 secret / .dev.vars）——恒新鲜、不缓存。
  const envVal = (env as unknown as Record<string, unknown>)[ref];
  if (typeof envVal === 'string' && envVal.length > 0) return envVal;

  // 主密钥缺失 → 静默跳过 KV 分支（env-only 零回归）。
  const encKey = env.WATT_SECRET_ENCRYPTION_KEY;
  if (encKey === undefined || encKey.length === 0) return undefined;

  // ② KV 分支（60s TTL 缓存，含负缓存）。
  const cached = cache.get(ref);
  if (cached !== undefined && cached.expiresAt > nowMs) return cached.value;

  let value: string | undefined;
  try {
    const store = new SecretStore(env.KV_TENANTS, encKey);
    value = (await store.getValue(ref)) ?? undefined;
  } catch {
    value = undefined; // KV I/O / 主密钥非法 → 静默降级（不阻塞解析）。
  }
  cache.set(ref, { value, expiresAt: nowMs + CACHE_TTL_MS });
  return value;
}
