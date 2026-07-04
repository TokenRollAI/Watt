/**
 * AuditSink 接线（R23 Observability）——把 AuditStore（D1 watt-audit）包成 Authorizer 的 AuditSink。
 *
 * newAuthorizer(env, traceId)：PEP 构造 Authorizer 的统一入口，注入审计 sink（DB_AUDIT）+ 当前
 *   请求 traceId（写入 AuditRecord.context.traceId，§11.4a 追踪）。所有真实 PEP 判定点（routes/
 *   tools-proxy/context-routes/consumer/event-bus/inbound/scheduler）经此构造，使每个 Check 判定
 *   （allow/deny）在 Authorizer 单点收口写一条 AuditRecord（§10），无需在各调用方逐个加 writeAudit。
 *
 * best-effort：AuditStore.write 抛错由 Authorizer.recordAudit 捕获（审计不阻塞业务）。
 */

import type { CallContext } from '@watt/core';
import { type AuditSink, Authorizer } from '../authz/authorizer.ts';
import { PolicyStore } from '../authz/policy-store.ts';
import type { Bindings } from '../env.ts';
import { AuditStore } from './audit-store.ts';

/** 构造挂 DB_AUDIT 的 AuditSink（traceId 透传到 AuditRecord.context）。 */
export function auditSink(env: Bindings, traceId?: string): AuditSink {
  const store = new AuditStore(env.DB_AUDIT);
  return {
    traceId,
    async write(record: {
      context: CallContext;
      resource: string;
      action: string;
      decision: 'allow' | 'deny';
      detail?: unknown;
    }): Promise<void> {
      await store.write(record);
    },
  };
}

/** 统一 PEP 入口：构造带审计 sink 的 Authorizer（policies=DB_POLICIES，audit=DB_AUDIT）。
 *  defLoader（R33）：agent 主体（claims.agent_def）经 AgentRegistry 惰性播种定义供步骤 2 衰减。 */
export function newAuthorizer(env: Bindings, traceId?: string): Authorizer {
  return new Authorizer(new PolicyStore(env.DB_POLICIES), auditSink(env, traceId), async (name) => {
    const { AgentRegistry } = await import('../agent/agent-registry.ts');
    const def = await new AgentRegistry(env.DB_PROVIDERS).get(name);
    return 'code' in def ? null : def;
  });
}
