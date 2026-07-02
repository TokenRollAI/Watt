#!/usr/bin/env node
/**
 * scripts/sign-admin-token.mjs — 验收专用：为 device flow/Platform API 集成验收签发一个 admin user token。
 *
 * 背景（鸡生蛋）：生产私钥经 gen-jwt-keys.mjs 生成后只进了 wrangler secret，本地拿不回。
 * 本脚本在**单进程内**完成：
 *   1. 生成一把新 Ed25519 私钥（EdDSA）；
 *   2. 通过 `wrangler secret put WATT_JWT_PRIVATE_JWK`（stdin 喂 JWK）轮换到远端 gateway；
 *   3. 用同一把私钥签一个 admin user token（sub=WATT_ADMIN_PRINCIPAL, roles=["admin"]）；
 *   4. **仅把 token 打到 stdout**（供 export WATT_TOKEN）；私钥绝不落盘、绝不打印。
 *
 * 用法（在仓库根）：
 *   export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...   # 或从 .env
 *   ADMIN_TOKEN=$(node scripts/sign-admin-token.mjs --rotate)
 *
 * 破坏性确认（--rotate）：本脚本会覆盖生产 secret WATT_JWT_PRIVATE_JWK，使全部存量
 *   token 立即失效。故必须显式加 --rotate 才执行；缺失则 stderr 警告后 exit 1。
 *
 * 传播确认：secret put 成功后，轮询 ${base}/.well-known/jwks.json，比对返回公钥的 `x`
 *   等于本次生成的公钥 x（kid 固定 watt-platform-1，不能作为传播判据），确认新私钥已
 *   在边缘生效后再把 token 写 stdout；60s 超时则 stderr 警告并非零退出。
 *   base 取 WATT_JWKS_BASE_URL，缺省 workers.dev（本机对 watt.pdjjq.org
 *   有 DNS 污染，不复用 .env 的 WATT_BASE_URL；见 toolchain-pitfalls §11）。
 *
 * 约束（LOOP）：不落盘/打印私钥；token 仅 stdout 一行；提示/警告一律走 stderr。
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { childEnvWithCfCreds, parseEnv } from './lib/env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const gatewayDir = resolve(here, '..', 'packages', 'gateway');

// (a) 破坏性操作确认：缺 --rotate 则拒绝执行（覆盖 secret 会吊销全部存量 token）。
if (!process.argv.includes('--rotate')) {
  process.stderr.write(
    'sign-admin-token: REFUSING TO RUN WITHOUT --rotate.\n' +
      'THIS WILL OVERWRITE THE PRODUCTION SECRET WATT_JWT_PRIVATE_JWK AND\n' +
      'IMMEDIATELY INVALIDATE ALL EXISTING TOKENS. Re-run with --rotate to confirm.\n',
  );
  process.exit(1);
}

const dotenv = parseEnv();
const adminPrincipal =
  process.env.WATT_ADMIN_PRINCIPAL || dotenv.WATT_ADMIN_PRINCIPAL || 'user:admin';
const issuer = process.env.WATT_JWT_ISSUER || dotenv.WATT_JWT_ISSUER || 'watt-platform';
const audience = process.env.WATT_JWT_AUDIENCE || dotenv.WATT_JWT_AUDIENCE || 'watt-api';
const kid = 'watt-platform-1';
const ttlSec = 60 * 60;

// jwks 轮询 base：本机对 watt.pdjjq.org 有 DNS 污染，默认走 workers.dev（可 env 覆盖）。
const jwksBase = (
  process.env.WATT_JWKS_BASE_URL ||
  dotenv.WATT_JWKS_BASE_URL ||
  'https://watt-gateway.shuaiqijianhao.workers.dev'
).replace(/\/+$/, '');

// 1. 生成新私钥。
const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
  crv: 'Ed25519',
  extractable: true,
});
const jwk = await exportJWK(privateKey);
// 传播判据：公钥的 `x`（base64url 的 Ed25519 公钥点），kid 固定不能作判据。
const expectedX = (await exportJWK(publicKey)).x;

// 2. 轮换到远端 secret（stdin 喂 JWK，避免命令行泄露）。
process.stderr.write('sign-admin-token: rotating WATT_JWT_PRIVATE_JWK secret on watt-gateway...\n');
const childEnv = childEnvWithCfCreds('sign-admin-token');
const put = spawnSync(
  'pnpm',
  ['--filter', '@watt/gateway', 'exec', 'wrangler', 'secret', 'put', 'WATT_JWT_PRIVATE_JWK'],
  { input: JSON.stringify(jwk), env: childEnv, cwd: gatewayDir, stdio: ['pipe', 2, 'inherit'] },
);
if (put.status !== 0) {
  process.stderr.write(`sign-admin-token: secret put failed (exit ${put.status}).\n`);
  process.exit(put.status ?? 1);
}

// 2b. 轮询 jwks，等新公钥传播到边缘后再签发/输出 token（否则线上仍用旧私钥验签，
//     新 token 会被拒）。判据 = 返回某把公钥的 `x` 等于本次生成的公钥 x。
const jwksUrl = `${jwksBase}/.well-known/jwks.json`;
process.stderr.write(`sign-admin-token: waiting for new key to propagate at ${jwksUrl} ...\n`);
const deadline = Date.now() + 60_000;
let propagated = false;
while (Date.now() < deadline) {
  try {
    const res = await fetch(jwksUrl, { headers: { accept: 'application/json' } });
    if (res.ok) {
      const body = await res.json();
      const keys = Array.isArray(body?.keys) ? body.keys : [];
      if (keys.some((k) => k?.x === expectedX)) {
        propagated = true;
        break;
      }
    }
  } catch {
    // 网络抖动/边缘传播窗口：忽略并重试，直到超时。
  }
  await new Promise((r) => setTimeout(r, 3000));
}
if (!propagated) {
  process.stderr.write(
    `sign-admin-token: TIMEOUT — new public key did not appear at ${jwksUrl} within 60s. ` +
      'Secret was rotated but propagation is unconfirmed; not emitting token.\n',
  );
  process.exit(1);
}
process.stderr.write('sign-admin-token: new key propagated.\n');

// 3. 用同一私钥签 admin user token（§6.5a：仅 sub + roles + exp/iat/trace）。
const nowSec = Math.floor(Date.now() / 1000);
const token = await new SignJWT({ roles: ['admin'], trace: `acceptance-${nowSec}` })
  .setProtectedHeader({ alg: 'EdDSA', kid })
  .setSubject(adminPrincipal)
  .setIssuedAt(nowSec)
  .setExpirationTime(nowSec + ttlSec)
  .setIssuer(issuer)
  .setAudience(audience)
  .sign(privateKey);

process.stderr.write(
  `sign-admin-token: signed admin token for ${adminPrincipal} (expires in ${ttlSec}s).\n`,
);
// 4. 仅 token 到 stdout。
process.stdout.write(`${token}\n`);
