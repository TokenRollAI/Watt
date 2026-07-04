import { describe, expect, it } from 'vitest';
import { provisionResources, type WranglerResult, type WranglerRunner } from './provision.ts';

/**
 * fake wrangler：按 args 分派返回，模拟"资源已存在"或"全新创建"。
 * existing: 已存在的资源名集合（list 会包含；create 不会被调用）。
 */
function makeFakeWrangler(opts: { existing?: Set<string>; failList?: boolean }): {
  run: WranglerRunner;
  calls: string[][];
} {
  const existing = opts.existing ?? new Set<string>();
  const created = new Set<string>();
  const calls: string[][] = [];
  const uuidFor = (name: string) =>
    `00000000-0000-4000-8000-${name
      .slice(-12)
      .padStart(12, '0')
      .replace(/[^0-9a-f]/g, '0')}`;
  const hex32For = (name: string) =>
    name
      .replace(/[^0-9a-f]/gi, '0')
      .slice(0, 32)
      .padEnd(32, '0');

  const run: WranglerRunner = (args) => {
    calls.push(args);
    const join = args.join(' ');
    if (opts.failList && /(^| )(list)( |$)/.test(join)) {
      return { status: 1, out: 'network error' } satisfies WranglerResult;
    }
    // list 类：返回当前 existing ∪ created。
    if (
      args[1] === 'list' ||
      (args[0] === 'kv' && args[2] === 'list') ||
      (args[0] === 'queues' && args[1] === 'list') ||
      (args[0] === 'r2' && args[2] === 'list')
    ) {
      const all = [...existing, ...created];
      // KV list --json 期望 [{title,id}]；其余 substring 匹配即可。
      if (args[0] === 'kv') {
        return { status: 0, out: JSON.stringify(all.map((t) => ({ title: t, id: hex32For(t) }))) };
      }
      return { status: 0, out: all.map((n) => `name: ${n}`).join('\n') };
    }
    // d1 info --json → uuid
    if (args[0] === 'd1' && args[1] === 'info') {
      return { status: 0, out: JSON.stringify({ uuid: uuidFor(args[2] ?? '') }) };
    }
    // create 类
    if (
      args[1] === 'create' ||
      (args[0] === 'kv' && args[2] === 'create') ||
      (args[0] === 'r2' && args[2] === 'create') ||
      (args[0] === 'queues' && args[1] === 'create')
    ) {
      const name =
        args[0] === 'kv' ? (args[3] ?? '') : args[0] === 'r2' ? (args[3] ?? '') : (args[2] ?? '');
      created.add(name);
      if (args[0] === 'd1') return { status: 0, out: `Created DB ${name} ${uuidFor(name)}` };
      if (args[0] === 'kv') return { status: 0, out: `id = "${hex32For(name)}"` };
      return { status: 0, out: `created ${name}` };
    }
    // create-metadata-index 幂等
    return { status: 0, out: 'ok' };
  };
  return { run, calls };
}

describe('provisionResources', () => {
  it('fresh account: creates all resources and parses ids', async () => {
    const { run, calls } = makeFakeWrangler({});
    const res = await provisionResources('wtest', run);
    expect(res.d1Ids.policies).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.kvIds.tenants).toMatch(/^[0-9a-f]{32}$/);
    // 五库 + 两 KV 全 created。
    expect(res.created.some((c) => c.includes('wtest-policies'))).toBe(true);
    expect(res.created.some((c) => c.includes('wtest-tenants'))).toBe(true);
    // create 命令被调用过。
    expect(calls.some((c) => c[0] === 'd1' && c[1] === 'create')).toBe(true);
  });

  it('idempotent: all existing → nothing created, ids resolved via info/list', async () => {
    const existing = new Set([
      'wtest-policies',
      'wtest-providers',
      'wtest-audit',
      'wtest-events',
      'wtest-context',
      'wtest-authz-cache',
      'wtest-tenants',
      'wtest-context-objects',
      'wtest-artifacts',
      'wtest-events',
      'wtest-events-dlq',
      'wtest-context-index',
    ]);
    const { run, calls } = makeFakeWrangler({ existing });
    const res = await provisionResources('wtest', run);
    expect(res.created).toHaveLength(0);
    expect(res.existed.length).toBeGreaterThanOrEqual(9);
    expect(res.d1Ids.context).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.kvIds.authzCache).toMatch(/^[0-9a-f]{32}$/);
    // 幂等：绝不调用任何 create。
    expect(calls.some((c) => c.includes('create') && !c.includes('create-metadata-index'))).toBe(
      false,
    );
  });

  it('list failure aborts (never treated as "resource absent")', async () => {
    const { run } = makeFakeWrangler({ failList: true });
    await expect(provisionResources('wtest', run)).rejects.toThrow(/failed to list/);
  });
});
