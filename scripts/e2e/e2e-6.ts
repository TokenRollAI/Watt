/**
 * scripts/e2e/e2e-6.ts — E2E-6 定时任务（Case 6，DOD §9）。
 *
 * 判据：① CronJob 落库 action=script 且脚本在 context://automations 可读；② Trigger 后测试群收到
 *   含真实数字的日报（@feishu 门控——未开时以「日报事件 payload 含真实 tokens 数字 + outbound 出站
 *   留痕」为协议等价断言）；③ cron.fired/cron.completed 成对留痕；④ 脚本越权调用被 deny。
 * 建 job 的对话路径（manage/cron，@llm）在 DoD Phase 6 ④ 已单独采证——本条按协议降级用
 *   `watt cron create`（调研 §1.6），@llm 消耗留给 E2E-5 判据④（每轮每 tag 一次）。
 *
 * 运行：WATT_TOKEN=<admin> [E2E_FEISHU=1] node scripts/e2e/e2e-6.ts
 */

import { assert, cli, loadEnv, runE2e, stepLog, waitFor } from './lib.ts';

interface EventRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

// jobId/脚本路径带运行序号（C19 修正：固定 id + 前推窗口会命中上一轮陈旧事件而假绿）。
const RUN = Date.now().toString(36);
const JOB = `e2e6-daily-tokens-${RUN}`;
const DENY_JOB = `e2e6-deny-probe-${RUN}`;
const SCRIPT_PATH = `e2e6-daily-report-${RUN}`;
const DENY_SCRIPT_PATH = `e2e6-deny-script-${RUN}`;
let cleaned = false; // 声明须在 runE2e 顶层 await 之前（TDZ）

