/**
 * scripts/lib/env.mjs — 共享 .env 载入 + Cloudflare 部署/管理凭据注入。
 *
 * provision.mjs 与 deploy-all.mjs 复用：从项目根 .env 读 KEY=VALUE，把
 * CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN 注入子进程 env（已在 process.env
 * 的不覆盖），缺失时 fail-fast。绝不打印任何秘密值。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..', '..');
export const envPath = resolve(repoRoot, '.env');

/** 云管理/部署凭据 —— 注入子进程 env，永不进入 Worker 运行时 .dev.vars。 */
export const CF_CREDENTIAL_KEYS = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];

/**
 * 解析 .env 为 { KEY: value }。去掉行首尾空白、跳过空行与 `#` 注释行，
 * 处理 CRLF（去尾部 \r）。不校验值内容，也不打印任何值。
 * @param {string} [path] 覆盖默认 .env 路径（测试用）。
 * @returns {Record<string,string>}
 */
export function parseEnv(path = envPath) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    console.error(`env: .env not found at ${path}`);
    process.exit(1);
  }
  const env = {};
  for (const line of raw.split('\n')) {
    const t = line.replace(/\r$/, '').trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).replace(/\r$/, '');
  }
  return env;
}

/**
 * 构造注入了 CF 凭据的子进程 env。已在 process.env 的凭据不被 .env 覆盖
 * （允许调用方 shell 显式 export 优先）；两个凭据缺一即 fail-fast。
 * @param {string} who 调用方名字（用于错误消息，如 'provision' / 'deploy-all'）。
 * @returns {NodeJS.ProcessEnv}
 */
export function childEnvWithCfCreds(who) {
  const dotenv = parseEnv();
  const childEnv = { ...process.env };
  for (const k of CF_CREDENTIAL_KEYS) {
    if (!childEnv[k] && dotenv[k]) childEnv[k] = dotenv[k];
  }
  const missing = CF_CREDENTIAL_KEYS.filter((k) => !childEnv[k]);
  if (missing.length) {
    console.error(
      `${who}: missing ${missing.join(' / ')} — set them in .env (repo root) or export in shell.`,
    );
    process.exit(1);
  }
  return childEnv;
}
