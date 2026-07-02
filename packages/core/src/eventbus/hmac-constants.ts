/**
 * webhook 验签相关的约定常量（Proto 未规定，本轮实现自由，逐条声明于 PROGRESS）。
 * core 与 gateway adapter 共享，避免 header 名 / 签名前缀两处漂移。
 */
export const WATT_HMAC = {
  /** 签名 header 值前缀：值形如 "sha256=<hex>"。 */
  prefix: 'sha256=',
  /** 承载签名的请求 header 名（小写归一后比较）。 */
  signatureHeader: 'x-watt-signature',
  /** 承载投递 ID（幂等重投语义）的请求 header 名。 */
  deliveryHeader: 'x-watt-delivery-id',
} as const;
