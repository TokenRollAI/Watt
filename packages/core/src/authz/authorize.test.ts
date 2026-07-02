import { describe, expect, it } from 'vitest';
import type { AgentDefinition, CronJob, Grant, Policy, TokenClaims } from '../types.ts';
import { authorize } from './authorize.ts';

/**
 * §6.4c 判定算法用例矩阵（test-first）。
 *
 * oracle 硬编码：期望值（allow/deny + reason 关键字）直接写在断言里，
 * 绝不 import 被测的 reason 常量或复用被测函数产物（Phase 0 质量关口教训：自引用恒真式）。
 *
 * 输入约定（authorize 的 AuthorizeInput）：
 *   { claims, resource, action, policies, agentDefs, cronJobs, instances }
 * - agentDefs: 按 def name 索引的 AgentDefinition
 * - cronJobs:  按 jobId 索引的 CronJob（缺键 = 已删除）
 * - instances: 祖先实例 ID → 其 agent_def name 的解析表（step 3 用）
 */

// ── 便捷构造器（测试夹具，非被测代码）───────────────────────────────────
function userClaims(sub: string, roles: string[]): TokenClaims {
  return { sub, roles };
}
function agentClaims(args: {
  sub: string;
  roles: string[];
  agent_def: string;
  agent_inst: string;
  chain: string[];
}): TokenClaims {
  return { ...args };
}
function policy(
  p: Partial<Policy> & Pick<Policy, 'subject' | 'resource' | 'actions' | 'effect'>,
): Policy {
  return { id: p.id ?? `pol-${p.subject}-${p.resource}-${p.effect}`, condition: p.condition, ...p };
}
function def(name: string, grants: AgentDefinition['grants']): AgentDefinition {
  return { name, grants };
}
function scriptJob(id: string, enabled: boolean, grants: Grant[]): CronJob {
  return { id, enabled, action: { kind: 'script', scriptRef: 'context://automations/x', grants } };
}

// ═══ 步骤 1：principal 许可 ═══════════════════════════════════════════════

