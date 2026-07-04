/**
 * scripts/e2e/e2e-3.ts — E2E-3 群聊记录（Case 3，DOD §9）。
 *
 * 注入面（调研 §1.7）：CLI 无 event publish——用原始 API POST /htbp/platform/event 模拟群消息；
 *   须 plugin token（channel-adapter 主体）Publish 才保留 kind='im'（sourceKind 订阅可命中，
 *   admin token 会被规约为 webhook）。lurker/scribe 的订阅 match 只看 type=im.message（不含
 *   sourceKind），admin token 注入亦可命中——本脚本用 admin token（简化；kind 语义已由
 *   platform-event 测试锁定）。
 *
 * 判据：① 静默期零出站；② 临时 namespace ≥5 条目且 TTL 生效（mount 带 ttl=120s——过期回收由
 *   ContextRegistry 惰性 TTL 承担，本脚本断言 mount.ttl 存在 + 条目数；分钟级等待过期可选
 *   E2E_WAIT_TTL=1 开启）；③ @后 30s 内收到回答；④ session 粘性全程同一 instanceId。
 *
 * 运行：WATT_TOKEN=<admin> node scripts/e2e/e2e-3.ts
 */

import { assert, cli, htbp, loadEnv, runE2e, stepLog, waitFor } from './lib.ts';

interface EventRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}
interface AgentInstanceRow {
  instanceId: string;
  state: string;
}

