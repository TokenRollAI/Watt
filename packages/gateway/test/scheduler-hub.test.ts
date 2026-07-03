/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from 'cloudflare:test';
import type { AgentDefinition, SchedulerCronJob } from '@watt/core';
import { getAgentByName } from 'agents';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agent/agent-registry.ts';
import { EventStore } from '../src/event/event-store.ts';
import type { SchedulerHub } from '../src/scheduler/scheduler-hub.ts';
import type { ScriptRunContext, ScriptRunner } from '../src/scheduler/script-runner.ts';

/**
 * SchedulerHub（§7 / M6）DO 集成测试（真实 workerd Agents SDK Agent + this.schedule）。
 * 覆盖：Write/Update/Delete/List/Get（schedule 登记与取消：listSchedules 断言）；Trigger 全链
 *   （fired → action → completed）——publish 断言事件、agent 用 echo 定义、script 用注入 fake runner；
 *   非法 cron 表达式 invalid_argument；disabled job 的 schedule 登记与 Trigger 行为。
 *
 * 每个用例用唯一 idFromName 取独立 Hub 实例（DO storage 跨用例持久，避免串扰）；平台走单例 'hub'，
 *   此处测内部逻辑故用唯一名。fake ScriptRunner 经 runInDurableObject 设 instance.scriptRunner。
 */

let counter = 0;
function hubName(): string {
  return `hub-test-${counter++}`;
}

const ECHO: AgentDefinition = {
  name: 'echo',
  description: 'echo test agent',
  runtime: 'light',
  entry: { kind: 'do-class', className: 'AgentInstance' },
  grants: [],
  contextNamespaces: [],
  toolScopes: [],
};

const PUBLISH_JOB = (id: string, over: Partial<SchedulerCronJob> = {}): SchedulerCronJob => ({
  id,
  description: 'test',
  schedule: '*/5 * * * *',
  enabled: true,
  action: { kind: 'publish', event: { type: 'nightly.tick', payload: { n: 1 } } },
  createdBy: 'user:alice',
  ...over,
});

beforeEach(async () => {
  await env.DB_EVENTS.prepare('DELETE FROM events').run();
  await env.DB_PROVIDERS.prepare('DELETE FROM agent_definitions').run();
  await env.DB_CONTEXT.prepare('DELETE FROM entries').run();
  await new AgentRegistry(env.DB_PROVIDERS).write(ECHO);
});

async function hub(name: string) {
  // getAgentByName 返回 DO stub；runInDurableObject 拿真实 instance（可设 scriptRunner / 调可测面）。
  return getAgentByName<Cloudflare.Env, SchedulerHub>(env.SCHEDULER_HUB, name);
}

describe('SchedulerHub — Write / List / Get / schedule 登记 (§7)', () => {
  it('Write registers a cron schedule and stores the job', async () => {
    const stub = await hub(hubName());
    const job = PUBLISH_JOB('c-1');
    const written = await runInDurableObject(stub, (h: SchedulerHub) => h.writeJob(job));
    expect('code' in written).toBe(false);

    const got = await runInDurableObject(stub, (h: SchedulerHub) => h.getJob('c-1'));
    expect('code' in got).toBe(false);
    expect((got as SchedulerCronJob).id).toBe('c-1');

    // schedule 登记：listSchedules 应含一个 cron 型（Agents SDK 到点表可测）。
    const schedules = await runInDurableObject(stub, (h: SchedulerHub) => h.listSchedules());
    expect(schedules.length).toBe(1);
    expect(schedules[0]?.type).toBe('cron');
  });

  it('disabled job stores but does NOT register a schedule', async () => {
    const stub = await hub(hubName());
    await runInDurableObject(stub, (h: SchedulerHub) =>
      h.writeJob(PUBLISH_JOB('c-off', { enabled: false })),
    );
    const schedules = await runInDurableObject(stub, (h: SchedulerHub) => h.listSchedules());
    expect(schedules.length).toBe(0);
  });

  it('invalid cron expression → invalid_argument (not stored)', async () => {
    const stub = await hub(hubName());
    const res = await runInDurableObject(stub, (h: SchedulerHub) =>
      h.writeJob(PUBLISH_JOB('c-bad', { schedule: '99 99 99 99 99' })),
    );
    expect('code' in res && (res as { code: string }).code).toBe('invalid_argument');
    const got = await runInDurableObject(stub, (h: SchedulerHub) => h.getJob('c-bad'));
    expect('code' in got && (got as { code: string }).code).toBe('not_found');
  });

  it('List returns all stored jobs', async () => {
    const stub = await hub(hubName());
    await runInDurableObject(stub, (h: SchedulerHub) => h.writeJob(PUBLISH_JOB('c-a')));
    await runInDurableObject(stub, (h: SchedulerHub) => h.writeJob(PUBLISH_JOB('c-b')));
    const page = await runInDurableObject(stub, (h: SchedulerHub) => h.listJobs());
    expect(page.items.map((j) => j.id).sort()).toEqual(['c-a', 'c-b']);
  });
});

