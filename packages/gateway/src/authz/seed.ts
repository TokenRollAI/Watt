/**
 * 种子引导（Proto §6.5c）——首次请求/部署后幂等初始化。
 *
 * 1. 幂等写入种子 Policy `{subject:"role:admin", resource:"*", actions:["*"], effect:"allow"}`
 *    （固定 id "seed-admin-allow-all"）——仅当不存在才 write，管理员事后修改/删除后不被复活。
 * 2. 把 WATT_ADMIN_PRINCIPAL 绑定 admin 角色——仅当该 principal 尚无映射行时才 bind，
 *    避免抹掉后续追加到该 principal 上的其他角色。
 *
 * 之后 admin 登录 CLI/Dashboard → user token 的 roles 含 admin → 命中种子 Policy → 可管理后续所有 Policy。
 * WATT_ADMIN_PRINCIPAL 缺失时只写种子 Policy（无 principal 可绑），并记警告（不 fail：仍可后续补）。
 *
 * isolate 级短路：模块级 promise 缓存，ensureSeedPolicy 首次成功后不再打 D1
 * （原实现每认证请求 2 次 D1 写）。短路命中即返回缓存——管理员事后删除/修改种子后
 * 不会被复活/覆写（这正是幂等语义所要求的）。失败时把缓存置回 null 以保留重试。
 * 测试清库后须调 resetSeedGuardForTests() 复位，否则种子不再重建。
 */

import type { Policy } from '@watt/core';
import type { IdentityMapper } from './identity-mapper.ts';
import type { PolicyStore } from './policy-store.ts';

export const SEED_POLICY_ID = 'seed-admin-allow-all';

export const SEED_POLICY: Policy = {
  id: SEED_POLICY_ID,
  subject: 'role:admin',
  resource: '*',
  actions: ['*'],
  effect: 'allow',
};

export interface SeedResult {
  seedPolicyWritten: true;
  adminBound: boolean;
  adminPrincipal?: string;
}

/** isolate 级短路缓存（同一 isolate 内已成功引导的结果）。失败/自愈时置回 null。 */
let seeded: Promise<SeedResult> | null = null;

/**
 * 幂等引导：写种子 Policy + 绑定 admin principal。可安全重复调用。
 * @param adminPrincipal WATT_ADMIN_PRINCIPAL（形如 "user:<id>"）；缺省则跳过 admin 绑定。
 */
export function ensureSeedPolicy(
  policies: PolicyStore,
  identities: IdentityMapper,
  adminPrincipal: string | undefined,
): Promise<SeedResult> {
  if (!seeded) {
    seeded = doSeed(policies, identities, adminPrincipal).catch((err) => {
      // 引导失败：清空缓存以便下次请求重试，并向上抛出。
      seeded = null;
      throw err;
    });
  }
  return seeded;
}

/** 实际引导逻辑（幂等语义修正：种子 Policy 与角色绑定均"仅当不存在才写"）。 */
async function doSeed(
  policies: PolicyStore,
  identities: IdentityMapper,
  adminPrincipal: string | undefined,
): Promise<SeedResult> {
  // 1. 种子 Policy：仅当不存在才写（管理员事后修改/删除后不被复活）。
  const existing = await policies.get(SEED_POLICY_ID);
  if (existing === null) {
    await policies.write(SEED_POLICY);
  }

  // 2. admin principal → ["admin"]：仅当尚无映射行时才 bind（不覆盖后续追加的角色）。
  let adminBound = false;
  const principal = adminPrincipal?.trim();
  if (principal) {
    const current = await identities.resolvePrincipal(principal);
    if (current.roles.length === 0) {
      await identities.bind(principal, ['admin']);
    }
    adminBound = true;
  }

  return {
    seedPolicyWritten: true,
    adminBound,
    adminPrincipal: principal || undefined,
  };
}

/** 测试专用：重置 isolate 级短路缓存（每个用例前清），使引导逻辑可被重复观察。 */
export function resetSeedGuardForTests(): void {
  seeded = null;
}
