/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import type { SchedulerCronJob } from '@watt/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../src/env.ts';
import { EventStore } from '../src/event/event-store.ts';
import { executeCronAction } from '../src/scheduler/actions.ts';
import type { ScriptRunContext, ScriptRunner } from '../src/scheduler/script-runner.ts';

/**
 * executeCronAction（§7 三 action + 双留痕）直测——action 抛错分支与 cron.completed best-effort 留痕。
 * 覆盖：
 *  - action 抛纯对象 WattError（跨 RPC 形态）→ cron.completed ok:false + error 取 WattError.message
 *    （非 [object Object]，锁定 actions.ts 的 typeof object 提取分支）；
 *  - action 抛 Error 实例 → error 取 Error.message；
 *  - cron.completed 留痕（EventStore.put）抛错 → executeCronAction 不抛（best-effort，不重放已执行 action）。
 */

const bindings = env as unknown as Bindings;

const SCRIPT_JOB = (id: string, over: Partial<SchedulerCronJob> = {}): SchedulerCronJob => ({
  id,
  description: 'test',
  schedule: '*/5 * * * *',
  enabled: true,
  action: {
    kind: 'script',
    scriptRef: 'context://automations/s1',
    grants: [{ resources: ['platform://event'], actions: ['manage'] }],
  },
  createdBy: env.WATT_ADMIN_PRINCIPAL,
  ...over,
});

async function seedScript(): Promise<void> {
  const registry = env.CONTEXT_REGISTRY.get(env.CONTEXT_REGISTRY.idFromName('registry'));
  await registry.write({ namespace: 'automations', provider: 'structured' });
  const { StructuredContextProvider } = await import('../src/context/providers/structured.ts');
  await new StructuredContextProvider(env.DB_CONTEXT, 'automations').write('s1', {
    content: 'export default { async run() { return { ok: true }; } };',
    contentType: 'text/javascript',
  });
}

beforeEach(async () => {
  await env.DB_EVENTS.prepare('DELETE FROM events').run();
  await env.DB_CONTEXT.prepare('DELETE FROM entries').run();
  await seedScript();
});

describe('executeCronAction — action 抛错分支 (§7 步骤 4)', () => {
  it('action 抛纯对象 WattError → completed ok:false, error 取 message（非 [object Object]）', async () => {
    // fake runner 抛纯对象（跨 RPC 边界的 WattError 非 Error 实例）——锁定 typeof object 提取分支。
    const runner: ScriptRunner = {
      async run(_ctx: ScriptRunContext) {
        throw { code: 'internal', message: 'script blew up', retryable: false };
      },
    };
    const res = await executeCronAction({
      env: bindings,
      job: SCRIPT_JOB('a-obj'),
      trigger: 'manual',
      scriptRunner: runner,
    });
    expect('code' in res).toBe(false);

    const store = new EventStore(env.DB_EVENTS);
    const completed = (await store.list({ filter: { type: 'cron.completed' } })) as {
      items: { payload: { ok: boolean; error: string } }[];
    };
    const rec = completed.items.find((e) => e.payload.ok === false);
    expect(rec).toBeDefined();
    expect(rec?.payload.error).toBe('script blew up');
    expect(rec?.payload.error).not.toBe('[object Object]');
  });

  it('action 抛 Error 实例 → completed ok:false, error 取 Error.message', async () => {
    const runner: ScriptRunner = {
      async run(_ctx: ScriptRunContext) {
        throw new Error('boom from runner');
      },
    };
    await executeCronAction({
      env: bindings,
      job: SCRIPT_JOB('a-err'),
      trigger: 'manual',
      scriptRunner: runner,
    });
    const store = new EventStore(env.DB_EVENTS);
    const completed = (await store.list({ filter: { type: 'cron.completed' } })) as {
      items: { payload: { ok: boolean; error: string } }[];
    };
    const rec = completed.items.find((e) => e.payload.ok === false);
    expect(rec?.payload.error).toBe('boom from runner');
  });
});

describe('executeCronAction — cron.completed 留痕 best-effort (§7 步骤 4)', () => {
  it('cron.completed EventStore.put 抛错 → executeCronAction 不抛（不重放已执行 action）', async () => {
    // fired 的 put 是第 1 次调用（放行），completed 的 put 是第 2 次（抛错）。
    const original = EventStore.prototype.put;
    let putCalls = 0;
    const spy = vi.spyOn(EventStore.prototype, 'put').mockImplementation(async function (
      this: EventStore,
      event,
    ) {
      putCalls += 1;
      if (putCalls >= 2) throw new Error('D1 write failed');
      return original.call(this, event); // 第 1 次（fired）走真实 put。
    });

    try {
      const runner: ScriptRunner = {
        async run() {
          return { ok: true };
        },
      };
      // 不应抛：completed 留痕失败被 catch，返回 fired 的 eventId。
      const res = await executeCronAction({
        env: bindings,
        job: SCRIPT_JOB('a-completed-fail'),
        trigger: 'manual',
        scriptRunner: runner,
      });
      expect('code' in res).toBe(false);
      expect(typeof (res as { eventId: string }).eventId).toBe('string');
      expect(putCalls).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
  });
});
