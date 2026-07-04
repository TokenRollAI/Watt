/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, introspectWorkflowInstance } from 'cloudflare:test';
import type { AgentDefinition } from '@watt/core';
import { agentResultEventName } from '@watt/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agent/agent-registry.ts';
import { AgentRuntime, defaultRuntimeDeps } from '../src/agent/agent-runtime.ts';
import { defaultManagerDeps, TaskManager } from '../src/task/task-manager.ts';
import { TaskStore } from '../src/task/task-store.ts';

/**
 * WattTaskWorkflow 集成测试（Proto §8 引擎 / §3.4 Workflows 适配）——真实 env.WATT_TASK（Workflows）
 * + vitest-pool-workers introspectWorkflowInstance（本地 offline，await using dispose 纪律）。
 *
 * DoD §7 集成项覆盖：
 *  - auto-delivery-lite：run → waiting_human（confirm-release checkpoint）→ Signal（真实
 *    TaskManager.signal → env.WATT_TASK.get(taskId).sendEvent）→ 恢复 → done。
 *  - Cancel：run → waiting → Cancel → 实例 terminated + 状态表 cancelled。
 *  - deep-research fan-in：waiting → signal(approve) → 两个 agent-result 事件（introspect mockEvent
 *    模拟 correlation 回送）→ fan-in 汇总 → done。
 *
 * dispose 纪律（§调研 §2/§5）：introspectWorkflowInstance 必须 await using 或显式 dispose，
 *   否则 isolated storage 跨测试泄漏（假绿）。
 */

let seq = 0;
function uniqTask(base: string): string {
  return `test-task-${base}-${seq++}`;
}

/**
 * 轮询 TaskStore 等任务进 waiting_human（引擎在 waitForEvent 处 hibernate）。
 * 注：本地 pool-workers 的 WorkflowInstance.status() 在 waitForEvent hibernate 时仍报 'running'
 *   （引擎侧行为），故不靠 waitForStatus('waiting')；以状态表 waiting_human 为闭环真源
 *   （§8 引擎驱动状态由 TaskStore 落库，是平台对外可查的权威态）。
 */
async function waitForCheckpoint(
  store: TaskStore,
  taskId: string,
  checkpoint: string,
): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const detail = await store.getDetail(taskId);
    if (
      !('code' in detail) &&
      detail.state === 'waiting_human' &&
      detail.pendingCheckpoint?.checkpoint === checkpoint
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`task ${taskId} did not reach waiting_human@${checkpoint}`);
}

const ECHO: AgentDefinition = {
  name: 'echo',
  description: 'echo test agent for task workflow steps',
  runtime: 'light',
  entry: { kind: 'do-class', className: 'AgentInstance' },
  grants: [],
  contextNamespaces: [],
  toolScopes: [],
};

beforeEach(async () => {
  await env.DB_EVENTS.prepare('DELETE FROM tasks').run();
  // Task 模板的 agent step 派发 'echo'——workflow 里 AgentRuntime.spawn 需 registry 有此定义。
  await new AgentRegistry(env.DB_PROVIDERS).write(ECHO);
});

