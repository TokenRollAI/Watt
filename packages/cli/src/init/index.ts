/**
 * `watt init` 部署向导（P5，计划 §P5）——新用户在自己 CF 账户交互式完成 provision + 部署 + 密钥引导
 * + 首 admin token，不 clone 仓库（`npx @tokenroll/watt init`）。
 *
 * 流程（每步幂等可重入；--resume 从应答存档续跑，completed 步骤跳过）：
 *   ① wrangler auth 检查（npx --yes wrangler@4.107.0 whoami；接受 CLOUDFLARE_API_TOKEN/ACCOUNT_ID env）
 *   ② 问答：前缀 / custom domain(可选) / admin principal / LLM key(可选) / 是否启用飞书
 *   ③ provision（D1×5/KV×2/R2×2/Queue×2/Vectorize，幂等）
 *   ④ 渲染三份 wrangler.jsonc 到 ~/.watt/deployments/<prefix>/（飞书未启用时 gateway 不含 FEISHU_PLUGIN binding）
 *   ⑤ migrations apply ×5 --remote
 *   ⑥ 信任根三 secret（本地生成 Ed25519 JWK + 32B 加密 key + admin principal）+ 同进程签 7d admin token
 *      → wrangler secret put → 丢弃私钥；token 写 ~/.watt/credentials.json (0600)
 *   ⑦ deploy：toolbridge → plugin-feishu(启用时) → gateway → dashboard(Pages)
 *   ⑧ LLM key(若提供)经 SecretStore：POST /htbp/platform/secret Write（用刚签 admin token）
 *   ⑨ 收尾输出：gateway/dashboard URL、setup feishu 提示、watt status 自检
 *
 * `watt init --resign-admin`：对已有部署 admin token 轮换（sign-admin-token --rotate 的交互化包装，
 *   破坏性确认——吊销全部存量 token 含 pluginToken，提示需重跑 setup feishu 重签）。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { credentialsPath, readCredentials, writeCredentials } from '../client.ts';
import { CliError } from '../env.ts';
import { secretSet } from '../secret.ts';
import {
  applyMigration,
  checkAuth,
  deployPages,
  deployWorker,
  ensurePagesProject,
  putSecret,
  type Spawner,
  type SpawnOpts,
  type SpawnResult,
} from './deploy.ts';
import {
  answersPath,
  copyDir,
  deployAssetsDir,
  deploymentDir,
  loadState,
  saveState,
} from './paths.ts';
import { type ProvisionResult, provisionResources, type WranglerResult } from './provision.ts';
import { generateTrustRoot, publicJwkFromPrivate, signAdminToken } from './secrets.ts';
import {
  type DeploymentState,
  type InitStep,
  markCompleted,
  newState,
  pendingSteps,
} from './state.ts';
import {
  D1_LIBS,
  isValidNamePrefix,
  renderWranglerConfig,
  resourceNames,
} from './wrangler-config.ts';

const WORKERS: { key: 'toolbridge' | 'pluginFeishu' | 'gateway'; dir: string }[] = [
  { key: 'toolbridge', dir: 'toolbridge' },
  { key: 'pluginFeishu', dir: 'plugin-feishu' },
  { key: 'gateway', dir: 'gateway' },
];

/** 默认 spawner：spawnSync + 继承 process.env（含 CLOUDFLARE_* 凭据）。 */
function defaultSpawner(): Spawner {
  return (bin, args, opts: SpawnOpts = {}) => {
    const res = spawnSync(bin, args, {
      env: process.env,
      cwd: opts.cwd,
      input: opts.input,
      encoding: 'utf8',
      stdio:
        opts.input !== undefined ? ['pipe', 'pipe', 'pipe'] : opts.inherit ? 'inherit' : 'pipe',
    });
    return {
      status: res.status ?? 1,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
    } satisfies SpawnResult;
  };
}

