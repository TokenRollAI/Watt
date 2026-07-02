#!/usr/bin/env node
/**
 * scripts/provision.mjs — 幂等创建并绑定附B（Architecture.md 附B）storage 段资源。
 *
 * DOD Phase 0 DoD 项 5：D1/KV/R2/Queues（+Vectorize）已由脚本创建并绑定，
 * `wrangler d1 list` 等可见。
 *
 * 附B storage 段真源：
 *   R2:        context-objects / artifacts        # M3 object provider
 *   D1:        policies / providers / audit / events   # M5 / M8 / M9 / M1 EventStore
 *   KV:        authz-cache / tenants              # M5
 *   Vectorize: context-index                     # M3 vector provider
 *   Queues:    附B 未列名字，M1 EventBus 用 Queues → 建 watt-events（本轮只建资源
 *              + gateway 作为 producer 绑定；consumer 绑定留到 Phase 2）。
 *
 * D1 建模解读：附B 把 D1 写作 “policies / providers / audit / events”，并在注释里
 *   把四项分别归属 M5 / M8 / M9 / M1 —— 是四个相互独立的模块子系统，而非单库多表。
 *   故按【多库】建模：watt-policies / watt-providers / watt-audit / watt-events。
 *   （若后续判断应合库，改为单库多表即可；此处遵循附B 逐项分列的字面意图。）
 *
 * Vectorize 维度：选 @cf/baai/bge-m3 → 1024 维，metric=cosine。
 *   理由：Watt 面向飞书等中文 IM 场景，bge-m3 为多语言 embedding，中文召回优于
 *   bge-base-en-v1.5(768/英文)。M3 vector provider 落地时用同一模型产 embedding。
 *
 * 幂等策略：每类资源先 list 查存在性（按名字 substring 匹配，避开凭据 banner 噪声），
 *   存在则跳过、不存在才 create。KV/D1 的 id 会被解析出来并回填 wrangler.jsonc。
 *
 * 安全：从 .env 读 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN 注入子进程 env，
 *   绝不打印任何秘密值。account id 亦不整段打印。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnvWithCfCreds } from './lib/env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const wranglerPath = resolve(root, 'packages/gateway/wrangler.jsonc');

// ---- 载入 .env（仅取 CF 凭据），注入子进程 env，不打印值 -----------------------
const childEnv = childEnvWithCfCreds('provision');

// ---- wrangler 子进程封装（走 devDependency）------------------------------------
function wrangler(args) {
  const res = spawnSync('pnpm', ['exec', 'wrangler', ...args], {
    env: childEnv,
    encoding: 'utf8',
  });
  return {
    status: res.status ?? 1,
    out: `${res.stdout ?? ''}${res.stderr ?? ''}`,
  };
}

// wrangler 用 env-var token 时会在 stdout 打印 whoami banner（含 account id），
// 污染 --json 输出；用名字 substring 判存在即可绕过（banner 不含 watt-* 名字）。
//
// 重要（fix 4）：list 失败**不能**被当作"资源不存在"，否则会误触发 create 或误删
// 已有绑定。所有 list 走 listOrFail：非零退出码直接 fail("list <what> failed")。
function listOrFail(args, what) {
  const res = wrangler(args);
  if (res.status !== 0) {
    console.error(`\nprovision: FAILED to list ${what} (wrangler exit ${res.status}).`);
    console.error(res.out.split('\n').slice(-15).join('\n'));
    process.exit(1);
  }
  return res.out;
}
function listContains(args, needle, what) {
  return listOrFail(args, what).includes(needle);
}

// create 报"已存在"类错误时，re-list 确认存在即视为幂等成功（Cloudflare 重名错误码
// 各资源类不一，稳妥做法是不匹配文案、而是 re-list 校验）。返回 true 表示已确认存在。
function createSucceededOrExists(createRes, listArgs, needle, what) {
  if (createRes.status === 0) return true;
  // create 失败：re-list 一次确认是否其实已存在（并发/重名/幂等重跑场景）。
  if (listContains(listArgs, needle, what)) return true;
  return false;
}

const created = [];
const skipped = [];
const blocked = [];
function note(kind, name, isNew, extra = '') {
  const rec = `${kind} ${name}${extra ? ` (${extra})` : ''}`;
  (isNew ? created : skipped).push(rec);
  console.log(`  ${isNew ? '[created]' : '[exists] '} ${rec}`);
}
function noteBlocked(kind, name, reason) {
  const rec = `${kind} ${name} — ${reason}`;
  blocked.push(rec);
  console.log(`  [BLOCKED] ${rec}`);
}
// API token 缺该资源类的写权限时 wrangler 返回 code 10000（whoami/list 仍可）。
function isAuthError(out) {
  return /Authentication error \[code: 10000\]/i.test(out);
}

// ---- D1（多库）-----------------------------------------------------------------
// 返回 { name -> database_id }
function provisionD1(names) {
  console.log('\n=== D1 databases ===');
  const ids = {};
  for (const name of names) {
    if (listContains(['d1', 'list', '--json'], name, 'D1 databases')) {
      // 已存在：查 id（d1 info --json 输出含 uuid）
      const info = wrangler(['d1', 'info', name, '--json']);
      const id = info.status === 0 ? matchUuid(info.out) : null;
      if (id) {
        ids[name] = id;
        note('D1', name, false, `id=${id.slice(0, 8)}…`);
        continue;
      }
      // fix 3：d1 info 失败或未解析出 id 时，绝不静默写 <lookup-failed> 而后续把该
      // 绑定从 marker 段删掉。先尝试从当前 wrangler.jsonc marker 段回退取已有
      // database_id；有回退则沿用，无回退则 fail 退出（保护已有绑定不被删）。
      const fallback = readExistingD1Id(name);
      if (fallback) {
        ids[name] = fallback;
        note('D1', name, false, `id=${fallback.slice(0, 8)}… (wrangler.jsonc fallback)`);
        continue;
      }
      console.error(`\nprovision: FAILED to resolve D1 "${name}" database_id.`);
      console.error(
        '  d1 info 失败/未返回 id，且 wrangler.jsonc marker 段无已有 database_id 可回退。',
      );
      console.error('  拒绝以占位符继续（否则会把已有 D1 绑定从 marker 段删掉）。');
      console.error((info.out || '').split('\n').slice(-15).join('\n'));
      process.exit(1);
    } else {
      const res = wrangler(['d1', 'create', name]);
      if (res.status !== 0) {
        if (isAuthError(res.out)) {
          ids[name] = '<blocked:token-missing-d1-write>';
          noteBlocked('D1', name, 'token lacks D1 write (code 10000)');
          continue;
        }
        // "已存在"类错误 → re-list 确认存在则走已存在分支再取 id。
        if (createSucceededOrExists(res, ['d1', 'list', '--json'], name, 'D1 databases')) {
          const info = wrangler(['d1', 'info', name, '--json']);
          const id = info.status === 0 ? matchUuid(info.out) : null;
          const fallback = id ?? readExistingD1Id(name);
          if (!fallback) fail('D1', name, res.out);
          ids[name] = fallback;
          note('D1', name, false, `id=${fallback.slice(0, 8)}… (existed)`);
          continue;
        }
        fail('D1', name, res.out);
      }
      const id = matchUuid(res.out);
      ids[name] = id ?? '<create-parse-failed>';
      note('D1', name, true, id ? `id=${id.slice(0, 8)}…` : 'id unparsed');
    }
  }
  return ids;
}

// ---- KV --------------------------------------------------------------------------
// 返回 { title -> id }
function provisionKV(titles) {
  console.log('\n=== KV namespaces ===');
  const ids = {};
  const listedOut = listOrFail(['kv', 'namespace', 'list'], 'KV namespaces');
  let parsed = [];
  try {
    parsed = JSON.parse(extractJson(listedOut) ?? '[]');
  } catch {
    parsed = [];
  }
  for (const title of titles) {
    const hit = parsed.find((n) => n.title === title);
    if (hit) {
      ids[title] = hit.id;
      note('KV', title, false, `id=${hit.id.slice(0, 8)}…`);
    } else {
      const res = wrangler(['kv', 'namespace', 'create', title]);
      if (res.status !== 0) {
        // "已存在"类错误（如 KV code 10014）→ re-list 确认并取回 id。
        const relistOut = listOrFail(['kv', 'namespace', 'list'], 'KV namespaces');
        let reparsed = [];
        try {
          reparsed = JSON.parse(extractJson(relistOut) ?? '[]');
        } catch {
          reparsed = [];
        }
        const existing = reparsed.find((n) => n.title === title);
        if (!existing) fail('KV', title, res.out);
        ids[title] = existing.id;
        note('KV', title, false, `id=${existing.id.slice(0, 8)}… (existed)`);
        continue;
      }
      const id = matchHex32(res.out);
      ids[title] = id ?? '<create-parse-failed>';
      note('KV', title, true, id ? `id=${id.slice(0, 8)}…` : 'id unparsed');
    }
  }
  return ids;
}

// ---- R2 --------------------------------------------------------------------------
function provisionR2(names) {
  console.log('\n=== R2 buckets ===');
  const listed = listOrFail(['r2', 'bucket', 'list'], 'R2 buckets');
  for (const name of names) {
    if (listed.includes(name)) {
      note('R2', name, false);
    } else {
      const res = wrangler(['r2', 'bucket', 'create', name]);
      if (!createSucceededOrExists(res, ['r2', 'bucket', 'list'], name, 'R2 buckets')) {
        fail('R2', name, res.out);
      }
      note('R2', name, res.status === 0);
    }
  }
}

// ---- Queues ----------------------------------------------------------------------
function provisionQueues(names) {
  console.log('\n=== Queues ===');
  const listed = listOrFail(['queues', 'list'], 'Queues');
  for (const name of names) {
    if (listed.includes(name)) {
      note('Queue', name, false);
    } else {
      const res = wrangler(['queues', 'create', name]);
      if (!createSucceededOrExists(res, ['queues', 'list'], name, 'Queues')) {
        fail('Queue', name, res.out);
      }
      note('Queue', name, res.status === 0);
    }
  }
}

// ---- Vectorize -------------------------------------------------------------------
function provisionVectorize(name, dimensions, metric) {
  console.log('\n=== Vectorize indexes ===');
  if (listContains(['vectorize', 'list', '--json'], name, 'Vectorize indexes')) {
    note('Vectorize', name, false, `dims=${dimensions}`);
    return true;
  } else {
    const res = wrangler([
      'vectorize',
      'create',
      name,
      `--dimensions=${dimensions}`,
      `--metric=${metric}`,
    ]);
    if (res.status !== 0) {
      if (isAuthError(res.out)) {
        noteBlocked('Vectorize', name, 'token lacks Vectorize write (code 10000)');
        return false;
      }
      // "已存在"类错误 → re-list 确认存在则视为幂等成功。
      if (listContains(['vectorize', 'list', '--json'], name, 'Vectorize indexes')) {
        note('Vectorize', name, false, `dims=${dimensions} (existed)`);
        return true;
      }
      fail('Vectorize', name, res.out);
    }
    note('Vectorize', name, true, `dims=${dimensions} metric=${metric}`);
  }
  return true;
}

// ---- 解析工具 --------------------------------------------------------------------
function matchUuid(text) {
  const m = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}
function matchHex32(text) {
  const m = text.match(/\b[0-9a-f]{32}\b/i);
  return m ? m[0] : null;
}
// 从含 banner 噪声的输出里提取首个 JSON 数组/对象。
function extractJson(text) {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  return text.slice(start);
}
// fix 3 回退：从当前 wrangler.jsonc marker 段解析某 D1 库已有的 database_id。
// 只在 marker 段内匹配，避免误取注释里的示例；无则返回 null。
function readExistingD1Id(name) {
  let src;
  try {
    src = readFileSync(wranglerPath, 'utf8');
  } catch {
    return null;
  }
  const b = src.indexOf(MARK_BEGIN);
  const e = src.indexOf(MARK_END);
  if (b < 0 || e < 0 || e < b) return null;
  const section = src.slice(b, e);
  const re = new RegExp(
    `"database_name"\\s*:\\s*"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^}]*?"database_id"\\s*:\\s*"([0-9a-f-]{36})"`,
    'i',
  );
  const m = section.match(re);
  if (m) return m[1];
  // 允许 database_id 在 database_name 之前的顺序。
  const re2 = new RegExp(
    `"database_id"\\s*:\\s*"([0-9a-f-]{36})"[^}]*?"database_name"\\s*:\\s*"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`,
    'i',
  );
  const m2 = section.match(re2);
  return m2 ? m2[1] : null;
}
function fail(kind, name, out) {
  console.error(`\nprovision: FAILED to create ${kind} "${name}".`);
  console.error(out.split('\n').slice(-15).join('\n'));
  process.exit(1);
}

// ---- 回填 wrangler.jsonc ---------------------------------------------------------
// wrangler.jsonc 是 JSONC（含注释）。本脚本在文件末尾 '}' 前注入/替换一段带 marker
// 的绑定块，保留原有注释区。marker 之间的内容每次 provision 覆盖重写。
const MARK_BEGIN = '// >>> provision:bindings (generated by scripts/provision.mjs) >>>';
const MARK_END = '// <<< provision:bindings <<<';

function isValidId(v) {
  return typeof v === 'string' && v.length > 0 && !v.startsWith('<');
}

function bindingsBlock(d1Ids, kvIds, vectorizeReady) {
  const lines = [`  ${MARK_BEGIN}`];

  // D1：只写出拿到真实 id 的库；无 id（权限被拒）的整段以注释占位，避免 deploy 报错。
  const d1Ready = D1_NAMES.filter((n) => isValidId(d1Ids[n]));
  if (d1Ready.length) {
    lines.push('  "d1_databases": [');
    lines.push(
      d1Ready
        .map((n) => {
          // 承载 wrangler 原生 d1 migrations 的库需指定 migrations_dir（binding 侧相对路径）：
          //   watt-policies -> migrations（Auth 内核，Proto §6.2/§6.3）
          //   watt-events   -> migrations-events（Event Gateway，Proto §2.4/§2.2）
          // 新增含 migrations 的库时在此登记，否则重跑 provision 会抹掉 migrations_dir（§14 金标准）。
          const migrationsDir = D1_MIGRATIONS_DIRS[n];
          const migrations = migrationsDir ? `, "migrations_dir": "${migrationsDir}"` : '';
          return `    { "binding": "${d1Binding(n)}", "database_name": "${n}", "database_id": "${d1Ids[n]}"${migrations} }`;
        })
        .join(',\n'),
    );
    lines.push('  ],');
  } else {
    lines.push(
      '  // d1_databases: token 缺 D1 写权限，资源未创建；补权限后重跑 pnpm provision 自动回填。',
    );
  }

  lines.push('  "kv_namespaces": [');
  lines.push(
    [
      `    { "binding": "KV_AUTHZ_CACHE", "id": "${kvIds[KV_AUTHZ_CACHE]}" }`,
      `    { "binding": "KV_TENANTS", "id": "${kvIds[KV_TENANTS]}" }`,
    ].join(',\n'),
  );
  lines.push('  ],');

  lines.push('  "r2_buckets": [');
  lines.push('    { "binding": "R2_CONTEXT_OBJECTS", "bucket_name": "watt-context-objects" },');
  lines.push('    { "binding": "R2_ARTIFACTS", "bucket_name": "watt-artifacts" }');
  lines.push('  ],');

  lines.push('  "queues": {');
  lines.push('    "producers": [');
  lines.push('      { "binding": "QUEUE_EVENTS", "queue": "watt-events" }');
  lines.push('    ],');
  // consumer 段（M1 EventBus 分发，Phase 2）：同 Worker 既产又消 watt-events。
  // 与 producers 同属 queues 对象（JSON 键唯一，故 consumer 配置必须在此生成而非 marker 段外）。
  // DLQ 暂不配（调研已定，留 Phase 6 可观测轮补）；重试耗尽后消息丢弃。
  lines.push('    "consumers": [');
  lines.push(
    '      { "queue": "watt-events", "max_batch_size": 10, "max_batch_timeout": 5, "max_retries": 3 }',
  );
  lines.push('    ]');
  lines.push(vectorizeReady ? '  },' : '  }');

  // Vectorize：本地 vitest-pool-workers/miniflare 可能不支持；若 verify 报错就注释掉。
  if (vectorizeReady) {
    lines.push('  "vectorize": [');
    lines.push('    { "binding": "VECTORIZE_CONTEXT", "index_name": "watt-context-index" }');
    lines.push('  ]');
  } else {
    lines.push('  // vectorize: token 缺 Vectorize 写权限，index 未创建；补权限后重跑 provision。');
  }

  lines.push(`  ${MARK_END}`);
  return lines.join('\n');
}

function d1Binding(name) {
  // watt-policies -> DB_POLICIES 等
  return `DB_${name.replace(/^watt-/, '').toUpperCase()}`;
}

function writeBindings(d1Ids, kvIds, vectorizeReady) {
  let src = readFileSync(wranglerPath, 'utf8');
  const block = bindingsBlock(d1Ids, kvIds, vectorizeReady);
  const beginIdx = src.indexOf(MARK_BEGIN);
  if (beginIdx >= 0) {
    // 替换已有 marker 段（含其行首缩进到 END 行尾）
    const endIdx = src.indexOf(MARK_END);
    const lineStart = src.lastIndexOf('\n', beginIdx) + 1;
    const endLineEnd = src.indexOf('\n', endIdx);
    src = src.slice(0, lineStart) + block + src.slice(endLineEnd);
  } else {
    // 首次注入：在最外层结束 '}' 前插入本块。需在其前一个 JSON 属性值后补逗号——
    // 但 wrangler.jsonc 末尾可能有整段行注释（占位计划），逗号必须补在最后一个
    // 真实 JSON token 之后、而非注释之后（否则 wrangler JSONC 解析报 CommaExpected）。
    const lastBrace = src.lastIndexOf('}');
    let before = src.slice(0, lastBrace);
    // 逐行剥掉尾部的空行与整行 `//` 注释，定位最后一个真实 JSON token。
    const kept = [];
    const rev = before.split('\n');
    let trimming = true;
    for (let i = rev.length - 1; i >= 0; i--) {
      const line = rev[i];
      if (trimming && (line.trim() === '' || line.trim().startsWith('//'))) continue;
      trimming = false;
      kept.unshift(line);
    }
    const tailComments = rev.slice(kept.length).join('\n');
    before = kept.join('\n').replace(/\s*$/, '');
    const withComma = /[}\]"'\d]$/.test(before) ? `${before},` : before;
    src = `${withComma}\n\n${block}\n${tailComments ? `${tailComments}\n` : ''}}\n`;
  }
  writeFileSync(wranglerPath, src, 'utf8');
  console.log(`\nprovision: wrote bindings into ${wranglerPath}`);
}

// ---- 资源名常量 ------------------------------------------------------------------
const D1_NAMES = ['watt-policies', 'watt-providers', 'watt-audit', 'watt-events'];
// 承载 wrangler 原生 d1 migrations 的库 → migrations_dir（bindingsBlock 回填用；见 §14）。
const D1_MIGRATIONS_DIRS = {
  'watt-policies': 'migrations',
  'watt-events': 'migrations-events',
};
const KV_AUTHZ_CACHE = 'watt-authz-cache';
const KV_TENANTS = 'watt-tenants';
const R2_NAMES = ['watt-context-objects', 'watt-artifacts'];
const QUEUE_NAMES = ['watt-events'];
const VECTORIZE_NAME = 'watt-context-index';
const VECTORIZE_DIMS = 1024; // @cf/baai/bge-m3
const VECTORIZE_METRIC = 'cosine';

// ---- 主流程 ----------------------------------------------------------------------
console.log('provision: creating附B storage resources (idempotent)…');

const d1Ids = provisionD1(D1_NAMES);
const kvIds = provisionKV([KV_AUTHZ_CACHE, KV_TENANTS]);
provisionR2(R2_NAMES);
provisionQueues(QUEUE_NAMES);
const vectorizeReady = provisionVectorize(VECTORIZE_NAME, VECTORIZE_DIMS, VECTORIZE_METRIC);

writeBindings(d1Ids, kvIds, vectorizeReady);

console.log('\n=== summary ===');
console.log(`created: ${created.length ? created.join(', ') : '(none)'}`);
console.log(`exists:  ${skipped.length ? skipped.join(', ') : '(none)'}`);
if (blocked.length) {
  console.log(`BLOCKED: ${blocked.join('; ')}`);
  console.log('  → API token 缺上述资源类的写权限（code 10000）；在 Cloudflare dashboard');
  console.log(
    '    给 token 补 D1 Edit / Vectorize Edit 后重跑 pnpm provision，脚本会幂等补齐并回填。',
  );
}
console.log('\nprovision: done. Verify with:');
console.log(
  '  pnpm exec wrangler d1 list / kv namespace list / r2 bucket list / queues list / vectorize list',
);