describe('SchedulerHub — Update / Delete (schedule 重排/取消) (§7)', () => {
  it('Update enabled=false cancels the schedule', async () => {
    const stub = await hub(hubName());
    await runInDurableObject(stub, (h: SchedulerHub) => h.writeJob(PUBLISH_JOB('c-u')));
    let schedules = await runInDurableObject(stub, (h: SchedulerHub) => h.listSchedules());
    expect(schedules.length).toBe(1);

    await runInDurableObject(stub, (h: SchedulerHub) => h.updateJob('c-u', { enabled: false }));
    schedules = await runInDurableObject(stub, (h: SchedulerHub) => h.listSchedules());
    expect(schedules.length).toBe(0);
    const got = (await runInDurableObject(stub, (h: SchedulerHub) =>
      h.getJob('c-u'),
    )) as SchedulerCronJob;
    expect(got.enabled).toBe(false);
  });

  it('Update on unknown job → not_found', async () => {
    const stub = await hub(hubName());
    const res = await runInDurableObject(stub, (h: SchedulerHub) =>
      h.updateJob('nope', { description: 'x' }),
    );
    expect('code' in res && (res as { code: string }).code).toBe('not_found');
  });

  it('Delete removes job and cancels its schedule', async () => {
    const stub = await hub(hubName());
    await runInDurableObject(stub, (h: SchedulerHub) => h.writeJob(PUBLISH_JOB('c-d')));
    await runInDurableObject(stub, (h: SchedulerHub) => h.deleteJob('c-d'));
    const schedules = await runInDurableObject(stub, (h: SchedulerHub) => h.listSchedules());
    expect(schedules.length).toBe(0);
    const got = await runInDurableObject(stub, (h: SchedulerHub) => h.getJob('c-d'));
    expect('code' in got && (got as { code: string }).code).toBe('not_found');
  });
});