describe('step 1: principal permission (deny-first, default-deny)', () => {
  it('A1 principal allow: matching user policy → allow', () => {
    const d = authorize({
      claims: userClaims('user:alice', []),
      resource: 'tool://x/1',
      action: 'invoke',
      policies: [
        policy({
          subject: 'user:alice',
          resource: 'tool://x/*',
          actions: ['invoke'],
          effect: 'allow',
        }),
      ],
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(true);
  });

  it('A2 principal deny: no matching policy → default deny', () => {
    const d = authorize({
      claims: userClaims('user:alice', []),
      resource: 'tool://x/1',
      action: 'invoke',
      policies: [],
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(false);
  });

  it('B1 role match → allow', () => {
    const d = authorize({
      claims: userClaims('user:bob', ['ceo']),
      resource: 'platform://metrics',
      action: 'read',
      policies: [policy({ subject: 'role:ceo', resource: '*', actions: ['*'], effect: 'allow' })],
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(true);
  });

  it('B2 role mismatch → deny', () => {
    const d = authorize({
      claims: userClaims('user:bob', ['staff']),
      resource: 'platform://metrics',
      action: 'read',
      policies: [policy({ subject: 'role:ceo', resource: '*', actions: ['*'], effect: 'allow' })],
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(false);
  });

  it('C1 deny overrides allow (deny-first)', () => {
    const d = authorize({
      claims: userClaims('user:alice', ['blocked']),
      resource: 'tool://x/1',
      action: 'invoke',
      policies: [
        policy({
          subject: 'user:alice',
          resource: 'tool://x/*',
          actions: ['invoke'],
          effect: 'allow',
        }),
        policy({
          subject: 'role:blocked',
          resource: 'tool://x/*',
          actions: ['invoke'],
          effect: 'deny',
        }),
      ],
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(false);
  });
});

// ═══ 步骤 2：agent 定义上限 ══════════════════════════════════════════════

describe('step 2: agent definition grant ceiling', () => {
  const allowAll = policy({ subject: '*', resource: '*', actions: ['*'], effect: 'allow' });

  it('D1 def grants cover → allow', () => {
    const d = authorize({
      claims: agentClaims({
        sub: 'user:alice',
        roles: [],
        agent_def: 'finance',
        agent_inst: 'inst-42',
        chain: ['inst-42'],
      }),
      resource: 'tool://finance/report',
      action: 'invoke',
      policies: [allowAll],
      agentDefs: {
        finance: def('finance', [{ resources: ['tool://finance/*'], actions: ['invoke'] }]),
      },
      cronJobs: {},
      instances: { 'inst-42': 'finance' },
    });
    expect(d.allow).toBe(true);
  });

  it('D2 def grants do NOT cover → deny (attenuation) even though principal allows', () => {
    const d = authorize({
      claims: agentClaims({
        sub: 'user:alice',
        roles: [],
        agent_def: 'finance',
        agent_inst: 'inst-42',
        chain: ['inst-42'],
      }),
      resource: 'tool://hr/salary',
      action: 'invoke',
      policies: [allowAll],
      agentDefs: {
        finance: def('finance', [{ resources: ['tool://finance/*'], actions: ['invoke'] }]),
      },
      cronJobs: {},
      instances: { 'inst-42': 'finance' },
    });
    expect(d.allow).toBe(false);
  });

  it('D3 agent_def missing from registry → deny', () => {
    const d = authorize({
      claims: agentClaims({
        sub: 'user:alice',
        roles: [],
        agent_def: 'ghost',
        agent_inst: 'inst-1',
        chain: ['inst-1'],
      }),
      resource: 'tool://x/1',
      action: 'invoke',
      policies: [allowAll],
      agentDefs: {},
      cronJobs: {},
      instances: { 'inst-1': 'ghost' },
    });
    expect(d.allow).toBe(false);
  });

  it('D4 agent token with agent_def but no chain → step 2 only, skips step 3 loop', () => {
    const d = authorize({
      claims: { sub: 'user:alice', roles: [], agent_def: 'finance', agent_inst: 'inst-42' }, // chain undefined
      resource: 'tool://finance/report',
      action: 'invoke',
      policies: [allowAll],
      agentDefs: {
        finance: def('finance', [{ resources: ['tool://finance/*'], actions: ['invoke'] }]),
      },
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(true);
  });
});

// ═══ 步骤 3：链衰减（多段 + cron 段）═════════════════════════════════════

describe('step 3: chain attenuation', () => {
  const allowAll = policy({ subject: '*', resource: '*', actions: ['*'], effect: 'allow' });

  it('E1 all ancestor defs cover → allow', () => {
    const d = authorize({
      claims: agentClaims({
        sub: 'user:alice',
        roles: [],
        agent_def: 'child',
        agent_inst: 'inst-cur',
        chain: ['inst-root', 'inst-cur'],
      }),
      resource: 'tool://x/1',
      action: 'invoke',
      policies: [allowAll],
      agentDefs: {
        parent: def('parent', [{ resources: ['tool://x/*'], actions: ['invoke'] }]),
        child: def('child', [{ resources: ['tool://x/*'], actions: ['invoke'] }]),
      },
      cronJobs: {},
      instances: { 'inst-root': 'parent', 'inst-cur': 'child' },
    });
    expect(d.allow).toBe(true);
  });

  it('E2 one ancestor def does not cover → deny', () => {
    const d = authorize({
      claims: agentClaims({
        sub: 'user:alice',
        roles: [],
        agent_def: 'child',
        agent_inst: 'inst-cur',
        chain: ['inst-root', 'inst-cur'],
      }),
      resource: 'tool://x/1',
      action: 'invoke',
      policies: [allowAll],
      agentDefs: {
        parent: def('parent', [{ resources: ['tool://y/*'], actions: ['invoke'] }]), // 根不覆盖
        child: def('child', [{ resources: ['tool://x/*'], actions: ['invoke'] }]),
      },
      cronJobs: {},
      instances: { 'inst-root': 'parent', 'inst-cur': 'child' },
    });
    expect(d.allow).toBe(false);
  });

  it('E3 ancestor instance def missing from registry → deny', () => {
    const d = authorize({
      claims: agentClaims({
        sub: 'user:alice',
        roles: [],
        agent_def: 'child',
        agent_inst: 'inst-cur',
        chain: ['inst-root', 'inst-cur'],
      }),
      resource: 'tool://x/1',
      action: 'invoke',
      policies: [allowAll],
      agentDefs: { child: def('child', [{ resources: ['tool://x/*'], actions: ['invoke'] }]) },
      cronJobs: {},
      instances: { 'inst-cur': 'child' }, // inst-root 无解析
    });
    expect(d.allow).toBe(false);
  });

  it('E4 ancestor instance not in instances map at all → deny', () => {
    const d = authorize({
      claims: agentClaims({
        sub: 'user:alice',
        roles: [],
        agent_def: 'child',
        agent_inst: 'inst-cur',
        chain: ['inst-unknown', 'inst-cur'],
      }),
      resource: 'tool://x/1',
      action: 'invoke',
      policies: [allowAll],
      agentDefs: { child: def('child', [{ resources: ['tool://x/*'], actions: ['invoke'] }]) },
      cronJobs: {},
      instances: { 'inst-cur': 'child' },
    });
    expect(d.allow).toBe(false);
  });

  it('E5 ancestor instance resolves to a def-name absent from registry → deny', () => {
    const d = authorize({
      claims: agentClaims({
        sub: 'user:alice',
        roles: [],
        agent_def: 'child',
        agent_inst: 'inst-cur',
        chain: ['inst-root', 'inst-cur'],
      }),
      resource: 'tool://x/1',
      action: 'invoke',
      policies: [allowAll],
      agentDefs: { child: def('child', [{ resources: ['tool://x/*'], actions: ['invoke'] }]) },
      cronJobs: {},
      instances: { 'inst-root': 'ghost-def', 'inst-cur': 'child' }, // ghost-def 不在 agentDefs
    });
    expect(d.allow).toBe(false);
  });
});

// ═══ 步骤 3：cron 系统段 ═════════════════════════════════════════════════

describe('step 3: cron:<jobId> system segment', () => {
  const allowAll = policy({ subject: '*', resource: '*', actions: ['*'], effect: 'allow' });

  it('F1 cron script segment within grants → allow', () => {
    const d = authorize({
      claims: agentClaims({
        sub: 'service:scheduler',
        roles: [],
        agent_def: 'worker',
        agent_inst: 'inst-9',
        chain: ['cron:job-1', 'inst-9'],
      }),
      resource: 'platform://metrics',
      action: 'read',
      policies: [allowAll],
      agentDefs: {
        worker: def('worker', [{ resources: ['platform://metrics'], actions: ['read'] }]),
      },
      cronJobs: {
        'job-1': scriptJob('job-1', true, [
          { resources: ['platform://metrics'], actions: ['read'] },
        ]),
      },
      instances: { 'inst-9': 'worker' },
    });
    expect(d.allow).toBe(true);
  });

  it('F1b cron script segment OUTSIDE grants → deny', () => {
    const d = authorize({
      claims: agentClaims({
        sub: 'service:scheduler',
        roles: [],
        agent_def: 'worker',
        agent_inst: 'inst-9',
        chain: ['cron:job-1', 'inst-9'],
      }),
      resource: 'platform://audit',
      action: 'read',
      policies: [allowAll],
      agentDefs: { worker: def('worker', [{ resources: ['*'], actions: ['*'] }]) },
      cronJobs: {
        'job-1': scriptJob('job-1', true, [
          { resources: ['platform://metrics'], actions: ['read'] },
        ]),
      },
      instances: { 'inst-9': 'worker' },
    });
    expect(d.allow).toBe(false);
  });

  it('F2 cron job disabled → deny (empty set)', () => {
    const d = authorize({
      claims: agentClaims({
        sub: 'service:scheduler',
        roles: [],
        agent_def: 'worker',
        agent_inst: 'inst-9',
        chain: ['cron:job-1', 'inst-9'],
      }),
      resource: 'platform://metrics',
      action: 'read',
      policies: [allowAll],
      agentDefs: { worker: def('worker', [{ resources: ['*'], actions: ['*'] }]) },
      cronJobs: {
        'job-1': scriptJob('job-1', false, [
          { resources: ['platform://metrics'], actions: ['read'] },
        ]),
      },
      instances: { 'inst-9': 'worker' },
    });
    expect(d.allow).toBe(false);
  });

  it('F3 cron job deleted (not found) → deny', () => {
    const d = authorize({
      claims: agentClaims({
        sub: 'service:scheduler',
        roles: [],
        agent_def: 'worker',
        agent_inst: 'inst-9',
        chain: ['cron:job-1', 'inst-9'],
      }),
      resource: 'platform://metrics',
      action: 'read',
      policies: [allowAll],
      agentDefs: { worker: def('worker', [{ resources: ['*'], actions: ['*'] }]) },
      cronJobs: {}, // job-1 已删除
      instances: { 'inst-9': 'worker' },
    });
    expect(d.allow).toBe(false);
  });

  it('F4 cron agent-kind segment adds NO ceiling (does not attenuate)', () => {
    // job.action.kind='agent' 无 grants → 该段不追加上限；只要 def 与 principal 允许即可 allow。
    const d = authorize({
      claims: agentClaims({
        sub: 'service:scheduler',
        roles: [],
        agent_def: 'worker',
        agent_inst: 'inst-9',
        chain: ['cron:job-2', 'inst-9'],
      }),
      resource: 'platform://metrics',
      action: 'read',
      policies: [allowAll],
      agentDefs: {
        worker: def('worker', [{ resources: ['platform://metrics'], actions: ['read'] }]),
      },
      cronJobs: {
        'job-2': { id: 'job-2', enabled: true, action: { kind: 'agent', definition: 'worker' } },
      },
      instances: { 'inst-9': 'worker' },
    });
    expect(d.allow).toBe(true);
  });

  it('F5 cron publish-kind segment adds NO ceiling', () => {
    const d = authorize({
      claims: agentClaims({
        sub: 'service:scheduler',
        roles: [],
        agent_def: 'worker',
        agent_inst: 'inst-9',
        chain: ['cron:job-3', 'inst-9'],
      }),
      resource: 'event://webhook/x',
      action: 'write',
      policies: [allowAll],
      agentDefs: {
        worker: def('worker', [{ resources: ['event://webhook/*'], actions: ['write'] }]),
      },
      cronJobs: {
        'job-3': {
          id: 'job-3',
          enabled: true,
          action: { kind: 'publish', event: { type: 'cron.fired' } },
        },
      },
      instances: { 'inst-9': 'worker' },
    });
    expect(d.allow).toBe(true);
  });

  it('F6 disabled agent-kind cron still denies (disabled checked before kind)', () => {
    const d = authorize({
      claims: agentClaims({
        sub: 'service:scheduler',
        roles: [],
        agent_def: 'worker',
        agent_inst: 'inst-9',
        chain: ['cron:job-4', 'inst-9'],
      }),
      resource: 'platform://metrics',
      action: 'read',
      policies: [allowAll],
      agentDefs: { worker: def('worker', [{ resources: ['*'], actions: ['*'] }]) },
      cronJobs: {
        'job-4': { id: 'job-4', enabled: false, action: { kind: 'agent', definition: 'worker' } },
      },
      instances: { 'inst-9': 'worker' },
    });
    expect(d.allow).toBe(false);
  });
});

// ═══ 步骤跳过：user token 无 agent 段 ════════════════════════════════════

describe('user token path (no agent segment → step 1 only, §6.5b)', () => {
  it('G1 no agent segment, principal allows → allow (skips 2/3)', () => {
    const d = authorize({
      claims: userClaims('user:alice', ['ceo']),
      resource: 'tool://finance/report',
      action: 'invoke',
      policies: [policy({ subject: 'role:ceo', resource: '*', actions: ['*'], effect: 'allow' })],
      agentDefs: {}, // 没有 agentDefs 也应放行——证明未走步骤 2
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(true);
  });

  it('G2 no agent segment, principal denies → deny', () => {
    const d = authorize({
      claims: userClaims('user:alice', []),
      resource: 'tool://finance/report',
      action: 'invoke',
      policies: [],
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(false);
  });
});

// ═══ subject 五种写法 ════════════════════════════════════════════════════

describe('subject matching (§6.4b five forms)', () => {
  it('H1 agent-instance:<id> matches claims.agent_inst', () => {
    const d = authorize({
      claims: agentClaims({
        sub: 'user:alice',
        roles: [],
        agent_def: 'finance',
        agent_inst: 'inst-42',
        chain: ['inst-42'],
      }),
      resource: 'tool://x/1',
      action: 'invoke',
      policies: [
        policy({
          subject: 'agent-instance:inst-42',
          resource: 'tool://x/*',
          actions: ['invoke'],
          effect: 'allow',
        }),
      ],
      agentDefs: { finance: def('finance', [{ resources: ['*'], actions: ['*'] }]) },
      cronJobs: {},
      instances: { 'inst-42': 'finance' },
    });
    expect(d.allow).toBe(true);
  });

  it('H2 agent:<def> matches claims.agent_def (definition level)', () => {
    const d = authorize({
      claims: agentClaims({
        sub: 'user:alice',
        roles: [],
        agent_def: 'finance',
        agent_inst: 'inst-42',
        chain: ['inst-42'],
      }),
      resource: 'tool://x/1',
      action: 'invoke',
      policies: [
        policy({
          subject: 'agent:finance',
          resource: 'tool://x/*',
          actions: ['invoke'],
          effect: 'allow',
        }),
      ],
      agentDefs: { finance: def('finance', [{ resources: ['*'], actions: ['*'] }]) },
      cronJobs: {},
      instances: { 'inst-42': 'finance' },
    });
    expect(d.allow).toBe(true);
  });

  it('H3 service:<id> matches claims.sub', () => {
    const d = authorize({
      claims: userClaims('service:ci', []),
      resource: 'platform://scheduler',
      action: 'manage',
      policies: [
        policy({
          subject: 'service:ci',
          resource: 'platform://*',
          actions: ['manage'],
          effect: 'allow',
        }),
      ],
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(true);
  });

  it('H4 user:<id> matches claims.sub', () => {
    const d = authorize({
      claims: userClaims('user:alice', []),
      resource: 'tool://x/1',
      action: 'invoke',
      policies: [
        policy({
          subject: 'user:alice',
          resource: 'tool://x/*',
          actions: ['invoke'],
          effect: 'allow',
        }),
      ],
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(true);
  });

  it('H5 * subject matches anything', () => {
    const d = authorize({
      claims: userClaims('user:nobody', []),
      resource: 'tool://x/1',
      action: 'invoke',
      policies: [
        policy({ subject: '*', resource: 'tool://x/*', actions: ['invoke'], effect: 'allow' }),
      ],
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(true);
  });

  it('H6 agent:<def> does NOT match a plain user token (no agent_def)', () => {
    const d = authorize({
      claims: userClaims('user:alice', []),
      resource: 'tool://x/1',
      action: 'invoke',
      policies: [
        policy({
          subject: 'agent:finance',
          resource: 'tool://x/*',
          actions: ['invoke'],
          effect: 'allow',
        }),
      ],
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(false);
  });

  it('H7 agent-instance:<id> does NOT match when agent_inst absent', () => {
    const d = authorize({
      claims: userClaims('user:alice', []),
      resource: 'tool://x/1',
      action: 'invoke',
      policies: [
        policy({
          subject: 'agent-instance:inst-1',
          resource: 'tool://x/*',
          actions: ['invoke'],
          effect: 'allow',
        }),
      ],
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(false);
  });
});

// ═══ resource / action 通配 ══════════════════════════════════════════════

describe('resource prefix wildcard + action matching', () => {
  it('I1 prefix wildcard matches', () => {
    const d = authorize({
      claims: userClaims('user:alice', []),
      resource: 'tool://finance/report',
      action: 'invoke',
      policies: [
        policy({
          subject: 'user:alice',
          resource: 'tool://finance/*',
          actions: ['invoke'],
          effect: 'allow',
        }),
      ],
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(true);
  });

  it('I2 prefix wildcard boundary: tool://finances is NOT under tool://finance/*', () => {
    const d = authorize({
      claims: userClaims('user:alice', []),
      resource: 'tool://finances/x',
      action: 'invoke',
      policies: [
        policy({
          subject: 'user:alice',
          resource: 'tool://finance/*',
          actions: ['invoke'],
          effect: 'allow',
        }),
      ],
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(false);
  });

  it('I3 exact resource (no wildcard) matches exactly', () => {
    const d = authorize({
      claims: userClaims('user:alice', []),
      resource: 'platform://metrics',
      action: 'read',
      policies: [
        policy({
          subject: 'user:alice',
          resource: 'platform://metrics',
          actions: ['read'],
          effect: 'allow',
        }),
      ],
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(true);
  });

  it('I4 exact resource mismatch → deny', () => {
    const d = authorize({
      claims: userClaims('user:alice', []),
      resource: 'platform://audit',
      action: 'read',
      policies: [
        policy({
          subject: 'user:alice',
          resource: 'platform://metrics',
          actions: ['read'],
          effect: 'allow',
        }),
      ],
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(false);
  });

  it('I5 action mismatch (policy allows read, request write) → deny', () => {
    const d = authorize({
      claims: userClaims('user:alice', []),
      resource: 'platform://metrics',
      action: 'write',
      policies: [
        policy({
          subject: 'user:alice',
          resource: 'platform://metrics',
          actions: ['read'],
          effect: 'allow',
        }),
      ],
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(false);
  });

  it('I6 wildcard action ["*"] covers any action', () => {
    const d = authorize({
      claims: userClaims('user:alice', []),
      resource: 'platform://metrics',
      action: 'signal',
      policies: [
        policy({
          subject: 'user:alice',
          resource: 'platform://metrics',
          actions: ['*'],
          effect: 'allow',
        }),
      ],
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(true);
  });

  it('K1 seed admin policy {role:admin,*,[*],allow} → allow anything', () => {
    const d = authorize({
      claims: userClaims('user:root', ['admin']),
      resource: 'platform://policy/Write',
      action: 'manage',
      policies: [
        policy({
          id: 'seed-admin-allow-all',
          subject: 'role:admin',
          resource: '*',
          actions: ['*'],
          effect: 'allow',
        }),
      ],
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(true);
  });
});

// ═══ decision reason chain（为 AuditLog 铺垫）═══════════════════════════

describe('decision reason chain', () => {
  it('deny at step 1 carries a principal reason', () => {
    const d = authorize({
      claims: userClaims('user:alice', []),
      resource: 'tool://x/1',
      action: 'invoke',
      policies: [],
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/principal/i);
  });

  it('deny at step 2 carries a definition reason', () => {
    const d = authorize({
      claims: agentClaims({
        sub: 'user:alice',
        roles: [],
        agent_def: 'finance',
        agent_inst: 'inst-42',
        chain: ['inst-42'],
      }),
      resource: 'tool://hr/x',
      action: 'invoke',
      policies: [policy({ subject: '*', resource: '*', actions: ['*'], effect: 'allow' })],
      agentDefs: {
        finance: def('finance', [{ resources: ['tool://finance/*'], actions: ['invoke'] }]),
      },
      cronJobs: {},
      instances: { 'inst-42': 'finance' },
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/definition|grant/i);
  });

  it('deny at cron segment carries a cron reason', () => {
    const d = authorize({
      claims: agentClaims({
        sub: 'service:scheduler',
        roles: [],
        agent_def: 'worker',
        agent_inst: 'inst-9',
        chain: ['cron:job-1', 'inst-9'],
      }),
      resource: 'platform://metrics',
      action: 'read',
      policies: [policy({ subject: '*', resource: '*', actions: ['*'], effect: 'allow' })],
      agentDefs: { worker: def('worker', [{ resources: ['*'], actions: ['*'] }]) },
      cronJobs: { 'job-1': scriptJob('job-1', false, [{ resources: ['*'], actions: ['*'] }]) },
      instances: { 'inst-9': 'worker' },
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/cron|disabled|deleted/i);
  });

  it('allow carries no deny reason', () => {
    const d = authorize({
      claims: userClaims('user:alice', []),
      resource: 'tool://x/1',
      action: 'invoke',
      policies: [
        policy({
          subject: 'user:alice',
          resource: 'tool://x/*',
          actions: ['invoke'],
          effect: 'allow',
        }),
      ],
      agentDefs: {},
      cronJobs: {},
      instances: {},
    });
    expect(d.allow).toBe(true);
    expect(d.reason).toBeUndefined();
  });
});
