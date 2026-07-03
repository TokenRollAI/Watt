import type { AccessDecision, SchedulerCronJob as CronJob, TokenClaims } from '@watt/core';
import { describe, expect, it } from 'vitest';
import { createSchedulerTools } from '../src/agent/harness/scheduler-tools.ts';
import type { Authorizer } from '../src/authz/authorizer.ts';
import type { SchedulerManager } from '../src/scheduler/scheduler-manager.ts';

/**
 * manage/cron 的 scheduler 工具单测（R25 DoD④）——纯逻辑，fake Manager + Authorizer + claims。
 *
 * 断言协议事实（§6.4d PEP + §7 CronJob）：
 *  - scheduler_write：过 Check(manage) → 调 Manager.write，createdBy=claims.sub 注入、id 自动生成、
 *    enabled 缺省 true；schema 非法 → 错误对象（回喂模型）；WattError → 错误对象。
 *  - scheduler_list：过 Check(read) → 调 Manager.list。
 *  - deny → 错误对象（不抛异常，不调 Manager）。
 */

const CLAIMS: TokenClaims = { sub: 'user:admin', roles: ['admin'] };

/** fake Authorizer：按 (resource, action) 决定 allow/deny，记录调用。 */
function fakeAuthorizer(allow: boolean): {
  authorizer: Authorizer;
  calls: { resource: string; action: string }[];
} {
  const calls: { resource: string; action: string }[] = [];
  const authorizer = {
    async check(_claims: TokenClaims, resource: string, action: string): Promise<AccessDecision> {
      calls.push({ resource, action });
      return allow ? { allow: true } : { allow: false, reason: 'no policy' };
    },
  } as unknown as Authorizer;
  return { authorizer, calls };
}

/** fake SchedulerManager：记录 write/list 调用，write 恒返回入参 job。 */
function fakeManager(): {
  manager: SchedulerManager;
  writes: CronJob[];
  lists: ({ limit?: number } | undefined)[];
} {
  const writes: CronJob[] = [];
  const lists: ({ limit?: number } | undefined)[] = [];
  const manager = {
    async write(job: CronJob): Promise<CronJob> {
      writes.push(job);
      return job;
    },
    async list(opts: { limit?: number } = {}): Promise<{ items: CronJob[] }> {
      lists.push(opts);
      return { items: writes };
    },
  } as unknown as SchedulerManager;
  return { manager, writes, lists };
}

describe('scheduler tools — scheduler_write (§7 / §6.4d)', () => {
  it('checks manage then writes with createdBy from claims + generated id + enabled default', async () => {
    const { authorizer, calls } = fakeAuthorizer(true);
    const { manager, writes } = fakeManager();
    const tools = createSchedulerTools({
      authorizer,
      manager,
      claims: CLAIMS,
      genId: () => 'job-fixed',
    });
    const write = tools.find((t) => t.name === 'scheduler_write');
    expect(write).toBeDefined();

    const result = (await write?.execute({
      description: 'daily token report',
      schedule: '0 9 * * *',
      action: { kind: 'publish', event: { type: 'report.daily.tokens' } },
    })) as { job?: CronJob };

    // Check(platform://scheduler, manage) 先行。
    expect(calls).toEqual([{ resource: 'platform://scheduler', action: 'manage' }]);
    // Manager.write 收到 createdBy=claims.sub、id 自动生成、enabled 缺省 true。
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      id: 'job-fixed',
      schedule: '0 9 * * *',
      enabled: true,
      createdBy: 'user:admin',
      action: { kind: 'publish', event: { type: 'report.daily.tokens' } },
    });
    expect(result.job?.id).toBe('job-fixed');
  });

  it('honors explicit id and enabled=false', async () => {
    const { authorizer } = fakeAuthorizer(true);
    const { manager, writes } = fakeManager();
    const tools = createSchedulerTools({ authorizer, manager, claims: CLAIMS });
    const write = tools.find((t) => t.name === 'scheduler_write');
    await write?.execute({
      id: 'my-job',
      description: 'x',
      schedule: '* * * * *',
      enabled: false,
      action: { kind: 'publish', event: { type: 'e' } },
    });
    expect(writes[0]).toMatchObject({ id: 'my-job', enabled: false });
  });

  it('invalid job → error object (fed back to model), does not call Manager', async () => {
    const { authorizer } = fakeAuthorizer(true);
    const { manager, writes } = fakeManager();
    const tools = createSchedulerTools({ authorizer, manager, claims: CLAIMS });
    const write = tools.find((t) => t.name === 'scheduler_write');
    // 缺 action → cronJobSchema 校验失败。
    const result = (await write?.execute({ description: 'x', schedule: '* * * * *' })) as {
      error?: string;
    };
    expect(result.error).toContain('invalid cron job');
    expect(writes).toHaveLength(0);
  });

  it('deny → error object, does not call Manager', async () => {
    const { authorizer, calls } = fakeAuthorizer(false);
    const { manager, writes } = fakeManager();
    const tools = createSchedulerTools({ authorizer, manager, claims: CLAIMS });
    const write = tools.find((t) => t.name === 'scheduler_write');
    const result = (await write?.execute({
      description: 'x',
      schedule: '0 9 * * *',
      action: { kind: 'publish', event: { type: 'e' } },
    })) as { error?: string };
    expect(calls).toEqual([{ resource: 'platform://scheduler', action: 'manage' }]);
    expect(result.error).toContain('permission denied');
    expect(writes).toHaveLength(0);
  });
});

describe('scheduler tools — scheduler_list (§7 / §6.4d)', () => {
  it('checks read then lists', async () => {
    const { authorizer, calls } = fakeAuthorizer(true);
    const { manager, lists } = fakeManager();
    const tools = createSchedulerTools({ authorizer, manager, claims: CLAIMS });
    const list = tools.find((t) => t.name === 'scheduler_list');
    const result = (await list?.execute({ limit: 10 })) as { items?: CronJob[] };
    expect(calls).toEqual([{ resource: 'platform://scheduler', action: 'read' }]);
    expect(lists).toEqual([{ limit: 10 }]);
    expect(Array.isArray(result.items)).toBe(true);
  });

  it('deny → error object, does not list', async () => {
    const { authorizer } = fakeAuthorizer(false);
    const { manager, lists } = fakeManager();
    const tools = createSchedulerTools({ authorizer, manager, claims: CLAIMS });
    const list = tools.find((t) => t.name === 'scheduler_list');
    const result = (await list?.execute({})) as { error?: string };
    expect(result.error).toContain('permission denied');
    expect(lists).toHaveLength(0);
  });
});
