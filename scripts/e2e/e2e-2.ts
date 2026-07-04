/**
 * scripts/e2e/e2e-2.ts — E2E-2 Deep research（Case 2，DOD §9）。
 *
 * 判据：① Task 经历 waiting_human→running→done；② agent tree 显示 3 个子实例且结束后回收
 *   （terminate cascade 后 terminated）；③ 3 个 agent.result 均通过 schema 校验（expect.schema
 *   由模板声明——结果能回送本身就证明过了校验，invalid_output 不会以 result 回送）；④ 汇总消息
 *   送达通知渠道（@feishu 开 → 飞书群人工核对；未开 → outbound.message 事件留痕断言）。
 *
 * 运行：WATT_TOKEN=<admin> [E2E_FEISHU=1 E2E_FEISHU_TEST_CHAT_ID=<chat>] node scripts/e2e/e2e-2.ts
 */

import { assert, cli, loadEnv, runE2e, stepLog, waitFor } from './lib.ts';

interface TaskDetail {
  taskId: string;
  state: string;
  steps: { name: string; state: string; output?: unknown }[];
  pendingCheckpoint?: { checkpoint: string };
}
interface AgentInstanceRow {
  instanceId: string;
  state: string;
}
interface EventRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

await runE2e('e2e-2', async () => {
  const env = loadEnv();
  const log = stepLog('e2e-2');
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const taskId = `e2e2-${Date.now().toString(36)}`;

  const notify =
    env.feishuEnabled && env.testChatId !== undefined
      ? { channel: 'feishu-main', target: env.testChatId }
      : undefined;
  const input: Record<string, unknown> = { topic: 'edge serverless platforms' };
  if (notify !== undefined) input.notify = notify;
  cli(env, ['task', 'run', 'deep-research', '--task-id', taskId, '--input', JSON.stringify(input)]);

  // ① waiting_human@confirm-plan。
  await waitFor(`task ${taskId} waiting_human@confirm-plan`, () => {
    const info = cli<TaskDetail>(env, ['task', 'get', taskId]);
    return info.state === 'waiting_human' && info.pendingCheckpoint?.checkpoint === 'confirm-plan'
      ? info
      : undefined;
  });
  log.pass('① task reached waiting_human@confirm-plan');

  // approve → running → done（真实 3 agent fan-in 经线上 consumer 回送）。
  cli(env, ['task', 'signal', taskId, '--checkpoint', 'confirm-plan', '--decision', 'approve']);
  const done = await waitFor(
    `task ${taskId} done (3-agent fan-in via live consumer)`,
    () => {
      const info = cli<TaskDetail>(env, ['task', 'get', taskId]);
      return info.state === 'done' ? info : undefined;
    },
    { retries: 40, intervalMs: 3000 },
  );
  log.pass('① waiting_human→running→done');

  // ② 3 个子实例在 tree 可见（task:<id>#research-{0,1,2}）。
  const tree = cli<AgentInstanceRow[]>(env, ['agent', 'tree']);
  const children = tree.filter((i) => i.instanceId.startsWith(`task:${taskId}#research-`));
  assert(children.length === 3, `expected 3 research sub-instances, got ${children.length}`);
  log.pass('② agent tree shows 3 research sub-instances');

  // ③ 3 个 research step 都 done（agent.result 通过 expect.schema 校验后才会以 result 回送——
  //    invalid_output 会走 agent.failed → step failed）。
  const steps = done.steps.filter((s) => s.name.startsWith('research-'));
  assert(steps.length === 3, `expected 3 research steps, got ${steps.length}`);
  assert(
    steps.every((s) => s.state === 'done'),
    `all research steps should be done: ${JSON.stringify(steps.map((s) => [s.name, s.state]))}`,
  );
  log.pass('③ 3 agent.results passed schema validation (steps all done)');

  // ④ 汇总出站留痕。
  const summary = await waitFor('summary outbound.message', () => {
    const rows = cli<EventRow[]>(env, ['event', 'tail', '--once', '--since', startedAt]);
    const list = Array.isArray(rows) ? rows : [];
    return list.find(
      (e) =>
        e.type === 'outbound.message' &&
        String((e.payload.content as { text?: string } | undefined)?.text ?? '').includes(taskId),
    );
  });
  const text = String((summary.payload.content as { text?: string }).text);
  assert(text.includes('3/3'), `summary should report 3/3 sub-reports, got: ${text}`);
  if (env.feishuEnabled) {
    log.pass('④ summary delivered to feishu-main（群内可见留人工核对）', text);
  } else {
    log.pass('④ summary outbound.message published (protocol proxy)', text);
  }

  // ② 后半：回收——terminate cascade 子实例（结束后回收语义：模板不自动回收，验收动作清理）。
  for (const child of children) {
    cli(env, ['agent', 'terminate', child.instanceId]);
  }
  const after = cli<AgentInstanceRow[]>(env, ['agent', 'tree']);
  const remaining = after.filter(
    (i) => i.instanceId.startsWith(`task:${taskId}#research-`) && i.state !== 'terminated',
  );
  assert(remaining.length === 0, 'research sub-instances should be terminated after the run');
  log.pass('② sub-instances recycled (terminated)');
});