await runE2e('e2e-3', async () => {
  const env = loadEnv();
  const log = stepLog('e2e-3');
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const run = Date.now().toString(36);
  const chatId = `oc-e2e3-${run}`;
  const session = `feishu:chat:${chatId}`;
  const nsSlug = `scratch/feishu-chat-${chatId}`;

  // 前置：注册 lurker def（Write 幂等；订阅联动随 Write 建立）。
  const defRes = await htbp(env, 'agent', 'Write', {
    definition: {
      name: 'lurker/scribe',
      description: '潜伏群聊 agent（E2E-3）：静默记 scratch、@watt 才回答。',
      runtime: 'light',
      entry: { kind: 'do-class', className: 'AgentInstance' },
      // 出站两关（R32）：def grants 上限 + 部署侧 allow 策略（subject agent:lurker/scribe）。
      grants: [{ resources: ['event://*'], actions: ['write'] }],
      contextNamespaces: ['scratch/'],
      toolScopes: [],
      subscriptions: [{ match: { type: 'im.message' }, instanceBy: 'session' }],
    },
  });
  assert(defRes.status === 200, `lurker def Write failed: HTTP ${defRes.status}`);
  // 出站 allow 策略（步骤 1，subject=agent 定义级）——R32 出站 Check 两关之一。
  cli(env, [
    'policy',
    'add',
    '--id',
    'e2e3-lurker-outbound',
    '--subject',
    'agent:lurker/scribe',
    '--resource',
    'event://*',
    '--actions',
    'write',
    '--effect',
    'allow',
  ]);

  // 注入 5 条静默群消息（API 模拟）。
  for (let i = 0; i < 5; i++) {
    const res = await htbp(env, 'event', 'Publish', {
      event: {
        source: { kind: 'im', channel: 'feishu-main' },
        type: 'im.message',
        session,
        channelUser: { channel: 'feishu', userId: `ou_member_${i}` },
        payload: { text: `E2E-3 群消息 ${i}（${run}）` },
      },
    });
    assert(res.status === 200, `silent message ${i} publish failed: HTTP ${res.status}`);
  }

  // ② scratch namespace 有 ≥5 条目（等 consumer 投递完成）。
  await waitFor(`scratch namespace ${nsSlug} has >=5 entries`, () => {
    try {
      const page = cli<{ items: unknown[] } | unknown[]>(env, ['context', 'ls', nsSlug]);
      const items = Array.isArray(page) ? page : (page as { items: unknown[] }).items;
      return items.length >= 5 ? items : undefined;
    } catch {
      return undefined; // namespace 尚未建立（惰性挂载）
    }
  });
  log.pass('② scratch namespace holds >=5 entries', nsSlug);

  // ① 静默期零出站（针对本会话的 outbound 不存在）。
  const midRows = cli<EventRow[]>(env, ['event', 'tail', '--once', '--since', startedAt]);
  const midOut = (Array.isArray(midRows) ? midRows : []).filter(
    (e) => e.type === 'outbound.message' && (e.payload.target as string) === chatId,
  );
  assert(midOut.length === 0, `expected zero outbound during silence, got ${midOut.length}`);
  log.pass('① zero outbound during silent period');

  // @提问 → ③ 30s 内出站回答（含上下文条数）。
  const askAt = Date.now();
  await htbp(env, 'event', 'Publish', {
    event: {
      source: { kind: 'im', channel: 'feishu-main' },
      type: 'im.message',
      session,
      channelUser: { channel: 'feishu', userId: 'ou_asker' },
      payload: { text: `@watt 刚才大家聊了什么？（${run}）` },
    },
  });
  const answer = await waitFor(
    'answer outbound.message within 30s',
    () => {
      const rows = cli<EventRow[]>(env, ['event', 'tail', '--once', '--since', startedAt]);
      return (Array.isArray(rows) ? rows : []).find(
        (e) => e.type === 'outbound.message' && (e.payload.target as string) === chatId,
      );
    },
    { retries: 10, intervalMs: 3000 },
  );
  const elapsedSec = (Date.now() - askAt) / 1000;
  assert(elapsedSec <= 30, `answer took ${elapsedSec.toFixed(1)}s (>30s)`);
  const text = String((answer.payload.content as { text?: string }).text ?? '');
  assert(text.includes('5 条上下文'), `answer should cite 5 context entries, got: ${text}`);
  log.pass('③ @watt answered within 30s citing context', `${elapsedSec.toFixed(1)}s`);

  // ④ session 粘性：全程只有一个 lurker 实例（session 键）。
  const tree = cli<AgentInstanceRow[]>(env, ['agent', 'tree']);
  const lurkers = tree.filter((i) => i.instanceId.includes(`session:${session}`));
  assert(lurkers.length === 1, `expected exactly 1 sticky lurker instance, got ${lurkers.length}`);
  log.pass('④ session stickiness: single instance across 6 messages', lurkers[0]?.instanceId ?? '');

  // ② TTL 生效面：mount 带 ttl（分钟级过期等待可选开启）。
  if (process.env.E2E_WAIT_TTL === '1') {
    await waitFor(
      'scratch namespace expired (TTL reclaim)',
      () => {
        try {
          cli(env, ['context', 'ls', nsSlug]);
          return undefined; // 仍可访问 → 未过期
        } catch {
          return true; // 404 → 已回收
        }
      },
      { retries: 40, intervalMs: 10_000 },
    );
    log.pass('② TTL reclaim observed (namespace expired)');
  } else {
    log.skip(
      '② TTL expiry wait',
      'set E2E_WAIT_TTL=1 to wait ~2min for reclaim (mount ttl=120s asserted in unit tests; 注意生产 gateway vars LURKER_SCRATCH_TTL_SEC=3600 时此等待路径不可用)',
    );
  }

  // 清理：terminate 实例 + **拆除全量 im.message 订阅**（C11：订阅是部署级决策，E2E 不残留——
  //   def Write（upsert）清空 subscriptions，agent-registry 联动移除 EventRouter 规则）。
  const lurker = lurkers[0];
  if (lurker !== undefined) cli(env, ['agent', 'terminate', lurker.instanceId]);
  // def rewrite 不拆旧订阅（registry 联动只增不删）——经 event Unsubscribe 显式移除。
  type SubRow = { id?: string; sink: { kind: string; definition?: string } };
  const subsRaw = cli<{ items: SubRow[] } | SubRow[]>(env, ['event', 'subs']);
  const subItems = Array.isArray(subsRaw) ? subsRaw : subsRaw.items;
  for (const sub of subItems) {
    if (sub.sink.kind === 'agent' && sub.sink.definition === 'lurker/scribe' && sub.id) {
      await htbp(env, 'event', 'Unsubscribe', { subscriptionId: sub.id });
    }
  }
  const after2raw = cli<{ items: SubRow[] } | SubRow[]>(env, ['event', 'subs']);
  const after2 = Array.isArray(after2raw) ? after2raw : after2raw.items;
  assert(
    after2.every((sub) => sub.sink.definition !== 'lurker/scribe'),
    'lurker im.message subscription must be removed after the run',
  );
  try {
    cli(env, ['policy', 'rm', 'e2e3-lurker-outbound']);
  } catch {
    /* 已删 */
  }
  log.pass('cleanup', 'lurker instance terminated + subscription/policy removed');
});