/** provision 用的 WranglerRunner（走 npx pinned wrangler，合并 stdout+stderr）。 */
function provisionRunner(spawn: Spawner): (args: string[]) => WranglerResult {
  return (args) => {
    const res = spawn('npx', ['--yes', 'wrangler@4.107.0', ...args]);
    return { status: res.status, out: `${res.stdout}${res.stderr}` };
  };
}

/** 从 wrangler deploy 输出提取 Worker URL（custom domain 或 workers.dev）。 */
export function extractDeployUrl(stdout: string): string | undefined {
  const m = stdout.match(/https?:\/\/[^\s'"]+/);
  return m ? m[0] : undefined;
}

export interface InitCliOptions {
  resume?: boolean;
  prefix?: string;
  domain?: string;
  adminPrincipal?: string;
  feishu?: boolean;
  /** 非交互（CI）：跳过 prompts，全用 flags/env（缺必填即报错）。 */
  yes?: boolean;
}

/**
 * 运行 init 向导。返回进程退出码。
 * out/err 注入便于测试；spawn 注入便于测试（默认真实 spawnSync）。
 */
export async function runInit(
  cli: InitCliOptions,
  deps: {
    spawn?: Spawner;
    fetch?: typeof globalThis.fetch;
    home?: string;
    out?: (l: string) => void;
    err?: (l: string) => void;
  } = {},
): Promise<number> {
  const spawn = deps.spawn ?? defaultSpawner();
  const home = deps.home ?? homedir();
  const out = deps.out ?? ((l: string) => process.stdout.write(`${l}\n`));

  p.intro('watt init — deploy Watt to your own Cloudflare account');

  // ── 应答：resume 读存档，否则交互问答 ──────────────────────────────────────
  let state: DeploymentState;
  let resuming = false;
  if (cli.resume) {
    const prefix = cli.prefix;
    if (!prefix) {
      throw new CliError('--resume requires --prefix <name> to locate the deployment archive', 2);
    }
    const loaded = loadState(prefix, home);
    if (!loaded) {
      throw new CliError(`no deployment archive at ${answersPath(prefix, home)}`, 2);
    }
    state = loaded;
    resuming = true;
    p.log.info(
      `resuming deployment '${prefix}' (pending: ${pendingSteps(state).join(', ') || 'none'})`,
    );
  } else {
    state = await askQuestions(cli, home);
  }

  // LLM key 明文只在本进程内存中（不入 answers.json）。resume 时若 llmSecret 待跑则重新询问。
  let llmKeyValue: string | undefined;
  if (state.llmKeyProvided && state.completed.llmSecret !== true) {
    llmKeyValue = await askLlmKey(cli, resuming);
  }

  const names = resourceNames(state.namePrefix);
  const dir = deploymentDir(state.namePrefix, home);
  const assets = deployAssetsDir();
  const todo = new Set<InitStep>(pendingSteps(state));
  const run = <T>(step: InitStep, fn: () => T | Promise<T>): Promise<T | undefined> =>
    todo.has(step) ? Promise.resolve(fn()) : Promise.resolve(undefined);

  const complete = (step: InitStep) => {
    state = markCompleted(state, step);
    saveState(state, home);
  };

  // ── ① auth ────────────────────────────────────────────────────────────────
  await run('auth', () => {
    const auth = checkAuth(spawn);
    if (!auth.ok) {
      throw new CliError(
        `wrangler is not authenticated. Set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID ` +
          `(or run \`wrangler login\`) and retry.\n${auth.detail}`,
        2,
      );
    }
    p.log.success('wrangler authenticated');
    complete('auth');
  });

  // ── ③ provision ─────────────────────────────────────────────────────────────
  const prov = (await run('provision', async () => {
    const s = p.spinner();
    s.start('provisioning storage resources (D1×5 / KV×2 / R2×2 / Queue×2 / Vectorize)');
    const result = await provisionResources(state.namePrefix, provisionRunner(spawn), (l) =>
      s.message(l.trim()),
    );
    s.stop(`provisioned (${result.created.length} created, ${result.existed.length} existing)`);
    state = { ...state, d1Ids: result.d1Ids, kvIds: result.kvIds };
    complete('provision');
    return result;
  })) as ProvisionResult | undefined;

  // d1Ids/kvIds：本轮 provision 产出或存档回读（resume 且 provision 已完成）。
  const d1Ids = prov?.d1Ids ?? state.d1Ids;
  const kvIds = prov?.kvIds ?? state.kvIds;

  // ── ④ config：渲染三份 wrangler.jsonc + 拷产物到部署目录 ──────────────────────
  await run('config', () => {
    if (!d1Ids || !kvIds) {
      throw new CliError('internal: provision ids missing; re-run without --resume', 1);
    }
    for (const w of WORKERS) {
      if (w.key === 'pluginFeishu' && !state.feishuEnabled) continue;
      const srcDir = join(assets, w.dir);
      const destDir = join(dir, w.dir);
      copyDir(srcDir, destDir);
      const tmpl = readFileSync(join(srcDir, 'wrangler.template.jsonc'), 'utf8');
      const rendered = renderWranglerConfig(tmpl, {
        namePrefix: state.namePrefix,
        d1Ids,
        kvIds,
        customDomain: state.customDomain,
        feishuEnabled: state.feishuEnabled,
      });
      writeRendered(join(destDir, 'wrangler.jsonc'), rendered);
    }
    // dashboard dist（Pages deploy 源）。
    const dashSrc = join(assets, 'dashboard');
    if (existsSync(dashSrc)) copyDir(dashSrc, join(dir, 'dashboard'));
    p.log.success(`rendered wrangler configs into ${dir}`);
    complete('config');
  });

  const gatewayDir = join(dir, 'gateway');

  // ── ⑤ migrations ─────────────────────────────────────────────────────────────
  await run('migrations', () => {
    for (const lib of D1_LIBS) {
      const res = applyMigration(spawn, gatewayDir, names.d1[lib]);
      if (res.status !== 0) {
        throw new CliError(`migrations apply failed for ${names.d1[lib]} (exit ${res.status})`, 1);
      }
    }
    p.log.success('D1 migrations applied (×5, remote)');
    complete('migrations');
  });

  // ── ⑥ secrets + 首 admin token ───────────────────────────────────────────────
  await run('secrets', async () => {
    const tr = await generateTrustRoot(state.adminPrincipal);
    const puts: [string, string][] = [
      ['WATT_JWT_PRIVATE_JWK', tr.privateJwkJson],
      ['WATT_SECRET_ENCRYPTION_KEY', tr.encryptionKey],
      ['WATT_ADMIN_PRINCIPAL', state.adminPrincipal],
    ];
    for (const [name, value] of puts) {
      const res = putSecret(spawn, gatewayDir, name, value);
      if (res.status !== 0) {
        throw new CliError(`wrangler secret put ${name} failed (exit ${res.status})`, 1);
      }
    }
    // admin token 写 credentials.json（0600）；私钥 tr.privateJwkJson 用后即被 GC，不落盘。
    writeCredentials(
      {
        access_token: tr.adminToken,
        token_type: 'Bearer',
        base_url: state.customDomain ? `https://${state.customDomain}` : undefined,
        saved_at: new Date().toISOString(),
      },
      credentialsPath(home),
    );
    p.log.success('trust-root secrets set; admin token saved to ~/.watt/credentials.json');
    complete('secrets');
  });

  // ── ⑦ deploy ─────────────────────────────────────────────────────────────────
  let gatewayUrl = state.gatewayUrl;
  let dashboardUrl = state.dashboardUrl;
  await run('deploy', () => {
    for (const w of WORKERS) {
      if (w.key === 'pluginFeishu' && !state.feishuEnabled) continue;
      const cwd = join(dir, w.dir);
      if (w.key === 'gateway') {
        // gateway 捕获输出以提取 URL（其余继承 stdio）。
        const res = deployWorkerCapture(spawn, cwd);
        if (res.status !== 0) throw new CliError(`deploy gateway failed (exit ${res.status})`, 1);
        out(res.stdout);
        gatewayUrl =
          (state.customDomain ? `https://${state.customDomain}` : undefined) ??
          extractDeployUrl(res.stdout);
      } else {
        const res = deployWorker(spawn, cwd);
        if (res.status !== 0) {
          throw new CliError(`deploy ${w.dir} failed (exit ${res.status})`, 1);
        }
      }
    }
    // dashboard（Pages）：幂等确保项目 + deploy。
    const dashDir = join(dir, 'dashboard');
    if (existsSync(dashDir)) {
      ensurePagesProject(spawn, `${state.namePrefix}-dashboard`); // 已存在报错吞掉
      const res = deployPages(spawn, dashDir, `${state.namePrefix}-dashboard`);
      if (res.status !== 0) {
        p.log.warn(`dashboard Pages deploy failed (exit ${res.status}); continue (non-fatal)`);
      } else {
        dashboardUrl = extractDeployUrl(res.stdout);
      }
    }
    state = { ...state, gatewayUrl, dashboardUrl };
    complete('deploy');
  });

  // gateway base：custom domain 优先；否则用 deploy 提取的 URL。
  const gatewayBase = (gatewayUrl ?? state.gatewayUrl)?.replace(/\/+$/, '');

  // ── ⑧ LLM key 经 SecretStore ─────────────────────────────────────────────────
  await run('llmSecret', async () => {
    if (!state.llmKeyProvided || !llmKeyValue) {
      complete('llmSecret'); // 未提供 key → 空跑标记完成。
      return;
    }
    if (!gatewayBase) {
      throw new CliError('cannot write LLM secret: gateway URL unknown (re-run --resume)', 1);
    }
    const token = readCredentials(credentialsPath(home))?.access_token;
    if (!token) throw new CliError('cannot write LLM secret: admin token missing', 1);
    const name = state.llmSecretName ?? 'WATT_LLM_KEY';
    await secretSet(gatewayBase, token, name, llmKeyValue, { fetch: deps.fetch });
    p.log.success(
      `LLM key stored in SecretStore as ${name} (via SecretStore, not wrangler secret)`,
    );
    complete('llmSecret');
  });

  // ── ⑨ 收尾 ─────────────────────────────────────────────────────────────────
  printSummary(state, gatewayBase, dashboardUrl ?? state.dashboardUrl);
  p.outro('watt init complete');
  return 0;
}

/** 交互问答（--yes 非交互时从 flags/env 取，缺必填即抛）。 */
async function askQuestions(cli: InitCliOptions, home: string): Promise<DeploymentState> {
  const noninteractive = cli.yes === true;

  const prefix = await pick(
    cli.prefix,
    noninteractive,
    () => p.text({ message: 'Deployment name prefix', placeholder: 'watt', defaultValue: 'watt' }),
    'watt',
    '--prefix',
  );
  if (!isValidNamePrefix(prefix)) {
    throw new CliError(`invalid --prefix "${prefix}" (want /^[a-z][a-z0-9-]{0,40}$/)`, 2);
  }

  // 既有存档保护：非 resume 却已有同名部署 → 提示用 --resume。
  if (loadState(prefix, home) && !noninteractive) {
    const cont = await p.confirm({
      message: `deployment '${prefix}' already has an archive; continue and overwrite step markers?`,
      initialValue: false,
    });
    if (p.isCancel(cont) || !cont) {
      throw new CliError(`aborted; use \`watt init --resume --prefix ${prefix}\` to continue`, 0);
    }
  }

  const domainRaw = await pick(
    cli.domain,
    noninteractive,
    () =>
      p.text({
        message: 'Custom domain (optional; blank = workers.dev)',
        placeholder: '(workers.dev)',
        defaultValue: '',
      }),
    '',
    '--domain',
    true,
  );
  const customDomain = domainRaw.trim() || undefined;

  const adminPrincipal = await pick(
    cli.adminPrincipal,
    noninteractive,
    () =>
      p.text({
        message: 'Admin principal (first admin identity)',
        placeholder: 'user:alice',
        validate: (v) =>
          v?.includes(':') ? undefined : 'expected form <kind>:<id>, e.g. user:alice',
      }),
    undefined,
    '--admin-principal',
  );

  const feishuEnabled =
    cli.feishu ??
    (noninteractive
      ? false
      : Boolean(
          await p.confirm({ message: 'Enable feishu (Lark) channel plugin?', initialValue: false }),
        ));

  const llmKeyProvided = noninteractive
    ? false
    : Boolean(
        await p.confirm({
          message: 'Provide an LLM API key now (stored via SecretStore)?',
          initialValue: false,
        }),
      );

  return newState({
    namePrefix: prefix,
    customDomain,
    adminPrincipal,
    feishuEnabled,
    llmKeyProvided,
    llmSecretName: 'WATT_LLM_KEY',
  });
}

/** 询问 LLM key（password 输入，不回显）。 */
async function askLlmKey(cli: InitCliOptions, _resuming: boolean): Promise<string | undefined> {
  if (cli.yes) {
    const v = process.env.WATT_LLM_KEY;
    return v?.trim() || undefined;
  }
  const v = await p.password({ message: 'LLM API key (e.g. ANTHROPIC_API_KEY value)' });
  if (p.isCancel(v)) return undefined;
  return String(v).trim() || undefined;
}

/** 从 flag / 交互 / 默认三源取值（非交互模式跳过交互）。 */
async function pick(
  flag: string | undefined,
  noninteractive: boolean,
  prompt: () => Promise<unknown>,
  fallback: string | undefined,
  flagName: string,
  allowEmpty = false,
): Promise<string> {
  if (flag !== undefined) return flag;
  if (noninteractive) {
    if (fallback !== undefined) return fallback;
    throw new CliError(`${flagName} is required in non-interactive mode (--yes)`, 2);
  }
  const v = await prompt();
  if (p.isCancel(v)) throw new CliError('aborted', 0);
  const s = String(v ?? '').trim();
  if (!s && !allowEmpty) {
    if (fallback !== undefined) return fallback;
    throw new CliError(`${flagName} is required`, 2);
  }
  return s;
}

function writeRendered(path: string, content: string): void {
  // config 步骤已 copyDir 建目录；直接覆写渲染结果。
  writeFileSync(path, content, 'utf8');
}

/** gateway 部署捕获输出（提取 URL）；其余 worker 用 deployWorker 继承 stdio。 */
function deployWorkerCapture(spawn: Spawner, cwd: string): SpawnResult {
  // 复用 deployWorker 的参数但不继承 stdio（捕获 stdout）。
  return spawn('npx', ['--yes', 'wrangler@4.107.0', 'deploy', '--no-bundle'], { cwd });
}

function printSummary(state: DeploymentState, gatewayBase?: string, dashboardUrl?: string): void {
  const lines: string[] = [];
  lines.push(`Gateway:   ${gatewayBase ?? '(see wrangler deploy output above)'}`);
  if (dashboardUrl) lines.push(`Dashboard: ${dashboardUrl}`);
  lines.push('');
  lines.push('Next steps:');
  lines.push(`  export WATT_BASE_URL=${gatewayBase ?? '<gateway-url>'}`);
  lines.push('  watt status                       # self-check');
  if (state.feishuEnabled) {
    lines.push('');
    lines.push('  # feishu: deploy plugin secrets, then wire the channel:');
    lines.push(
      '  watt setup feishu --endpoint binding:FEISHU_PLUGIN --webhook-url <plugin-worker-url>',
    );
  }
  if (state.llmKeyProvided) {
    lines.push('');
    lines.push(`  watt provider add --secret-ref ${state.llmSecretName ?? 'WATT_LLM_KEY'} ...`);
  }
  p.note(lines.join('\n'), 'Deployment summary');
}

/**
 * `watt init --resign-admin`：对已有部署轮换 admin token（破坏性——吊销全部存量 token 含 pluginToken）。
 * 生成新 JWK → wrangler secret put WATT_JWT_PRIVATE_JWK → 轮询 JWKS 传播 → 签新 admin token → 写 credentials。
 */
export async function runResignAdmin(
  cli: { prefix?: string; force?: boolean },
  deps: {
    spawn?: Spawner;
    fetch?: typeof globalThis.fetch;
    home?: string;
  } = {},
): Promise<number> {
  const spawn = deps.spawn ?? defaultSpawner();
  const home = deps.home ?? homedir();
  const fetchImpl = deps.fetch ?? globalThis.fetch;

  const prefix = cli.prefix;
  if (!prefix) throw new CliError('--resign-admin requires --prefix <name>', 2);
  const state = loadState(prefix, home);
  if (!state) throw new CliError(`no deployment archive at ${answersPath(prefix, home)}`, 2);

  p.intro(`watt init --resign-admin — rotate admin token for '${prefix}'`);
  p.log.warn(
    'DESTRUCTIVE: this rotates WATT_JWT_PRIVATE_JWK and INVALIDATES ALL existing tokens\n' +
      '(including any pluginToken). You will need to re-run `watt setup feishu` afterward.',
  );
  if (!cli.force) {
    const ok = await p.confirm({ message: 'Proceed with rotation?', initialValue: false });
    if (p.isCancel(ok) || !ok) {
      p.cancel('aborted');
      return 0;
    }
  }

  const { generateKeyPair, exportJWK } = await import('jose');
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const jwk = await exportJWK(privateKey);
  const jwkJson = JSON.stringify(jwk);
  const expectedX = (await exportJWK(publicKey)).x;

  const gatewayDir = join(deploymentDir(prefix, home), 'gateway');
  const s = p.spinner();
  s.start('rotating WATT_JWT_PRIVATE_JWK secret');
  const put = putSecret(spawn, gatewayDir, 'WATT_JWT_PRIVATE_JWK', jwkJson);
  if (put.status !== 0) {
    s.stop('secret put failed');
    throw new CliError(`wrangler secret put failed (exit ${put.status})`, 1);
  }
  s.stop('secret rotated');

  // JWKS 传播判据：公钥 x 出现在 /.well-known/jwks.json（kid 固定不能作判据，sign-admin-token 同法）。
  const base = state.customDomain
    ? `https://${state.customDomain}`
    : state.gatewayUrl?.replace(/\/+$/, '');
  if (base && expectedX) {
    const jwksUrl = `${base}/.well-known/jwks.json`;
    const propagated = await waitForJwks(fetchImpl, jwksUrl, expectedX);
    if (!propagated) {
      p.log.warn(`new key did not appear at ${jwksUrl} within 60s; token emitted anyway`);
    }
  }

  const token = await signAdminToken(privateKey, state.adminPrincipal);
  writeCredentials(
    {
      access_token: token,
      token_type: 'Bearer',
      base_url: base,
      saved_at: new Date().toISOString(),
    },
    credentialsPath(home),
  );
  // 派生公钥自检（确保写出的 token 可被新私钥验证）。
  void publicJwkFromPrivate(jwkJson);
  p.log.success('new admin token saved to ~/.watt/credentials.json (7d)');
  if (state.feishuEnabled) {
    p.log.info('feishu was enabled — re-run `watt setup feishu` to re-issue the pluginToken');
  }
  p.outro('admin token rotated');
  return 0;
}

async function waitForJwks(
  fetchImpl: typeof globalThis.fetch,
  jwksUrl: string,
  expectedX: string,
  timeoutMs = 60_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(jwksUrl, { headers: { accept: 'application/json' } });
      if (res.ok) {
        const body = (await res.json()) as { keys?: { x?: string }[] };
        if (Array.isArray(body.keys) && body.keys.some((k) => k.x === expectedX)) return true;
      }
    } catch {
      // 边缘传播窗口/网络抖动：忽略重试。
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}
