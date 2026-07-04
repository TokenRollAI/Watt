/**
 * scripts/e2e/e2e-5.ts — E2E-5 Provider 管理（Case 5，DOD §9）。
 *
 * 判据：① Metrics.Query 返回非空 tokens 序列（缓存命中率放宽——AI Gateway 原生指标非 metrics 面，
 *   调研 §3.2）；② 新渠道 Write 后 List 可见；③ Update{default:true} 后旧默认自动翻转；
 *   ④ 随后的 LLM 调用在新渠道模型上留下用量记录（@llm 门控 E2E_LLM=1，未开则 SKIP——
 *   判据①②③ 为无消耗协议断言，无条件跑）。
 *
 * 运行：WATT_TOKEN=<admin> [E2E_LLM=1] node scripts/e2e/e2e-5.ts
 */

import { assert, cli, loadEnv, runE2e, stepLog, waitFor } from './lib.ts';

interface ProviderRow {
  id: string;
  default: boolean;
  models: string[];
}
interface MetricPoint {
  t: string;
  v: number;
}
interface MetricSeries {
  labels: Record<string, string>;
  points: MetricPoint[];
}

const PROVIDER_A = 'e2e5-relay-a';
const PROVIDER_B = 'e2e5-relay-b';

await runE2e('e2e-5', async () => {
  const env = loadEnv();
  const log = stepLog('e2e-5');
  const range = (days: number) => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    return { from: from.toISOString(), to: to.toISOString() };
  };

  // ① Metrics.Query tokens 7d 非空（Phase 4 以来的真实用量）。
  const r = range(7);
  const tokens = cli<{ series: MetricSeries[] }>(env, [
    'metrics',
    'query',
    '--metric',
    'tokens',
    '--range',
    '7d',
  ]);
  const total = tokens.series.flatMap((s) => s.points).reduce((acc, p) => acc + p.v, 0);
  assert(total > 0, `tokens 7d series is empty (expected real usage since Phase 4), got ${total}`);
  log.pass('① metrics tokens 7d non-empty', `total=${total} (${r.from.slice(0, 10)}~)`);

  // ② Write 渠道 A（default）→ List 可见。
  cli(env, [
    'provider',
    'add',
    PROVIDER_A,
    '--vendor',
    'anthropic',
    '--models',
    'glm-5.2',
    '--secret-ref',
    'ANTHROPIC_API_KEY',
  ]);
  cli(env, ['provider', 'set-default', PROVIDER_A]);
  let list = cli<ProviderRow[]>(env, ['provider', 'list']);
  assert(
    list.some((p) => p.id === PROVIDER_A),
    `provider ${PROVIDER_A} not visible in List after Write`,
  );
  log.pass('② new provider visible in List');

  // ③ Write 渠道 B → set-default → 旧默认（A）自动翻转。
  cli(env, [
    'provider',
    'add',
    PROVIDER_B,
    '--vendor',
    'anthropic',
    '--models',
    'minimax-m3',
    '--secret-ref',
    'ANTHROPIC_API_KEY',
  ]);
  cli(env, ['provider', 'set-default', PROVIDER_B]);
  list = cli<ProviderRow[]>(env, ['provider', 'list']);
  const a = list.find((p) => p.id === PROVIDER_A);
  const b = list.find((p) => p.id === PROVIDER_B);
  assert(b?.default === true, `provider ${PROVIDER_B} should be default after set-default`);
  assert(a?.default === false, `old default ${PROVIDER_A} should have flipped to default:false`);
  log.pass('③ set-default flips the old default');

  // ④ 随后的 LLM 调用走新渠道（def model.preferred='default' 哨兵 → 实例解析 default 渠道）。
  if (!env.llmEnabled) {
    log.skip('④ LLM call lands usage on the new provider model', 'E2E_LLM!=1 (@llm gated)');
  } else {
    // def 不钉死模型：preferred='default' → harness 每次查 ModelProviderRegistry default。
    const DEF = 'e2e5-default-follower';
    const { status } = await import('./lib.ts').then((m) =>
      m.htbp(env, 'agent', 'Write', {
        definition: {
          name: DEF,
          description: 'E2E-5 判据④：跟随平台默认渠道的 llm def',
          runtime: 'light',
          entry: { kind: 'do-class', className: 'AgentInstance' },
          model: { preferred: 'default' },
          grants: [],
          contextNamespaces: [],
          toolScopes: [],
        },
      }),
    );
    assert(status === 200, `agent def Write failed: HTTP ${status}`);
    const key = `e2e5-${Date.now().toString(36)}`;
    cli(env, ['agent', 'spawn', DEF, '--instance-key', key]);
    cli(env, ['agent', 'send', key, '--payload', '{"text":"reply with the word ok"}']);
    // 断言：新渠道的模型（minimax-m3）在 usage 里出现（group-by model）。
    await waitFor('usage row on the new default model (minimax-m3)', () => {
      const byModel = cli<{ series: MetricSeries[] }>(env, [
        'metrics',
        'query',
        '--metric',
        'tokens',
        '--range',
        '1d',
        '--group-by',
        'model',
      ]);
      const hit = byModel.series.find(
        (s) => s.labels.model === 'minimax-m3' && s.points.some((p) => p.v > 0),
      );
      return hit !== undefined ? hit : undefined;
    });
    cli(env, ['agent', 'terminate', key]);
    log.pass('④ LLM call landed usage on the new default provider model (minimax-m3)');
  }

  // 清理：恢复 A 为默认再删两渠道？Provider 无 delete 动词——置回 B 非默认即可（enabled 保留）。
  // 平台无 provider rm：留两条 e2e5-* 渠道（幂等：下轮重跑 add 是 upsert）。把默认清位以免影响
  //   非 E2E 的 llm def（钉死模型的 def 不受 default 影响；resolveDefault 只对 'default' 哨兵生效）。
  log.pass('cleanup', 'providers left in place (upsert-idempotent), default stays on e2e5-relay-b');
});