describe('auto-delivery-lite: run → waiting_human → signal → resume → done (DoD §7)', () => {
  it('full HITL chain with explicit taskId', async () => {
    const taskId = uniqTask('adl2');
    const manager = new TaskManager(defaultManagerDeps(env));
    const store = new TaskStore(env.DB_EVENTS);

    await using instance = await introspectWorkflowInstance(env.WATT_TASK, taskId);
    const info = await manager.write(
      { definition: 'auto-delivery-lite', input: { bug: 'x' }, taskId },
      'user:alice',
    );
    if ('code' in info) throw new Error(`write failed: ${info.message}`);

    // R29：locate 改 expect fan-in（接力链留痕）——本地无 consumer 回送，mock locate 结果推进。
    const locateCid = (await instance.waitForStepResult({ name: 'locate' })) as string;
    await instance.modify(async (m) => {
      const type = agentResultEventName(locateCid);
      if (typeof type !== 'string') throw new Error('bad event name');
      await m.mockEvent({ type, payload: { status: 'result', output: { located: true } } });
    });

    // 等实例进 waiting_human（waitForEvent confirm-release，以状态表为真源）。
    await waitForCheckpoint(store, taskId, 'confirm-release');

    // 真实 Signal：TaskManager.signal → env.WATT_TASK.get(taskId).sendEvent(task-signal-confirm-release)。
    const sig = await manager.signal(taskId, {
      checkpoint: 'confirm-release',
      decision: 'approve',
    });
    expect(sig).toBeUndefined(); // 无 conflict/error

    await instance.waitForStatus('complete');
    const output = (await instance.getOutput()) as { released: boolean };
    expect(output.released).toBe(true);
    const done = await store.getInfo(taskId);
    expect(done?.state).toBe('done');

    // R29 判据①：feedback/bugs 条目 status 走完 open→fixed（approve 后为 fixed，版本 >1 证明重写过）。
    const { StructuredContextProvider } = await import('../src/context/providers/structured.ts');
    const bug = await new StructuredContextProvider(env.DB_CONTEXT, 'feedback/bugs').get(taskId);
    if ('code' in bug) throw new Error(`bug entry missing: ${bug.message}`);
    const bugBody = JSON.parse(String(bug.content)) as { status: string };
    expect(bugBody.status).toBe('fixed');
    expect(Number(bug.version)).toBeGreaterThan(1); // open 先写、fixed 后写。
    // 判据②：locate 这一跳有真实 agent.result 留痕（steps 里 locate=done 且带 output）。
    const detail = await store.getDetail(taskId);
    if ('code' in detail) throw new Error('detail not_found');
    const locate = detail.steps.find((st) => st.name === 'locate');
    expect(locate?.state).toBe('done');
    expect(locate?.output).toEqual({ located: true });
  }, 15000);

  it('Signal outside waiting → conflict (DoD §7)', async () => {
    const taskId = uniqTask('adl-conflict');
    const store = new TaskStore(env.DB_EVENTS);
    const manager = new TaskManager(defaultManagerDeps(env));
    // 直接建一个 running 态任务行（不启 Workflow），Signal 应 conflict。
    await store.create({
      taskId,
      definition: 'auto-delivery-lite',
      state: 'running',
      createdBy: 'u',
      now: '2026-07-03T00:00:00.000Z',
    });
    const res = await manager.signal(taskId, {
      checkpoint: 'confirm-release',
      decision: 'approve',
    });
    expect(res && 'code' in res && res.code).toBe('conflict');
  });

  it('Signal with wrong checkpoint → invalid_argument (mismatch guard)', async () => {
    const taskId = uniqTask('adl-mismatch');
    const manager = new TaskManager(defaultManagerDeps(env));
    const store = new TaskStore(env.DB_EVENTS);

    await using instance = await introspectWorkflowInstance(env.WATT_TASK, taskId);
    // locate（expect fan-in）本地无 consumer 回送——直接令其超时以推进到 checkpoint。
    await instance.modify(async (m) => {
      await m.forceEventTimeout({ name: 'await-locate' });
    });
    await manager.write({ definition: 'auto-delivery-lite', input: {}, taskId }, 'user:alice');
    await waitForCheckpoint(store, taskId, 'confirm-release');

    // 传错 checkpoint（任务实际等 confirm-release）→ invalid_argument（不静默 sendEvent 到无 waiter 事件名）。
    const res = await manager.signal(taskId, {
      checkpoint: 'wrong-checkpoint',
      decision: 'approve',
    });
    expect(res && 'code' in res && res.code).toBe('invalid_argument');
    // 任务仍卡 waiting_human（未被误恢复）。
    expect((await store.getInfo(taskId))?.state).toBe('waiting_human');

    // 用正确 checkpoint 收尾（dispose 前让实例正常完成）。
    await manager.signal(taskId, { checkpoint: 'confirm-release', decision: 'approve' });
    await instance.waitForStatus('complete');
  }, 15000);
});

