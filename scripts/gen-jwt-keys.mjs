#!/usr/bin/env node
/**
 * scripts/gen-jwt-keys.mjs — 生成平台 Ed25519 (EdDSA) JWT 密钥对（Proto §11.2）。
 *
 * 用途：为 wrangler secret WATT_JWT_PRIVATE_JWK 生成一把新私钥。私钥只以 JWK JSON 从
 * **stdout** 输出，供管道直接喂给 `wrangler secret put`——**不落盘、不打印任何提示到 stdout**
 * （提示走 stderr，避免污染管道）。公钥经平台 /.well-known/jwks.json 暴露，无需单独保存。
 *
 * 部署（不落盘）：
 *   node scripts/gen-jwt-keys.mjs | pnpm --filter @watt/gateway exec wrangler secret put WATT_JWT_PRIVATE_JWK
 *
 * 本地测试：测试用一把专用测试密钥（packages/gateway/test/fixtures/test-key.json），
 *   **不与生产共用**，故本脚本仅用于生产/远端 secret。
 *
 * 约束（LOOP）：私钥绝不写进任何被 git 跟踪的文件；本脚本 stdout 只有 JWK JSON 一行。
 */
import { exportJWK, generateKeyPair } from 'jose';

const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
const jwk = await exportJWK(privateKey);

// 提示信息一律走 stderr，保持 stdout 纯净可管道。
process.stderr.write('gen-jwt-keys: generated Ed25519 private JWK (stdout). Pipe into:\n');
process.stderr.write(
  '  wrangler secret put WATT_JWT_PRIVATE_JWK  (do NOT save to any tracked file)\n',
);

// stdout：仅 JWK JSON（单行），供管道喂 wrangler secret put。
process.stdout.write(`${JSON.stringify(jwk)}\n`);
