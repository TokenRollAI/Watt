/**
 * init 向导：资源 provision（P5，计划 §P5——移植 scripts/provision.mjs 的幂等逻辑为 TS）。
 *
 * 幂等策略（照抄 .mjs 的金标准）：每类资源先 list（按名字 substring 匹配，避开 env-token banner 噪声，
 *   toolchain §7），存在则跳过取 id、不存在才 create；create 报"已存在"→ re-list 确认并取回 id。
 *   **list 失败绝不当作"资源不存在"**（否则误 create / 误判），非零退出直接抛。
 *
 * 与 .mjs 的差异：不回填 wrangler.jsonc（本向导经 wrangler-config.ts 渲染模板产出配置）；
 *   资源名由 namePrefix 派生（解掉作者账户耦合）；wrangler 子进程经 WranglerRunner 注入（单测 fake）。
 *
 * 返回 { d1Ids, kvIds }（模板渲染回填占位符用）。R2/Queue/Vectorize 仅按名引用，无 id 需回填。
 */

import { D1_LIBS, type D1Ids, type KvIds, resourceNames } from './wrangler-config.ts';

/** wrangler 子进程执行结果（stdout+stderr 合并 out，避开 banner 污染 --json，toolchain §7）。 */
export interface WranglerResult {
  status: number;
  out: string;
}

/** wrangler 子进程执行器（注入便于单测 fake）。 */
export type WranglerRunner = (args: string[]) => WranglerResult | Promise<WranglerResult>;

/** provision 进度回调（向导层打印用；可选）。 */
export type ProvisionLogger = (line: string) => void;

