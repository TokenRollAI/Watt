/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import type { Policy } from '@watt/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { IdentityMapper } from '../src/authz/identity-mapper.ts';
import { PolicyStore } from '../src/authz/policy-store.ts';
import { ensureSeedPolicy, resetSeedGuardForTests, SEED_POLICY_ID } from '../src/authz/seed.ts';

/**
 * PolicyStore / IdentityMapper / 种子引导单测（真实 D1 binding，vitest-pool-workers）。
 * oracle 硬编码自 Proto §0.4（四动词语义）/ §6.5c（种子内容）/ §6.3（ResolvePrincipal）。
 */

async function clearDb() {
  await env.DB_POLICIES.prepare('DELETE FROM policies').run();
  await env.DB_POLICIES.prepare('DELETE FROM identity_mappings').run();
}

beforeEach(async () => {
  await clearDb();
  resetSeedGuardForTests(); // 每个用例前重置 isolate 级引导短路，令 ensureSeedPolicy 可重复观察。
});

const P = (over: Partial<Policy> = {}): Policy => ({
  id: 'p1',
  subject: 'user:alice',
  resource: 'tool://x/*',
  actions: ['invoke'],
  effect: 'allow',
  ...over,
});

describe('PolicyStore four verbs (§0.4)', () => {
  it('Write is idempotent upsert on same id', async () => {
    const store = new PolicyStore(env.DB_POLICIES);
    await store.write(P({ resource: 'tool://x/*' }));
    await store.write(P({ resource: 'tool://y/*' })); // 同 id 覆盖
    const page = await store.list();
    if ('code' in page) throw new Error('expected Page');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.resource).toBe('tool://y/*');
  });

  it('Get returns the policy or null', async () => {
    const store = new PolicyStore(env.DB_POLICIES);
    await store.write(P());
    expect((await store.get('p1'))?.subject).toBe('user:alice');
    expect(await store.get('missing')).toBeNull();
  });

  it('Update patches existing and returns not_found for missing', async () => {
    const store = new PolicyStore(env.DB_POLICIES);
    await store.write(P());
    const updated = await store.update('p1', { effect: 'deny' });
    expect(updated).toMatchObject({ id: 'p1', effect: 'deny' });
    const miss = await store.update('nope', { effect: 'deny' });
    expect(miss).toMatchObject({ code: 'not_found', retryable: false });
  });

  it('Delete removes existing and returns not_found for missing', async () => {
    const store = new PolicyStore(env.DB_POLICIES);
    await store.write(P());
    expect(await store.delete('p1')).toEqual({ deleted: true });
    expect(await store.get('p1')).toBeNull();
    expect(await store.delete('p1')).toMatchObject({ code: 'not_found' });
  });

  it('List filters by subject via filter.subject and returns Page<Policy>', async () => {
    const store = new PolicyStore(env.DB_POLICIES);
    await store.write(P({ id: 'a', subject: 'user:alice' }));
    await store.write(P({ id: 'b', subject: 'role:admin' }));
    const filtered = await store.list({ filter: { subject: 'role:admin' } });
    if ('code' in filtered) throw new Error('expected Page');
    expect(filtered.items).toHaveLength(1);
    const all = await store.list();
    if ('code' in all) throw new Error('expected Page');
    expect(all.items).toHaveLength(2);
  });

  it('List clamps limit to the 200 max (Proto §0.2)', async () => {
    const store = new PolicyStore(env.DB_POLICIES);
    // 请求 limit=9999 应被静默钳制到 200；写入 3 条断言全部返回（不报错、不截断已有数据）。
    await store.write(P({ id: 'a' }));
    await store.write(P({ id: 'b' }));
    await store.write(P({ id: 'c' }));
    const page = await store.list({ limit: 9999 });
    if ('code' in page) throw new Error('expected Page');
    expect(page.items).toHaveLength(3);
  });

  it('List rejects an unknown filter key with invalid_argument (§0.2)', async () => {
    const store = new PolicyStore(env.DB_POLICIES);
    const res = await store.list({ filter: { bogus: 'x' } });
    expect(res).toMatchObject({ code: 'invalid_argument', retryable: false });
  });

  it('preserves condition JSON roundtrip', async () => {
    const store = new PolicyStore(env.DB_POLICIES);
    await store.write(P({ condition: { ip: '10.0.0.0/8' } }));
    expect((await store.get('p1'))?.condition).toEqual({ ip: '10.0.0.0/8' });
  });

  it('resolveCandidatePolicies pulls sub + role:* + agent:* + agent-instance:* + *', async () => {
    const store = new PolicyStore(env.DB_POLICIES);
    await store.write(P({ id: 's1', subject: 'user:alice' }));
    await store.write(P({ id: 's2', subject: 'role:ceo' }));
    await store.write(P({ id: 's3', subject: '*' }));
    await store.write(P({ id: 's4', subject: 'agent:finance' }));
    await store.write(P({ id: 's5', subject: 'role:other' })); // 不匹配
    const cands = await store.resolveCandidatePolicies({
      sub: 'user:alice',
      roles: ['ceo'],
      agent_def: 'finance',
    });
    const ids = cands.map((p) => p.id).sort();
    expect(ids).toEqual(['s1', 's2', 's3', 's4']);
  });
});