describe('checkpoint timeout: waitForEvent 超时 → catch 落 failed（§3.4 checkpoint 超时语义）', () => {
  it('auto-delivery-lite human checkpoint timeout → task failed (not stuck waiting_human)', async () => {
    const taskId = uniqTask('adl-timeout');
    const manager = new TaskManager(defaultManagerDeps(env));
    const store = new TaskStore(env.DB_EVENTS);

    await using instance = await introspectWorkflowInstance(env.WATT_TASK, taskId);
    // create 前预设：locate 与 release-confirmation 两个 waitForEvent 都立即超时。
    await instance.modify(async (m) => {
      await m.forceEventTimeout({ name: 'await-locate' });
      await m.forceEventTimeout({ name: 'await-release-confirmation' });
    });
    await manager.write({ definition: 'auto-delivery-lite', input: {}, taskId }, 'user:alice');

    // catch 落库 failed 后 return 失败结果 → 实例干净 complete（非 errored）。
    await instance.waitForStatus('complete');
    const info = await store.getInfo(taskId);
    expect(info?.state).toBe('failed');
    // pendingCheckpoint 已清（不卡 waiting_human）。
    const detail = await store.getDetail(taskId);
    if ('code' in detail) throw new Error('detail not_found');
    expect(detail.pendingCheckpoint).toBeUndefined();
  }, 15000);

  it('deep-research human checkpoint timeout → task failed', async () => {
    const taskId = uniqTask('dr-human-timeout');
    const manager = new TaskManager(defaultManagerDeps(env));
    const store = new TaskStore(env.DB_EVENTS);

    await using instance = await introspectWorkflowInstance(env.WATT_TASK, taskId);
    await instance.modify(async (m) => {
      await m.forceEventTimeout({ name: 'await-plan-confirmation' });
    });
    await manager.write({ definition: 'deep-research', input: { topic: 'x' }, taskId }, 'user:bob');

    await instance.waitForStatus('complete');
    expect((await store.getInfo(taskId))?.state).toBe('failed');
  }, 15000);

  it('deep-research fan-in: one agent-result timeout → research step failed, task still done', async () => {
    const taskId = uniqTask('dr-fanin-timeout');
    const manager = new TaskManager(defaultManagerDeps(env));
    const store = new TaskStore(env.DB_EVENTS);

    await using instance = await introspectWorkflowInstance(env.WATT_TASK, taskId);
    // 预设：第一个 fan-in waitForEvent（await-research-0）超时；第二个（await-research-1）正常收结果。
    await instance.modify(async (m) => {
      await m.forceEventTimeout({ name: 'await-research-0' });
    });
    await manager.write({ definition: 'deep-research', input: { topic: 'x' }, taskId }, 'user:bob');

    await waitForCheckpoint(store, taskId, 'confirm-plan');
    await manager.signal(taskId, { checkpoint: 'confirm-plan', decision: 'approve' });

    const cids = (await instance.waitForStepResult({
      name: 'dispatch-research-agents',
    })) as string[];
    expect(cids).toHaveLength(3); // R30：N=3
    // 只回送第 2、3 个 correlation 的结果（第一个走 forceEventTimeout）。
    await instance.modify(async (m) => {
      for (const cid of cids.slice(1)) {
        const type = agentResultEventName(cid);
        if (typeof type !== 'string') throw new Error('bad event name');
        await m.mockEvent({ type, payload: { status: 'result', output: { ok: true } } });
      }
    });

    await instance.waitForStatus('complete');
    // fan-in 未因单个超时中断：整体 done；两个成功结果计入 count。
    const output = (await instance.getOutput()) as { count: number };
    expect(output.count).toBe(2);
    const detail = await store.getDetail(taskId);
    if ('code' in detail) throw new Error('detail not_found');
    expect(detail.state).toBe('done');
    // research-0 记为 failed step（超时），research-1 为 done。
    const r0 = detail.steps.find((s) => s.name === 'research-0');
    const r1 = detail.steps.find((s) => s.name === 'research-1');
    expect(r0?.state).toBe('failed');
    expect(r1?.state).toBe('done');
  }, 15000);
});

