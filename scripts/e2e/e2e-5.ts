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
    // C5 修正：先取基线（1d 窗内 minimax-m3 已有量），断言**增量**——复跑不因上一轮残余假绿。
    const readModelTotal = (): number => {
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
      return byModel.series
        .filter((s) => s.labels.model === 'minimax-m3')
        .flatMap((s) => s.points)
        .reduce((acc, p) => acc + p.v, 0);
    };
    const baseline = readModelTotal();
    const key = `e2e5-${Date.now().toString(36)}`;
    cli(env, ['agent', 'spawn', DEF, '--instance-key', key]);
    cli(env, ['agent', 'send', key, '--payload', '{"text":"reply with the word ok"}']);
    await waitFor('usage DELTA on the new default model (minimax-m3)', () =>
      readModelTotal() > baseline ? true : undefined,
    );
    cli(env, ['agent', 'terminate', key]);
    log.pass(
      '④ LLM call landed NEW usage on the default provider model (minimax-m3)',
      `baseline=${baseline}`,
    );
  }

  // C12 修正：清 default 位（Update default:false）——测试渠道不残留为平台默认（'default' 哨兵
  //   def 与缺省 model 的 def 会跟随 default 渠道；钉死模型 def 经 R32 修复后不受影响但仍应复位）。
  await import('./lib.ts').then((m) =>
    m.htbp(env, 'provider', 'Update', { providerId: PROVIDER_B, patch: { default: false } }),
  );
  const finalList = cli<ProviderRow[]>(env, ['provider', 'list']);
  assert(
    finalList.every((prov) => !prov.default || !prov.id.startsWith('e2e5-')),
    'e2e5 test providers must not remain the platform default after cleanup',
  );
  log.pass('cleanup', 'default flag cleared off e2e5-* providers (rows left, upsert-idempotent)');
});
