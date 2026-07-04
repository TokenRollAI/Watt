/**
 * scripts/e2e/e2e-1.ts — E2E-1 自动交付 lite（Case 1，DOD §9）。
 *
 * 判据：① feedback/bugs 新条目 status open→fixed；② 接力链每跳有 agent.result 留痕（locate step
 *   done + output）；③ checkpoint 卡片真实出现测试群、点击后恢复（@feishu 门控——未开时协议降级：
 *   outbound.message 卡片事件留痕断言 + `watt task signal` 恢复，DOD 认可 CLI=人类确认路径）；
 *   ④ 全链 AuditLog 可回放。
 *
 * 运行：WATT_TOKEN=<admin> [E2E_FEISHU=1 E2E_FEISHU_TEST_CHAT_ID=<chat>] node scripts/e2e/e2e-1.ts
 */

import { assert, cli, loadEnv, runE2e, stepLog, waitFor } from './lib.ts';

interface TaskInfo {
  taskId: string;
  state: string;
}
interface TaskDetail extends TaskInfo {
  steps: { name: string; state: string; output?: unknown }[];
  pendingCheckpoint?: { checkpoint: string };
}
interface EventRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}
interface ContextEntry {
  content: string;
  version: string;
}

await runE2e('e2e-1', async () => {
  const env = loadEnv();
  const log = stepLog('e2e-1');
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const taskId = `e2e1-${Date.now().toString(36)}`;

  // 注入：task run（notify 参数化——@feishu 开时发测试群，否则 CLI 目标）。
  const notify =
    env.feishuEnabled && env.testChatId !== undefined
      ? { channel: 'feishu-main', target: env.testChatId }
      : undefined;
  const input: Record<string, unknown> = { title: `E2E-1 bug ${taskId}` };
  if (notify !== undefined) input.notify = notify;
  cli(env, [
    'task',
    'run',
    'auto-delivery-lite',
    '--task-id',
    taskId,
    '--input',
    JSON.stringify(input),
  ]);

  // 等 waiting_human@confirm-release（locate 的 agent 回送经线上 consumer 真实走通）。
  await waitFor(`task ${taskId} waiting_human@confirm-release`, () => {
    const info = cli<TaskDetail>(env, ['task', 'get', taskId]);
    return info.state === 'waiting_human' &&
      info.pendingCheckpoint?.checkpoint === 'confirm-release'
      ? info
      : undefined;
  });
  log.pass('task reached waiting_human@confirm-release');

  // ① 前半：bug 条目已登记（status open）。
  const openBug = cli<ContextEntry>(env, ['context', 'cat', 'feedback/bugs', taskId]);
  const openBody = JSON.parse(openBug.content) as { status: string; title: string };
  assert(
    openBody.status === 'open',
    `bug status should be open before approval, got ${openBody.status}`,
  );
  log.pass('① bug entry registered with status=open', openBug.version);

  // ③ 卡片：outbound.message 带 actions（approve/reject 内嵌 signal）已下发。
  const card = await waitFor('checkpoint card outbound.message with actions', () => {
    const rows = cli<EventRow[]>(env, ['event', 'tail', '--once', '--since', startedAt]);
    const list = Array.isArray(rows) ? rows : [];
    return list.find((e) => {
      if (e.type !== 'outbound.message') return false;
      const content = e.payload.content as
        | { actions?: { signal?: { taskId?: string } }[] }
        | undefined;
      return content?.actions?.some((a) => a.signal?.taskId === taskId) ?? false;
    });
  });
  const actions = (card.payload.content as { actions: { label: string }[] }).actions;
  assert(
    actions.map((a) => a.label).includes('approve'),
    'card should carry an approve action button',
  );
  if (env.feishuEnabled) {
    log.pass('③ checkpoint card published to feishu-main（群内可见+点击留人工清单）');
  } else {
    log.pass('③ checkpoint card event carries signal actions (protocol proxy)');
  }

  // 恢复：CLI signal（DOD 认可的人类确认命令行路径；真实飞书点击留人工清单）。
  cli(env, ['task', 'signal', taskId, '--checkpoint', 'confirm-release', '--decision', 'approve']);
  await waitFor(`task ${taskId} done`, () => {
    const info = cli<TaskInfo>(env, ['task', 'get', taskId]);
    return info.state === 'done' ? info : undefined;
  });
  log.pass('signal approve → task done');

  // ① 后半：bug status open→fixed（版本递增证明重写）。
  const fixedBug = cli<ContextEntry>(env, ['context', 'cat', 'feedback/bugs', taskId]);
  const fixedBody = JSON.parse(fixedBug.content) as { status: string };
  assert(
    fixedBody.status === 'fixed',
    `bug status should be fixed after approval, got ${fixedBody.status}`,
  );
  assert(
    Number(fixedBug.version) > Number(openBug.version),
    'bug entry version should bump on open→fixed rewrite',
  );
  log.pass('① bug status walked open→fixed', `version ${openBug.version}→${fixedBug.version}`);

  // ② 接力链留痕：locate step done + 真实 agent.result output。
  const detail = cli<TaskDetail>(env, ['task', 'get', taskId]);
  const locate = detail.steps.find((s) => s.name === 'locate');
  assert(locate !== undefined && locate.state === 'done', 'locate step should be done');
  assert(
    locate.output !== undefined && locate.output !== null,
    'locate step should carry the agent.result output',
  );
  log.pass('② relay hop (locate) carries a real agent.result', JSON.stringify(locate.output));

  // ④ AuditLog 可回放：本任务窗口内 task signal 的判定留痕存在（CLI 路径 Check(platform://task,
  //   'signal')；飞书卡片路径为 Check(task://<id>,'signal')——两路同 action）。
  const audit = cli<{
    items: { resource: string; action: string; decision: string; at: string }[];
  }>(env, ['audit', 'list']);
  const signalAudit = audit.items.find(
    (r) =>
      (r.resource === 'platform://task' || r.resource.startsWith('task://')) &&
      r.action === 'signal' &&
      r.at >= startedAt,
  );
  assert(signalAudit !== undefined, 'audit should contain the task signal Check decision');
  assert(
    signalAudit.decision === 'allow',
    `signal audit decision should be allow, got ${signalAudit.decision}`,
  );
  log.pass('④ audit trail replayable', `task signal → ${signalAudit.decision}`);
});