describe('SchedulerHub — Trigger full chain (fired → action → completed) (§7)', () => {
  it('publish action: fired + published event + completed all traced', async () => {
    const stub = await hub(hubName());
    await runInDurableObject(stub, (h: SchedulerHub) => h.writeJob(PUBLISH_JOB('t-pub')));
    const res = await runInDurableObject(stub, (h: SchedulerHub) => h.triggerJob('t-pub'));
    expect('code' in res).toBe(false);
    const eventId = (res as { eventId: string }).eventId;

    const store = new EventStore(env.DB_EVENTS);
    const fired = await store.get(eventId);
    expect('code' in fired).toBe(false);
    expect((fired as { type: string }).type).toBe('cron.fired');

    const completed = await store.list({ filter: { type: 'cron.completed' } });
    expect('code' in completed).toBe(false);
    expect((completed as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(1);

    // publish action 产出的目标事件（nightly.tick）也留痕。
    const published = await store.list({ filter: { type: 'nightly.tick' } });
    expect((published as { items: unknown[] }).items.length).toBe(1);
  });

  it('agent action: spawns the echo agent (completed ok)', async () => {
    const stub = await hub(hubName());
    const job = PUBLISH_JOB('t-agent', {
      action: { kind: 'agent', definition: 'echo', input: { hi: 1 } },
    });
    await runInDurableObject(stub, (h: SchedulerHub) => h.writeJob(job));
    const res = await runInDurableObject(stub, (h: SchedulerHub) => h.triggerJob('t-agent'));
    expect('code' in res).toBe(false);

    const store = new EventStore(env.DB_EVENTS);
    const completed = (await store.list({ filter: { type: 'cron.completed' } })) as {
      items: { payload: { ok: boolean; actionKind: string } }[];
    };
    const rec = completed.items.find((e) => e.payload.actionKind === 'agent');
    expect(rec?.payload.ok).toBe(true);
  });

  it('script action: injected fake runner runs and can publish via watt binding', async () => {
    const stub = await hub(hubName());
    // fake runner：调用 ctx.watt.publish（经 Authorizer.Check cron 链段）——admin createdBy 有 grant。
    const captured: { ran: boolean; eventId?: string } = { ran: false };
    const fakeRunner: ScriptRunner = {
      async run(ctx: ScriptRunContext) {
        captured.ran = true;
        const r = await ctx.watt.publish({ type: 'script.out', payload: { ok: true } });
        captured.eventId = r.eventId;
        return { done: true };
      },
    };
    // createdBy=admin（seed 授予 platform://* manage），script grants 覆盖 platform://event manage。
    const job = PUBLISH_JOB('t-script', {
      createdBy: env.WATT_ADMIN_PRINCIPAL,
      action: {
        kind: 'script',
        scriptRef: 'context://automations/s1',
        grants: [{ resources: ['platform://event'], actions: ['manage'] }],
      },
    });
    await runInDurableObject(stub, (h: SchedulerHub) => {
      h.scriptRunner = fakeRunner;
      return h.writeJob(job);
    });
    // 脚本内容存 context://automations/s1（§7 步骤 1）：mount structured + 直接写 provider（测试便利）。
    const registry = env.CONTEXT_REGISTRY.get(env.CONTEXT_REGISTRY.idFromName('registry'));
    await registry.write({ namespace: 'automations', provider: 'structured' });
    const { StructuredContextProvider } = await import('../src/context/providers/structured.ts');
    await new StructuredContextProvider(env.DB_CONTEXT, 'automations').write('s1', {
      content: 'export default { async run() { return { ok: true }; } };',
      contentType: 'text/javascript',
    });
    // seed admin policy：script publish 的 Authorizer.Check 需 admin 有 platform://event manage（种子已授）。
    const { PolicyStore } = await import('../src/authz/policy-store.ts');
    const { IdentityMapper } = await import('../src/authz/identity-mapper.ts');
    const { ensureSeedPolicy } = await import('../src/authz/seed.ts');
    await ensureSeedPolicy(
      new PolicyStore(env.DB_POLICIES),
      new IdentityMapper(env.DB_POLICIES),
      env.WATT_ADMIN_PRINCIPAL,
    );

    const res = await runInDurableObject(stub, (h: SchedulerHub) => {
      h.scriptRunner = fakeRunner;
      return h.triggerJob('t-script');
    });
    expect('code' in res).toBe(false);
    expect(captured.ran).toBe(true);
    expect(typeof captured.eventId).toBe('string');

    const store = new EventStore(env.DB_EVENTS);
    const completed = (await store.list({ filter: { type: 'cron.completed' } })) as {
      items: { payload: { ok: boolean; actionKind: string } }[];
    };
    const rec = completed.items.find((e) => e.payload.actionKind === 'script');
    expect(rec?.payload.ok).toBe(true);
    const scriptOut = (await store.list({ filter: { type: 'script.out' } })) as {
      items: unknown[];
    };
    expect(scriptOut.items.length).toBe(1);
  });

  it('Trigger works on a disabled job (manual backfill, enabled unrelated)', async () => {
    const stub = await hub(hubName());
    await runInDurableObject(stub, (h: SchedulerHub) =>
      h.writeJob(PUBLISH_JOB('t-off', { enabled: false })),
    );
    const res = await runInDurableObject(stub, (h: SchedulerHub) => h.triggerJob('t-off'));
    expect('code' in res).toBe(false); // disabled 仍可手动 Trigger（补跑语义）。
  });

  it('Trigger on unknown job → not_found', async () => {
    const stub = await hub(hubName());
    const res = await runInDurableObject(stub, (h: SchedulerHub) => h.triggerJob('ghost'));
    expect('code' in res && (res as { code: string }).code).toBe('not_found');
  });
});
