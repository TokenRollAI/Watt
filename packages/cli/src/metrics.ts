/**
 * `watt metrics query`：POST /htbp/platform/metrics `{tool:"Query",arguments:{query}}`（Proto §10）。
 * R23：接真实 Metrics.Query。--metric + --range（7d/24h 语法糖 → {from,to}）+ --group-by。
 * 返回体真源 = gateway 路由 { series: MetricSeries[] }（精确解包，禁双形态兜底）。
 */

import { type HttpDeps, htbpCall } from './client.ts';

export interface MetricSeries {
  labels: Record<string, string>;
  points: { t: string; v: number }[];
}
export interface MetricsQueryResult {
  series: MetricSeries[];
}

export interface MetricsQueryArgs {
  metric: string;
  /** range 语法糖：`7d` / `24h` / `30m`（相对 now 回溯）；或直接 from/to ISO8601。 */
  range?: string;
  from?: string;
  to?: string;
  groupBy?: string[];
}

/** 解析 `7d`/`24h`/`30m` → 毫秒；非法 → undefined。 */
export function parseRangeToMs(range: string): number | undefined {
  const m = range.match(/^(\d+)([dhm])$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000;
  return n * mult;
}

/** 由 args 组装 {from,to}（range 语法糖优先；否则 from/to；缺省最近 7 天）。 */
export function resolveRange(
  args: MetricsQueryArgs,
  now: () => number = Date.now,
): {
  from: string;
  to: string;
} {
  const toMs = now();
  if (args.from !== undefined && args.to !== undefined) {
    return { from: args.from, to: args.to };
  }
  const spanMs =
    args.range !== undefined ? (parseRangeToMs(args.range) ?? 7 * 86_400_000) : 7 * 86_400_000;
  return { from: new Date(toMs - spanMs).toISOString(), to: new Date(toMs).toISOString() };
}

export async function metricsQuery(
  base: string,
  token: string,
  args: MetricsQueryArgs,
  deps: HttpDeps = {},
  now: () => number = Date.now,
): Promise<MetricsQueryResult> {
  const range = resolveRange(args, now);
  const query: Record<string, unknown> = { metric: args.metric, range };
  if (args.groupBy !== undefined && args.groupBy.length > 0) query.groupBy = args.groupBy;
  const res = (await htbpCall(base, token, 'metrics', 'Query', { query }, deps)) as {
    series?: MetricSeries[];
  };
  return { series: res.series ?? [] };
}

/** MetricSeries[] 单点求和（status 汇总用；points 累加各 series 的最新点）。 */
export function sumSeries(series: MetricSeries[]): number {
  return series.reduce((acc, s) => acc + s.points.reduce((a, p) => a + p.v, 0), 0);
}

export function formatMetricsHuman(metric: string, r: MetricsQueryResult): string {
  if (!r.series.length) return `${metric}: (no data)`;
  return r.series
    .map((s) => {
      const label = Object.entries(s.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      const total = s.points.reduce((a, p) => a + p.v, 0);
      return `${metric}${label ? `{${label}}` : ''}: ${total}`;
    })
    .join('\n');
}