describe('Write atomicity: WATT_TASK.create failure compensates the orphan pending row (§8)', () => {
  it('deletes the pending row so a same-taskId retry does not hit conflict', async () => {
    const taskId = uniqTask('write-comp');
    const store = new TaskStore(env.DB_EVENTS);
    // 注入一个 WATT_TASK.create 抛错的 env（其余绑定透传），验证补偿删除。
    const failingEnv = {
      ...env,
      WATT_TASK: {
        create: async () => {
          throw new Error('workflow create boom');
        },
        get: env.WATT_TASK.get.bind(env.WATT_TASK),
      },
    } as unknown as typeof env;
    const manager = new TaskManager({
      env: failingEnv,
      genId: () => crypto.randomUUID(),
      now: () => new Date().toISOString(),
    });

    const res = await manager.write({ definition: 'auto-delivery-lite', input: {}, taskId }, 'u');
    expect(res && 'code' in res && res.code).toBe('internal');
    // 孤儿 pending 行已补偿删除 → 同 taskId 可安全重试（不恒 conflict）。
    expect(await store.getInfo(taskId)).toBeNull();
  });
});

describe('Cancel: run → waiting → cancel → terminated (§8 / §3.4 规则 4)', () => {
  it('terminates the workflow instance and marks the task cancelled', async () => {
    const taskId = uniqTask('cancel');
    const manager = new TaskManager(defaultManagerDeps(env));
    const store = new TaskStore(env.DB_EVENTS);

    await using instance = await introspectWorkflowInstance(env.WATT_TASK, taskId);
    await instance.modify(async (m) => {
      await m.forceEventTimeout({ name: 'await-locate' });
    });
    await manager.write({ definition: 'auto-delivery-lite', input: {}, taskId }, 'user:alice');
    await waitForCheckpoint(store, taskId, 'confirm-release');

    const res = await manager.cancel(taskId, 'no longer needed');
    expect(res).toBeUndefined();
    // Workflow 实例被 terminate（§3.4 规则 4）——引擎侧终态。
    await instance.waitForStatus('terminated');
    const cancelled = await store.getInfo(taskId);
    expect(cancelled?.state).toBe('cancelled');
    expect(cancelled?.note).toContain('no longer needed');
  }, 15000);

  it('cascades terminate to task-derived agent sub-instances (task:<id># prefix)', async () => {
    const taskId = uniqTask('cancel-cascade');
    const manager = new TaskManager(defaultManagerDeps(env));
    const store = new TaskStore(env.DB_EVENTS);
    const runtime = new AgentRuntime(defaultRuntimeDeps(env));

    await using instance = await introspectWorkflowInstance(env.WATT_TASK, taskId);
    await manager.write({ definition: 'deep-research', input: { topic: 'x' }, taskId }, 'user:bob');
    // 进 waiting_human → approve → 派发 N 个 task:<id>#research-* 子实例（进 fan-in waiting）。
    await waitForCheckpoint(store, taskId, 'confirm-plan');
    await manager.signal(taskId, { checkpoint: 'confirm-plan', decision: 'approve' });
    await instance.waitForStepResult({ name: 'dispatch-research-agents' });

    // 子实例已登记（listInstances 全列可见前缀 task:<id>#）。
    const prefix = `task:${taskId}#`;
    const before = (await runtime.listInstances()).items.filter((i) =>
      i.instanceId.startsWith(prefix),
    );
    expect(before.length).toBeGreaterThan(0);

    const res = await manager.cancel(taskId);
    expect(res).toBeUndefined();
    // 级联后：所有 task:<id># 子实例索引 state=terminated（§3.4 规则 4）。
    const after = (await runtime.listInstances()).items.filter((i) =>
      i.instanceId.startsWith(prefix),
    );
    for (const inst of after) expect(inst.state).toBe('terminated');
  }, 15000);

  it('done/failed → conflict; repeat cancel on cancelled → idempotent success (§8 terminal guard)', async () => {
    const store = new TaskStore(env.DB_EVENTS);
    const manager = new TaskManager(defaultManagerDeps(env));
    const now = '2026-07-03T00:00:00.000Z';

    // done → conflict（不覆写终态）。
    const doneId = uniqTask('cancel-done');
    await store.create({
      taskId: doneId,
      definition: 'deep-research',
      state: 'done',
      createdBy: 'u',
      now,
    });
    const doneRes = await manager.cancel(doneId);
    expect(doneRes && 'code' in doneRes && doneRes.code).toBe('conflict');
    expect((await store.getInfo(doneId))?.state).toBe('done');

    // failed → conflict。
    const failedId = uniqTask('cancel-failed');
    await store.create({
      taskId: failedId,
      definition: 'deep-research',
      state: 'failed',
      createdBy: 'u',
      now,
    });
    const failedRes = await manager.cancel(failedId);
    expect(failedRes && 'code' in failedRes && failedRes.code).toBe('conflict');

    // cancelled → 幂等成功（无 error）。
    const cancelledId = uniqTask('cancel-cancelled');
    await store.create({
      taskId: cancelledId,
      definition: 'deep-research',
      state: 'cancelled',
      createdBy: 'u',
      now,
    });
    const idemRes = await manager.cancel(cancelledId);
    expect(idemRes).toBeUndefined();
    expect((await store.getInfo(cancelledId))?.state).toBe('cancelled');
  });
});

