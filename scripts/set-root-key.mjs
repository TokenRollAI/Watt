#!/usr/bin/env node
/**
 * scripts/set-root-key.mjs — 生成/设置 Root Key（Proto §6.5e 持久引导凭据）。
 *
 * 行为：
 *   1. 生成 `wrk_` + 32B base64url 高熵密钥（或 --stdin 从标准输入读用户自备 key）。
 *   2. 计算 SHA-256 hex 摘要，`wrangler secret put WATT_ROOT_KEY_HASH` 到 watt-gateway。
 *   3. **明文只打印一次到 stdout**（务必立即妥存，如密码管理器）；脚本不落盘、平台只存摘要。
 *
 * 覆写语义：重跑即轮换 Root Key（旧 key 立即失效；已换发的存量 JWT 不受影响、自然过期）。
 * 与 JWT 私钥解耦：本脚本不碰 WATT_JWT_PRIVATE_JWK，不吊销任何存量 token。
 *
 * 用法：
 *   node scripts/set-root-key.mjs            # 自动生成并打印一次
 *   echo -n '<your-key>' | node scripts/set-root-key.mjs --stdin   # 用户自备（≥32 字符）
 *
 * 之后换发 admin token：
 *   watt login --root（交互输入 key）或
 *   curl -X POST <base>/oauth/root/token -d '{"root_key":"<key>","ttl_sec":604800}'
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const gatewayDir = resolve(here, '..', 'packages', 'gateway');

let key;
if (process.argv.includes('--stdin')) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  key = Buffer.concat(chunks).toString('utf8').trim();
  if (key.length < 32) {
    process.stderr.write('set-root-key: key from stdin must be >= 32 chars.\n');
    process.exit(1);
  }
} else {
  key = `wrk_${randomBytes(32).toString('base64url')}`;
}

const hash = createHash('sha256').update(key, 'utf8').digest('hex');

// put 摘要（不打印摘要值本身也无妨——摘要不可逆，但保持输出洁癖只报结果）。
const res = spawnSync('npx', ['wrangler', 'secret', 'put', 'WATT_ROOT_KEY_HASH'], {
  cwd: gatewayDir,
  input: hash,
  stdio: ['pipe', 'ignore', 'inherit'],
  env: process.env,
});
if (res.status !== 0) {
  process.stderr.write(`set-root-key: wrangler secret put failed (exit ${res.status}).\n`);
  process.exit(res.status ?? 1);
}

process.stderr.write(
  'set-root-key: WATT_ROOT_KEY_HASH updated on watt-gateway (~15s propagation).\n' +
    'set-root-key: the plaintext below is shown ONCE — store it in a password manager now.\n',
);
process.stdout.write(`${key}\n`);
