/**
 * DeepSeek 本地价格表与 costUsd 计算。
 *
 * 成本是一等公民：每次模型响应都必须算出 costUsd。价格按 model id 查表，
 * 区分 cache hit / cache miss 输入价与输出价。调用方可注入覆盖价格表
 * （如测试或临时促销价）。
 *
 * 数据来源：DeepSeek 官方价格页（api-docs.deepseek.com/quick_start/pricing）。
 * 采集日期：2026-06-12。单位：USD / 1 token（= 官方 USD/1M 价 ÷ 1e6）。
 *
 * 截至该日期的事实：
 * - deepseek-chat / deepseek-reasoner 是 legacy 别名，均路由到 V4 Flash 价，
 *   2026-07-24 退役。
 * - V4 Flash：cache hit $0.028/M、cache miss $0.14/M、output $0.28/M。
 *   （cache-hit 价于 2026-04-26 降为发布价的 1/10）
 * - V4 Pro：cache hit $0.0145/M、cache miss $1.74/M、output $3.48/M（标准价，
 *   不含已过期的限时 75% 促销）。
 */

/** 单个 model 的 per-token 价格（USD）。 */
export interface ModelPrice {
  /** 命中 prefix cache 的输入 token 单价 */
  inputCacheHitPerToken: number;
  /** 未命中 prefix cache 的输入 token 单价 */
  inputCacheMissPerToken: number;
  /** 输出 token 单价 */
  outputPerToken: number;
}

/** 价格表：裸 model id -> 价格。带默认覆盖能力。 */
export type PriceTable = Record<string, ModelPrice>;

/** 官方 USD/1M -> USD/token。 */
const perM = (usdPerMillion: number): number => usdPerMillion / 1_000_000;

const V4_FLASH: ModelPrice = {
  inputCacheHitPerToken: perM(0.028),
  inputCacheMissPerToken: perM(0.14),
  outputPerToken: perM(0.28),
};

const V4_PRO: ModelPrice = {
  inputCacheHitPerToken: perM(0.0145),
  inputCacheMissPerToken: perM(1.74),
  outputPerToken: perM(3.48),
};

/**
 * 默认价格表（数据日期 2026-06-12）。
 * legacy 别名与 V4 Flash 同价，显式列出避免漏配。
 */
export const DEFAULT_PRICE_TABLE: PriceTable = {
  'deepseek-chat': V4_FLASH,
  'deepseek-reasoner': V4_FLASH,
  'deepseek-v4-flash': V4_FLASH,
  'deepseek-v4-pro': V4_PRO,
};

/**
 * 按归一化 token 数与价格计算成本（USD）。
 * 命中与未命中分别计价；输出单独计价。
 */
export function computeCostUsd(
  usage: { cacheHitTokens: number; cacheMissTokens: number; outputTokens: number },
  price: ModelPrice,
): number {
  return (
    usage.cacheHitTokens * price.inputCacheHitPerToken +
    usage.cacheMissTokens * price.inputCacheMissPerToken +
    usage.outputTokens * price.outputPerToken
  );
}

/**
 * 从价格表取某 model 的价格；缺表抛错（成本必须可算，不容静默归零）。
 */
export function priceFor(model: string, table: PriceTable): ModelPrice {
  const price = table[model];
  if (!price) {
    throw new Error(`no price entry for model "${model}"; provide one via priceTable override`);
  }
  return price;
}
