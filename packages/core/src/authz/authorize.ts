/**
 * §6.4c 判定算法（`Authorizer.Check` 的规范展开）——纯函数，无 I/O。
 *
 * 所有数据由参数注入（policies / agentDefs / cronJobs / instances），
 * PolicyStore/AgentRegistry/Scheduler 的实际取数留 Phase 1 后续轮。
 *
 * 判定公式（§6.1 L639）：allow = P(principal) ∩ P(agent 定义 grants) ∩ P(链上每个祖先)。
 * 任一环缺失 → deny。权限只沿派生链衰减。
 */

import type { AccessDecision, AgentDefinition, CronJob, Policy, TokenClaims } from '../types.ts';
import { grantsCover, policyAllows } from './match.ts';

export interface AuthorizeInput {
  /** 调用方 token claims（agent token 有 agent_def/agent_inst/chain；user token 无）。 */
  claims: TokenClaims;
  resource: string;
  action: string;
  /** 与 claims（sub+roles+agent_*）候选相关的 Policy 集合（调用前已按 subject 粗筛亦可全量传）。 */
  policies: readonly Policy[];
  /** AgentDefinition 按 name 索引（步骤 2/3 的定义上限来源）。 */
  agentDefs: Record<string, AgentDefinition | undefined>;
  /** CronJob 按 jobId 索引（步骤 3 的 cron 系统段）；缺键视为已删除。 */
  cronJobs: Record<string, CronJob | undefined>;
  /** 祖先实例 ID → 其 agent_def name 的解析表（步骤 3 逐段取 grants 用）。 */
  instances: Record<string, string | undefined>;
}

const CRON_SEGMENT_PREFIX = 'cron:';

/**
 * 判定入口。返回 AccessDecision，deny 时 reason 指明是哪一步拒绝的（为 AuditLog 铺垫）。
 */
export function authorize(input: AuthorizeInput): AccessDecision {
  const { claims, resource, action, policies, agentDefs, cronJobs, instances } = input;

  // ── 步骤 1：principal 许可（deny 优先，默认拒绝）──────────────────────
  if (!policyAllows(policies, claims, resource, action)) {
    return { allow: false, reason: 'principal not permitted' };
  }

  // 无 agent 段（user/service 直调，§6.5b）→ 只走步骤 1。
  // 判据 = claims 无 agent_def 段（对应 CallContext.agent 缺省，§6.4a/§6.5a）。
  if (claims.agent_def === undefined) {
    return { allow: true };
  }

  // ── 步骤 2：当前 Agent 定义上限 ──────────────────────────────────────
  const currentDef = agentDefs[claims.agent_def];
  if (currentDef === undefined) {
    return { allow: false, reason: `agent definition not found: ${claims.agent_def}` };
  }
  if (!grantsCover(currentDef.grants, resource, action)) {
    return { allow: false, reason: 'agent definition grant exceeded' };
  }

  // ── 步骤 3：沿 chain 逐段衰减（根→当前）─────────────────────────────
  const chain = claims.chain ?? [];
  for (const seg of chain) {
    if (seg.startsWith(CRON_SEGMENT_PREFIX)) {
      const jobId = seg.slice(CRON_SEGMENT_PREFIX.length);
      const job = cronJobs[jobId];
      // 已删除或禁用 → 该环视为空集 → deny（§6.4c 步骤 3，2026-07-02 修订）。
      if (job === undefined || job.enabled === false) {
        return { allow: false, reason: `cron job disabled/deleted: ${jobId}` };
      }
      if (job.action.kind === 'script') {
        // script 段：以 job.action.grants 作该环上限。
        if (!grantsCover(job.action.grants, resource, action)) {
          return { allow: false, reason: `cron script grant exceeded: ${jobId}` };
        }
      }
      // kind 'agent' / 'publish'：该段不追加上限（衰减由后续链段承担），跳过。
      continue;
    }

    // 实例 ID 段：取该实例的 agent_def 的 grants。当前实例段已在步骤 2 处理，
    // 但为保持"每个祖先都要覆盖"的语义，逐段仍统一校验（当前段会再命中一次，结果一致）。
    const defName = instances[seg];
    if (defName === undefined) {
      return { allow: false, reason: `chain instance not resolvable: ${seg}` };
    }
    const segDef = agentDefs[defName];
    if (segDef === undefined) {
      return { allow: false, reason: `agent definition not found: ${defName}` };
    }
    if (!grantsCover(segDef.grants, resource, action)) {
      return { allow: false, reason: `chain segment grant exceeded: ${seg}` };
    }
  }

  // ── 步骤 4：全部环节允许 ────────────────────────────────────────────
  return { allow: true };
}
