/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, introspectWorkflowInstance } from 'cloudflare:test';
import type { AgentDefinition } from '@watt/core';
import { agentResultEventName } from '@watt/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agent/agent-registry.ts';
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
});

describe('Cancel: run → waiting → cancel → terminated (§8 / §3.4 规则 4)', () => {
  it('terminates the workflow instance and marks the task cancelled', async () => {
    const taskId = uniqTask('cancel');
    const manager = new TaskManager(defaultManagerDeps(env));
    const store = new TaskStore(env.DB_EVENTS);

    await using instance = await introspectWorkflowInstance(env.WATT_TASK, taskId);
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
    expect(cids).toHaveLength(2);
    await instance.modify(async (m) => {
      for (const cid of cids) {
        const type = agentResultEventName(cid);
        if (typeof type !== 'string') throw new Error('bad event name');
        await m.mockEvent({ type, payload: { status: 'result', output: { ok: true } } });
      }
    });

    await instance.waitForStatus('complete');
    const output = (await instance.getOutput()) as { count: number };
    expect(output.count).toBe(2);
    expect((await store.getInfo(taskId))?.state).toBe('done');
  }, 15000);
});