describe('deep-research fan-in: waiting → approve → agent results → summarize → done (§3.4 规则 1)', () => {
  it('collects N agent results via merged agent-result events and completes', async () => {
    const taskId = uniqTask('dr');
    const manager = new TaskManager(defaultManagerDeps(env));
    const store = new TaskStore(env.DB_EVENTS);

    await using instance = await introspectWorkflowInstance(env.WATT_TASK, taskId);
    await manager.write({ definition: 'deep-research', input: { topic: 'x' }, taskId }, 'user:bob');

    // 1) 进 waiting_human（confirm-plan）。
    await waitForCheckpoint(store, taskId, 'confirm-plan');

    // 2) approve → 派发 N agent（step.do 内 spawn echo，返 correlationIds）。
    await manager.signal(taskId, { checkpoint: 'confirm-plan', decision: 'approve' });

    // 3) 派发后进入 fan-in 的 waitForEvent（await-research-*）；用 introspect mockEvent 模拟
    //    consumer.routeResult → correlation → sendEvent 的 agent-result 归并事件回送。
    //    correlationIds 由 dispatch step 产出——从 step 结果取。
    const cids = (await instance.waitForStepResult({
      name: 'dispatch-research-agents',
    })) as string[];
    expect(cids).toHaveLength(3); // R30：DOD E2E-2 判据② N=3
    await instance.modify(async (m) => {
      for (const cid of cids) {
        const type = agentResultEventName(cid);
        if (typeof type !== 'string') throw new Error('bad event name');
        await m.mockEvent({ type, payload: { status: 'result', output: { ok: true } } });
      }
    });

    await instance.waitForStatus('complete');
    const output = (await instance.getOutput()) as { count: number };
    expect(output.count).toBe(3);
    expect((await store.getInfo(taskId))?.state).toBe('done');
  }, 15000);
});