await runE2e('e2e-6', async () => {
  const env = loadEnv();
  const log = stepLog('e2e-6');
  // C14 修正：@feishu 门控未开时 channel 用不存在渠道（consumer 查无 channel 即跳过投递，
  //   不打真实飞书）；协议断言只看 outbound.message 事件留痕，与渠道无关。
  const feishuOn = env.feishuEnabled && env.testChatId !== undefined;
  const outChannel = feishuOn ? 'feishu-main' : 'e2e6-null-channel';
  const chat = feishuOn ? (env.testChatId as string) : 'cli:e2e-6';
  const startedAt = new Date().toISOString(); // 事件窗从当下起（C19：不前推，防陈旧命中）

  // 前置：日报脚本存 context://automations（queryMetric 取真实 tokens 数字 → publish outbound）。
  const script = [
    "import { WorkerEntrypoint } from 'cloudflare:workers';",
    'export default class extends WorkerEntrypoint {',
    '  async run(watt) {',
    '    const to = new Date().toISOString();',
    '    const from = new Date(Date.now() - 86400000).toISOString();',
    "    const { series } = await watt.queryMetric({ metric: 'tokens', range: { from, to } });",
    '    let total = 0;',
    '    for (const s of series) for (const p of s.points) total += p.v;',
    '    const out = await watt.publish({',
    "      type: 'outbound.message',",
    `      payload: { channel: ${JSON.stringify(outChannel)}, target: ${JSON.stringify(chat)}, content: { text: \`Watt 日报：token 用量总计 \${total}\` } },`,
    '    });',
    '    return { eventId: out.eventId, total };',
    '  }',
    '}',
  ].join('\n');
  cli(env, ['context', 'put', 'automations', SCRIPT_PATH, '--content', script]);
  const readBack = cli<{ content: string }>(env, ['context', 'cat', 'automations', SCRIPT_PATH]);
  assert(readBack.content.includes('queryMetric'), 'script not readable back from automations');

  // ① cron create（action=script，grants 覆盖 event manage + metrics read）→ get 断言落库。
  cli(env, [
    'cron',
    'create',
    JOB,
    '--schedule',
    '0 9 * * *',
    '--action-kind',
    'script',
    '--script-ref',
    `context://automations/${SCRIPT_PATH}`,
    '--grants',
    JSON.stringify([
      { resources: ['platform://event'], actions: ['manage'] },
      // outbound.message 触发出站 Check(event://<channel>/<target>,'write')——前缀通配需显式 *。
      { resources: ['event://*'], actions: ['write'] },
      { resources: ['platform://metrics'], actions: ['read'] },
    ]),
    '--description',
    'E2E-6 每日 token 用量日报',
  ]);
  const job = cli<{ id: string; action: { kind: string; scriptRef: string } }>(env, [
    'cron',
    'get',
    JOB,
  ]);
  assert(job.action.kind === 'script', `job action kind should be script, got ${job.action.kind}`);
  assert(job.action.scriptRef === `context://automations/${SCRIPT_PATH}`, 'job scriptRef mismatch');
  log.pass('① CronJob stored with action=script, script readable in context://automations');

  // ② Trigger 补跑 → 日报事件 payload 含真实数字；③ fired/completed 成对留痕。
  cli(env, ['cron', 'trigger', JOB]);
  const events = await waitFor('cron.fired + cron.completed(ok) + outbound report', async () => {
    const rows = cli<EventRow[]>(env, ['event', 'tail', '--once', '--since', startedAt]);
    const list = Array.isArray(rows) ? rows : [];
    const fired = list.find((e) => e.type === 'cron.fired' && (e.payload.jobId as string) === JOB);
    const completed = list.find(
      (e) => e.type === 'cron.completed' && (e.payload.jobId as string) === JOB,
    );
    const report = list.find(
      (e) =>
        e.type === 'outbound.message' &&
        (e.payload.channel as string) === outChannel &&
        String((e.payload.content as { text?: string } | undefined)?.text ?? '').includes(
          'Watt 日报',
        ),
    );
    if (fired && completed && report) return { fired, completed, report };
    return undefined;
  });
  assert(
    (events.completed.payload.ok as boolean) === true,
    `cron.completed ok!=true: ${JSON.stringify(events.completed.payload)}`,
  );
  const reportText = String(
    (events.report.payload.content as { text?: string } | undefined)?.text ?? '',
  );
  // C4 修正：/\d/ 对模板自带文字恒真——断言"总计 <n>"的 n 是非零数字（真实 usage 累计）。
  const m = reportText.match(/总计 (\d+)/);
  assert(m !== null, `report text lacks the total-number shape: ${reportText}`);
  assert(Number(m[1]) > 0, `report total should be a real non-zero usage number: ${reportText}`);
  log.pass('③ cron.fired/cron.completed paired', `ok=true`);
  if (env.feishuEnabled && env.testChatId !== undefined) {
    // 真实群可见性由人工核对（脚本无法读群消息——机器人缺读权限，PROGRESS R24）。
    log.pass('② report published to feishu-main (人工核对群内可见)', reportText);
  } else {
    log.pass('② report event carries real tokens number (protocol proxy)', reportText);
  }

  // ④ 越权：grants 只有 metrics read（无 event manage）的脚本 publish → deny → completed ok:false。
  const denyScript = [
    "import { WorkerEntrypoint } from 'cloudflare:workers';",
    'export default class extends WorkerEntrypoint {',
    '  async run(watt) {',
    "    return watt.publish({ type: 'e2e6.escalation', payload: {} });",
    '  }',
    '}',
  ].join('\n');
  cli(env, ['context', 'put', 'automations', DENY_SCRIPT_PATH, '--content', denyScript]);
  cli(env, [
    'cron',
    'create',
    DENY_JOB,
    '--schedule',
    '0 9 * * *',
    '--action-kind',
    'script',
    '--script-ref',
    `context://automations/${DENY_SCRIPT_PATH}`,
    '--grants',
    JSON.stringify([{ resources: ['platform://metrics'], actions: ['read'] }]),
  ]);
  cli(env, ['cron', 'trigger', DENY_JOB]);
  const denied = await waitFor('deny-job cron.completed(ok:false)', async () => {
    const rows = cli<EventRow[]>(env, ['event', 'tail', '--once', '--since', startedAt]);
    const list = Array.isArray(rows) ? rows : [];
    return list.find(
      (e) =>
        e.type === 'cron.completed' &&
        (e.payload.jobId as string) === DENY_JOB &&
        (e.payload.ok as boolean) === false,
    );
  });
  // C9/C18 修正：断言错误语义确为权限拒绝（任何脚本故障都有 error 非空——那是假绿）。
  const denyErr = String(denied.payload.error ?? '');
  assert(
    /permission_denied|denied|grant exceeded/i.test(denyErr),
    `deny error should be a permission denial, got: ${denyErr}`,
  );
  log.pass('④ out-of-grant script publish denied', String(denied.payload.error));

  // 清理（失败路径由 process exit 钩子兜底，C13）。
  cleanup(env);
  cleaned = true;
  log.pass('cleanup', 'cron jobs removed (scripts left in automations for audit)');
});

/** 幂等清理（C13：断言失败也不遗留每天 09:00 真实触发的 CronJob）。 */
function cleanup(env: ReturnType<typeof loadEnv>): void {
  for (const id of [JOB, DENY_JOB]) {
    try {
      cli(env, ['cron', 'rm', id]);
    } catch {
      /* 不存在/已删 */
    }
  }
}
process.on('exit', () => {
  if (cleaned) return;
  try {
    cleanup(loadEnv());
  } catch {
    /* token 失效等——人工清单兜底 */
  }
});
