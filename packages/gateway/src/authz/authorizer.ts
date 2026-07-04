/**
 * Authorizer（Proto §6.1/§6.4c）——接线：从 PolicyStore 取候选 Policy → core.authorize() 四步判定。
 *
 * agentDefs 索引（R33 修正）：历史上恒传空（Phase 1 注释残留），导致任何带 agent_def 的主体在
 * 步骤 2 被「agent definition not found」误拒（§51 同类坑；lurker 出站曾因此绕道直调 core）。
 * 现经可选注入的 defLoader 惰性取 claims.agent_def 对应定义播种；loader 缺省/查无 → 传空（保持
 * 原衰减语义：无定义即无授权面）。cronJobs/instances 仍传空（cron 链段由 script 侧自足播种）。
 *
 * KV 判定缓存本轮跳过（先正确后快，见 policy-store.ts 注释）。
 *
 * R23（Observability）：审计留痕在此 **PEP 单点收口**——每个 Check 判定点（allow/deny 都写）经可选
 *   注入的 AuditSink 写一条 AuditRecord（§10）。不在 17 个 check 调用方逐个加（横切）。审计写失败
 *   **best-effort console.error 不阻塞业务**（审计不是判定路径的一部分）。sink 缺省不传（如 core 纯
 *   逻辑测试、无审计需求的构造点）→ 不写。routes/tools-proxy/consumer 等真实 PEP 经 newAuthorizer
 *   注入 sink（见 audit/audit-sink.ts）。
 */

import {
  type AccessDecision,
  type AgentDefinition,
  authorize,
  type CallContext,
  type TokenClaims,
} from '@watt/core';
import type { PolicyStore } from './policy-store.ts';

/** agent_def → 定义 惰性加载（注入以解耦 AgentRegistry/D1；查无/出错返回 null）。 */
export type AgentDefLoader = (name: string) => Promise<AgentDefinition | null>;

/** 审计写出抽象（注入以解耦 D1 依赖 + 便于测试）。写一条判定留痕；实现负责 best-effort 容错。 */
export interface AuditSink {
  /** 当前请求的 traceId（写入 CallContext.traceId；缺省用 claims.trace 或生成）。 */
  traceId?: string;
  write(record: {
    context: CallContext;
    resource: string;
    action: string;
    decision: 'allow' | 'deny';
    detail?: unknown;
  }): Promise<void>;
}

/** 从 claims + traceId 构造 CallContext（§0.3；与 http/auth.ts buildCallContext 同源逻辑）。 */
function claimsToContext(claims: TokenClaims, traceId: string | undefined): CallContext {
  const ctx: CallContext = {
    principal: claims.sub,
    roles: claims.roles,
    traceId: traceId ?? claims.trace ?? crypto.randomUUID(),
  };
  if (claims.agent_def !== undefined && claims.agent_inst !== undefined) {
    ctx.agent = { instanceId: claims.agent_inst, chain: claims.chain ?? [] };
  }
  return ctx;
}

export class Authorizer {
  constructor(
    private readonly policies: PolicyStore,
    private readonly audit?: AuditSink,
    private readonly defLoader?: AgentDefLoader,
  ) {}

  /** Check（§6.1）——(claims, resource, action) → AccessDecision。判定后写审计（有 sink 时）。 */
  async check(claims: TokenClaims, resource: string, action: string): Promise<AccessDecision> {
    const candidates = await this.policies.resolveCandidatePolicies(claims);
    // agent 主体（claims.agent_def）：惰性播种其定义供步骤 2 衰减（R33 修正，见文件头）。
    let agentDefs: Record<string, AgentDefinition> = {};
    if (claims.agent_def !== undefined && this.defLoader !== undefined) {
      const def = await this.defLoader(claims.agent_def);
      if (def !== null) agentDefs = { [claims.agent_def]: def };
    }
    const decision = authorize({
      claims,
      resource,
      action,
      policies: candidates,
      agentDefs,
      cronJobs: {},
      instances: {},
    });
    await this.recordAudit(claims, resource, action, decision);
    return decision;
  }

  /** CheckBatch（§6.1）——逐条 Check（List 裁剪用）。每条判定同样写审计。 */
  async checkBatch(
    reqs: { claims: TokenClaims; resource: string; action: string }[],
  ): Promise<AccessDecision[]> {
    return Promise.all(reqs.map((r) => this.check(r.claims, r.resource, r.action)));
  }

  /** 写一条判定留痕（best-effort，审计不阻塞业务）。无 sink 则不写。 */
  private async recordAudit(
    claims: TokenClaims,
    resource: string,
    action: string,
    decision: AccessDecision,
  ): Promise<void> {
    if (this.audit === undefined) return;
    try {
      const detail =
        decision.reason !== undefined || decision.obligations !== undefined
          ? { reason: decision.reason, obligations: decision.obligations }
          : undefined;
      await this.audit.write({
        context: claimsToContext(claims, this.audit.traceId),
        resource,
        action,
        decision: decision.allow ? 'allow' : 'deny',
        ...(detail === undefined ? {} : { detail }),
      });
    } catch (err) {
      // 审计写失败不阻塞判定（§10 数据面 best-effort）；仅记日志。
      console.error('authorizer: audit write failed', {
        resource,
        action,
        allow: decision.allow,
        err: String(err),
      });
    }
  }
}