describe('IdentityMapper.ResolvePrincipal (§6.3)', () => {
  it('returns bound roles, empty for unmapped', async () => {
    const im = new IdentityMapper(env.DB_POLICIES);
    await im.bind('user:test-admin', ['admin']);
    expect((await im.resolvePrincipal('user:test-admin')).roles).toEqual(['admin']);
    expect((await im.resolvePrincipal('user:nobody')).roles).toEqual([]);
  });

  it('resolve() maps unknown channel user to anonymous', async () => {
    const im = new IdentityMapper(env.DB_POLICIES);
    const r = await im.resolve('feishu', 'ou_x');
    expect(r.principal).toBe('user:anonymous');
    expect(r.roles).toEqual([]);
  });
});

describe('ensureSeedPolicy (§6.5c)', () => {
  it('writes seed policy idempotently and binds admin principal', async () => {
    const store = new PolicyStore(env.DB_POLICIES);
    const im = new IdentityMapper(env.DB_POLICIES);
    const r1 = await ensureSeedPolicy(store, im, 'user:test-admin');
    expect(r1.seedPolicyWritten).toBe(true);
    expect(r1.adminBound).toBe(true);
    // 幂等：二次调用（重置短路后）不新增。
    resetSeedGuardForTests();
    await ensureSeedPolicy(store, im, 'user:test-admin');
    const seeds = await store.list({ filter: { subject: 'role:admin' } });
    if ('code' in seeds) throw new Error('expected Page');
    expect(seeds.items).toHaveLength(1);
    expect(seeds.items[0]).toMatchObject({
      id: SEED_POLICY_ID,
      subject: 'role:admin',
      resource: '*',
      actions: ['*'],
      effect: 'allow',
    } satisfies Partial<Policy>);
    expect((await im.resolvePrincipal('user:test-admin')).roles).toEqual(['admin']);
  });

  it('writes seed policy but skips binding when admin principal missing', async () => {
    const store = new PolicyStore(env.DB_POLICIES);
    const im = new IdentityMapper(env.DB_POLICIES);
    const r = await ensureSeedPolicy(store, im, undefined);
    expect(r.adminBound).toBe(false);
    expect(await store.get(SEED_POLICY_ID)).not.toBeNull();
  });

  it('does not resurrect the seed policy after an admin edits or deletes it', async () => {
    const store = new PolicyStore(env.DB_POLICIES);
    const im = new IdentityMapper(env.DB_POLICIES);
    // 首个请求引导（isolate 短路自此缓存；后续同 isolate 请求不再碰 D1）。
    await ensureSeedPolicy(store, im, 'user:test-admin');

    // admin 把种子改成 deny（合法管理动作）——后续请求走短路命中，不得复活/覆写为 allow。
    await store.update(SEED_POLICY_ID, { effect: 'deny' });
    await ensureSeedPolicy(store, im, 'user:test-admin');
    expect((await store.get(SEED_POLICY_ID))?.effect).toBe('deny');

    // admin 删除种子——后续请求走短路命中，不得复活。
    await store.delete(SEED_POLICY_ID);
    await ensureSeedPolicy(store, im, 'user:test-admin');
    expect(await store.get(SEED_POLICY_ID)).toBeNull();
  });

  it('re-seeds only after an explicit guard reset (deploy / fresh isolate)', async () => {
    const store = new PolicyStore(env.DB_POLICIES);
    const im = new IdentityMapper(env.DB_POLICIES);
    await ensureSeedPolicy(store, im, 'user:test-admin');
    await store.delete(SEED_POLICY_ID);
    // 显式复位短路（模拟新 isolate / 部署）后，doSeed 的"仅当不存在才写"重建种子。
    resetSeedGuardForTests();
    await ensureSeedPolicy(store, im, 'user:test-admin');
    expect(await store.get(SEED_POLICY_ID)).not.toBeNull();
  });

  it('does not reset admin roles after extra roles are appended', async () => {
    const store = new PolicyStore(env.DB_POLICIES);
    const im = new IdentityMapper(env.DB_POLICIES);
    await ensureSeedPolicy(store, im, 'user:test-admin');

    // admin 追加 auditor 角色后，再次引导不得抹回 ["admin"]。
    await im.bind('user:test-admin', ['admin', 'auditor']);
    resetSeedGuardForTests();
    await ensureSeedPolicy(store, im, 'user:test-admin');
    expect((await im.resolvePrincipal('user:test-admin')).roles).toEqual(['admin', 'auditor']);
  });
});
