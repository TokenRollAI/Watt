/**
 * Authorizer（Proto §6.1/§6.4c）——接线：从 PolicyStore 取候选 Policy → core.authorize() 四步判定。
 *
 * Phase 1 范围：Agent Registry / Scheduler 尚未落地（Phase 4/5），故 agentDefs/cronJobs/instances
 * 传空。user token（无 agent 段）只走判定步骤 1；agent token 因无 def 数据会在步骤 2 deny——
 * 这是正确的衰减语义（本 Phase 无 Agent 定义即无授权面）。
 *
 * KV 判定缓存本轮跳过（先正确后快，见 policy-store.ts 注释）。
 */

import { type AccessDecision, authorize, type TokenClaims } from '@watt/core';
import type { PolicyStore } from './policy-store.ts';

export class Authorizer {
  constructor(private readonly policies: PolicyStore) {}

  /** Check（§6.1）——(claims, resource, action) → AccessDecision。 */
  async check(claims: TokenClaims, resource: string, action: string): Promise<AccessDecision> {
    const candidates = await this.policies.resolveCandidatePolicies(claims);
    return authorize({
      claims,
      resource,
      action,
      policies: candidates,
      // Phase 1：Agent 定义/cron/实例数据面未就绪，传空（user token 只走步骤 1）。
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
  }

  /** CheckBatch（§6.1）——逐条 Check（List 裁剪用）。 */
  async checkBatch(
    reqs: { claims: TokenClaims; resource: string; action: string }[],
  ): Promise<AccessDecision[]> {
    return Promise.all(reqs.map((r) => this.check(r.claims, r.resource, r.action)));
  }
}
