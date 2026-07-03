/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from 'cloudflare:test';
import type { Event, TokenClaims } from '@watt/core';
import { getAgentByName } from 'agents';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentInstance } from '../src/agent/agent-instance.ts';
import type { ModelCaller, ModelCallRequest } from '../src/agent/harness/types.ts';
import { PolicyStore } from '../src/authz/policy-store.ts';
import { SEED_POLICY } from '../src/authz/seed.ts';
import type { Bindings } from '../src/env.ts';
import { SchedulerManager } from '../src/scheduler/scheduler-manager.ts';

/**
 * DoD④ 端到端（本地 fake 模型）：manage/cron Agent 对话 → 工具循环 → 真实 SchedulerManager.write →
 *   真实 SchedulerHub → `watt cron list`（此处 SchedulerManager.list）见正确 CronJob。
 *
 * 用 runInDurableObject 拿真实 AgentInstance，注入 fake ModelCaller 驱动工具循环（真实 agentic loop
 *   在 anthropic-caller，本测试不触网络；真实模型验证留 @llm）。断言协议事实（CronJob 落库 + createdBy
 *   委托链 + schedule 正确），不断言 LLM 文本（§7 E2E 约定）。
 *
 * 授权链：seed policy（role:admin → *）预写 → admin claims 过 Authorizer.Check(platform://scheduler,
 *   manage) allow → 建 job 成功。委托链：CronJob.createdBy = claims.sub（agent 替 admin 操作）。
 */

const bindings = env as unknown as Bindings;
const ADMIN_CLAIMS: TokenClaims = { sub: 'user:admin', roles: ['admin'] };

/** fake caller：模拟 SDK agentic loop——见 req.tools 就调 scheduler_write 建 9 点 token 日报 job，返回确认文本。 */
function cronToolCaller(jobId: string): ModelCaller {
  return {
    async call(req: ModelCallRequest) {
      const write = req.tools?.find((t) => t.name === 'scheduler_write');
      if (write !== undefined) {
        await write.execute({
          id: jobId,
          description: '每天 UTC 09:00 发送 token 日报到测试群',
          schedule: '0 9 * * *',
          action: {
            kind: 'publish',
            event: { type: 'report.daily.tokens', payload: { target: 'oc_test' } },
          },
        });
      }
      return { text: '已创建每天 UTC 09:00 的 token 日报定时任务。' };
    },
  };
}

function triggerEvent(): Event {
  return {
    id: 'evt-manage-1',
    source: { kind: 'im', channel: 'feishu' },
    type: 'im.message',
    payload: { text: '每天9点发token日报到测试群 oc_test' },
    occurredAt: '2026-07-03T00:00:00.000Z',
    traceId: 'tr-manage-1',
  };
}

beforeEach(async () => {
  // seed policy（role:admin → *）——Authorizer.Check 依赖它 allow admin。
  await new PolicyStore(bindings.DB_POLICIES).write(SEED_POLICY);
});

describe('DoD④ manage/cron → CronJob (local fake model)', () => {
  it('agent tool loop creates a cron job via real SchedulerManager, visible in list', async () => {
    const instanceKey = 'manage/cron#dod4';
    const jobId = 'manage-cron-dod4-job';
    const stub = await getAgentByName<Cloudflare.Env, AgentInstance>(
      bindings.AGENT_INSTANCE,
      instanceKey,
    );

    // init 为 manage/cron（llm harness + model）——与 AgentRuntime.spawn 的 harnessOf 一致。
    await runInDurableObject(stub, (inst: AgentInstance) =>
      inst.initInstance({
        definition: 'manage/cron',
        harness: 'llm',
        model: 'glm-5.2',
        input: '每天9点发token日报到测试群 oc_test',
        nowIso: '2026-07-03T00:00:00.000Z',
      }),
    );

    // onEvent 注入 fake caller + admin claims（委托链）——驱动工具循环建 job。
    const res = await runInDurableObject(stub, (inst: AgentInstance) =>
      inst.onEvent(
        { event: triggerEvent(), correlationId: 'cid-dod4', claims: ADMIN_CLAIMS },
        cronToolCaller(jobId),
      ),
    );
    expect(res.accepted).toBe(true);

    // `watt cron list` 等价面：SchedulerManager.list 见到该 job，字段正确（协议事实）。
    const page = await new SchedulerManager(bindings).list({ limit: 200 });
    const job = page.items.find((j) => j.id === jobId);
    expect(job).toBeDefined();
    expect(job).toMatchObject({
      id: jobId,
      schedule: '0 9 * * *',
      enabled: true,
      createdBy: 'user:admin', // 委托链：createdBy = claims.sub（防伪造）。
      action: {
        kind: 'publish',
        event: { type: 'report.daily.tokens' },
      },
    });
  });

  it('without admin policy → tool denied, no job created', async () => {
    // 覆盖 seed policy 为 deny-all（清掉 admin allow）：用未授权 claims。
    const instanceKey = 'manage/cron#dod4-deny';
    const jobId = 'manage-cron-deny-job';
    const stub = await getAgentByName<Cloudflare.Env, AgentInstance>(
      bindings.AGENT_INSTANCE,
      instanceKey,
    );
    await runInDurableObject(stub, (inst: AgentInstance) =>
      inst.initInstance({
        definition: 'manage/cron',
        harness: 'llm',
        model: 'glm-5.2',
        nowIso: '2026-07-03T00:00:00.000Z',
      }),
    );
    // 非 admin claims（无策略命中 → deny）。
    const staffClaims: TokenClaims = { sub: 'user:staff', roles: ['staff'] };
    await runInDurableObject(stub, (inst: AgentInstance) =>
      inst.onEvent(
        { event: triggerEvent(), correlationId: 'cid-deny', claims: staffClaims },
        cronToolCaller(jobId),
      ),
    );
    const page = await new SchedulerManager(bindings).list({ limit: 200 });
    expect(page.items.find((j) => j.id === jobId)).toBeUndefined();
  });
});
