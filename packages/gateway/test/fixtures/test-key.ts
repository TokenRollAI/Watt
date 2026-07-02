/**
 * 专用测试密钥 fixture（Ed25519 JWK）——**仅测试用，绝不与生产共用**。
 * 生产私钥经 scripts/gen-jwt-keys.mjs 生成并进 wrangler secret WATT_JWT_PRIVATE_JWK。
 * 本 fixture 是一把独立密钥，可安全提交（无生产价值）。
 */

/** 测试用平台私钥 JWK（含 d，签发用）。 */
export const TEST_PRIVATE_JWK = {
  crv: 'Ed25519',
  d: 'Ti84pL59BZUVWP1d4j8CgjiOqGQnUdXFLEhxIwxnZCM',
  x: 'v3okkiMdRKgkQVn3y_4z1c3SSgiOF6WMR_990uFx8Pw',
  kty: 'OKP',
} as const;

/** 测试用 admin principal（对齐 .env 的 WATT_ADMIN_PRINCIPAL 语义，值仅测试固定）。 */
export const TEST_ADMIN_PRINCIPAL = 'user:test-admin';

export const TEST_JWT_ISSUER = 'watt-platform';
export const TEST_JWT_AUDIENCE = 'watt-api';