export interface ProvisionResult {
  d1Ids: D1Ids;
  kvIds: KvIds;
  created: string[];
  existed: string[];
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HEX32_RE = /\b[0-9a-f]{32}\b/i;

function matchUuid(text: string): string | null {
  const m = text.match(UUID_RE);
  return m ? m[0] : null;
}
function matchHex32(text: string): string | null {
  const m = text.match(HEX32_RE);
  return m ? m[0] : null;
}
/** 从含 banner 噪声的输出里提取首个 JSON 数组/对象。 */
function extractJson(text: string): string | null {
  const start = text.search(/[[{]/);
  return start < 0 ? null : text.slice(start);
}

/**
 * 幂等 provision 一个部署所需的全部存储资源。
 * @param namePrefix 部署名前缀（资源名派生源）。
 * @param run wrangler 执行器（注入）。
 * @param log 进度回调（可选）。
 */
export async function provisionResources(
  namePrefix: string,
  run: WranglerRunner,
  log: ProvisionLogger = () => {},
): Promise<ProvisionResult> {
  const names = resourceNames(namePrefix);
  const created: string[] = [];
  const existed: string[] = [];
  const note = (kind: string, name: string, isNew: boolean) => {
    (isNew ? created : existed).push(`${kind} ${name}`);
    log(`  ${isNew ? '[created]' : '[exists]'} ${kind} ${name}`);
  };

  const listOrFail = async (args: string[], what: string): Promise<string> => {
    const res = await run(args);
    if (res.status !== 0) {
      throw new Error(`provision: failed to list ${what} (wrangler exit ${res.status}).`);
    }
    return res.out;
  };

  // ---- D1（五库）----
  const d1Ids: Record<string, string> = {};
  log('=== D1 databases ===');
  for (const lib of D1_LIBS) {
    const name = names.d1[lib];
    const listed = await listOrFail(['d1', 'list', '--json'], 'D1 databases');
    if (listed.includes(name)) {
      const info = await run(['d1', 'info', name, '--json']);
      const id = info.status === 0 ? matchUuid(info.out) : null;
      if (!id) throw new Error(`provision: cannot resolve database_id for D1 "${name}".`);
      d1Ids[lib] = id;
      note('D1', name, false);
    } else {
      const res = await run(['d1', 'create', name]);
      if (res.status !== 0) {
        // "已存在"类错误 → re-list 确认并取 id。
        const relisted = await listOrFail(['d1', 'list', '--json'], 'D1 databases');
        if (!relisted.includes(name)) {
          throw new Error(`provision: failed to create D1 "${name}": ${res.out.slice(-400)}`);
        }
        const info = await run(['d1', 'info', name, '--json']);
        const id = info.status === 0 ? matchUuid(info.out) : null;
        if (!id) throw new Error(`provision: cannot resolve database_id for D1 "${name}".`);
        d1Ids[lib] = id;
        note('D1', name, false);
        continue;
      }
      const id = matchUuid(res.out);
      if (!id) throw new Error(`provision: created D1 "${name}" but could not parse its id.`);
      d1Ids[lib] = id;
      note('D1', name, true);
    }
  }

  // ---- KV（两 namespace）----
  log('=== KV namespaces ===');
  const kvIds: Record<string, string> = {};
  const kvTargets: [keyof KvIds, string][] = [
    ['authzCache', names.kvAuthzCache],
    ['tenants', names.kvTenants],
  ];
  const parseKvList = (raw: string): { title: string; id: string }[] => {
    try {
      return JSON.parse(extractJson(raw) ?? '[]') as { title: string; id: string }[];
    } catch {
      return [];
    }
  };
  for (const [key, title] of kvTargets) {
    const listRaw = await listOrFail(['kv', 'namespace', 'list'], 'KV namespaces');
    const hit = parseKvList(listRaw).find((n) => n.title === title);
    if (hit) {
      kvIds[key] = hit.id;
      note('KV', title, false);
    } else {
      const res = await run(['kv', 'namespace', 'create', title]);
      if (res.status !== 0) {
        const relist = parseKvList(await listOrFail(['kv', 'namespace', 'list'], 'KV namespaces'));
        const existing = relist.find((n) => n.title === title);
        if (!existing) {
          throw new Error(`provision: failed to create KV "${title}": ${res.out.slice(-400)}`);
        }
        kvIds[key] = existing.id;
        note('KV', title, false);
        continue;
      }
      const id = matchHex32(res.out);
      if (!id) throw new Error(`provision: created KV "${title}" but could not parse its id.`);
      kvIds[key] = id;
      note('KV', title, true);
    }
  }

  // ---- R2（两 bucket；仅按名引用，无 id）----
  log('=== R2 buckets ===');
  for (const name of [names.r2ContextObjects, names.r2Artifacts]) {
    const listed = await listOrFail(['r2', 'bucket', 'list'], 'R2 buckets');
    if (listed.includes(name)) {
      note('R2', name, false);
    } else {
      const res = await run(['r2', 'bucket', 'create', name]);
      if (
        res.status !== 0 &&
        !(await listOrFail(['r2', 'bucket', 'list'], 'R2 buckets')).includes(name)
      ) {
        throw new Error(`provision: failed to create R2 "${name}": ${res.out.slice(-400)}`);
      }
      note('R2', name, res.status === 0);
    }
  }

  // ---- Queues（两队列）----
  log('=== Queues ===');
  for (const name of [names.queueEvents, names.queueEventsDlq]) {
    const listed = await listOrFail(['queues', 'list'], 'Queues');
    if (listed.includes(name)) {
      note('Queue', name, false);
    } else {
      const res = await run(['queues', 'create', name]);
      if (res.status !== 0 && !(await listOrFail(['queues', 'list'], 'Queues')).includes(name)) {
        throw new Error(`provision: failed to create Queue "${name}": ${res.out.slice(-400)}`);
      }
      note('Queue', name, res.status === 0);
    }
  }

  // ---- Vectorize（1024 维 bge-m3 / cosine + namespace metadata index）----
  log('=== Vectorize index ===');
  const vec = names.vectorizeIndex;
  const vecListed = await listOrFail(['vectorize', 'list', '--json'], 'Vectorize indexes');
  if (vecListed.includes(vec)) {
    note('Vectorize', vec, false);
  } else {
    const res = await run(['vectorize', 'create', vec, '--dimensions=1024', '--metric=cosine']);
    if (
      res.status !== 0 &&
      !(await listOrFail(['vectorize', 'list', '--json'], 'Vectorize indexes')).includes(vec)
    ) {
      throw new Error(`provision: failed to create Vectorize "${vec}": ${res.out.slice(-400)}`);
    }
    note('Vectorize', vec, res.status === 0);
  }
  // namespace metadata index：Search filter {namespace:{$eq}} 依赖它（幂等：已存在 create 报错视为成功）。
  await run([
    'vectorize',
    'create-metadata-index',
    vec,
    '--property-name=namespace',
    '--type=string',
  ]);

  return {
    d1Ids: d1Ids as unknown as D1Ids,
    kvIds: kvIds as unknown as KvIds,
    created,
    existed,
  };
}
