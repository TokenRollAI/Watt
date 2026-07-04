import { useState } from 'react';
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '~/components/page';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { useLoad } from '~/hooks/use-load';
import type { MetricSeries } from '~/lib/api';
import { api } from '~/lib/api';

/** 支持的 metric（gateway metrics.ts METRIC_NAMES）。cache_hit_rate/tool_calls 本轮返空 series。 */
const METRICS: { value: string; label: string }[] = [
  { value: 'tokens', label: 'tokens（input+output）' },
  { value: 'cost', label: 'cost' },
  { value: 'agent_instances', label: 'agent_instances' },
  { value: 'tasks', label: 'tasks' },
  { value: 'events', label: 'events' },
  { value: 'authz_denials', label: 'authz_denials' },
  { value: 'cache_hit_rate', label: 'cache_hit_rate' },
  { value: 'tool_calls', label: 'tool_calls' },
];

/** 时间范围语法糖 → 毫秒跨度。 */
const RANGES: { value: string; label: string; ms: number }[] = [
  { value: '1h', label: '最近 1 小时', ms: 3_600_000 },
  { value: '24h', label: '最近 24 小时', ms: 86_400_000 },
  { value: '7d', label: '最近 7 天', ms: 7 * 86_400_000 },
  { value: '30d', label: '最近 30 天', ms: 30 * 86_400_000 },
];

/** series 单点合计（labels 维度的总量，用于表格 + 条形对比）。 */
function seriesTotal(s: MetricSeries): number {
  return s.points.reduce((a, p) => a + p.v, 0);
}

/** labels 映射 → 可读维度串（无维度时 "(total)"）。 */
function labelText(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join(' · ') : '(total)';
}

export default function MetricsView() {
  const [metric, setMetric] = useState('tokens');
  const [rangeKey, setRangeKey] = useState('7d');
  // 已提交的查询参数（点「查询」才落地，避免每次改选就打后端）。
  const [query, setQuery] = useState<{ metric: string; rangeKey: string }>({
    metric: 'tokens',
    rangeKey: '7d',
  });

  const result = useLoad(() => {
    const span = RANGES.find((r) => r.value === query.rangeKey)?.ms ?? 7 * 86_400_000;
    const now = Date.now();
    return api.queryMetric(
      query.metric,
      new Date(now - span).toISOString(),
      new Date(now).toISOString(),
    );
  }, [query]);

  const series = result.data?.series ?? [];
  const max = series.reduce((m, s) => Math.max(m, seriesTotal(s)), 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Metrics"
        description="平台指标查询——按 metric 与时间窗聚合，返回 series 合计。"
      />

      <Card>
        <CardHeader>
          <CardTitle className="font-mono text-sm">查询</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1.5">
              <Label className="section-label">Metric</Label>
              <Select value={metric} onValueChange={setMetric}>
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METRICS.map((m) => (
                    <SelectItem key={m.value} value={m.value} className="font-mono text-xs">
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="section-label">时间范围</Label>
              <Select value={rangeKey} onValueChange={setRangeKey}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RANGES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => setQuery({ metric, rangeKey })}>查询</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="font-mono text-sm">
            结果
            <span className="text-muted-foreground ml-2 text-xs font-normal">
              {query.metric} · {query.rangeKey}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {result.loading ? (
            <LoadingRows rows={5} />
          ) : result.error ? (
            <ErrorState error={result.error} onRetry={result.reload} />
          ) : !series.length ? (
            <EmptyState message="该 metric 在此时间窗无数据" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>维度</TableHead>
                  <TableHead className="w-1/2">分布</TableHead>
                  <TableHead className="text-right">合计</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {series.map((s, i) => {
                  const total = seriesTotal(s);
                  const pct = max > 0 ? (total / max) * 100 : 0;
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: series 无稳定 id，labels 可重复（顺序即身份）。
                    <TableRow key={i}>
                      <TableCell className="data-cell">{labelText(s.labels)}</TableCell>
                      <TableCell>
                        <div className="bg-muted h-2.5 w-full overflow-hidden rounded-sm">
                          <div
                            className="bg-primary h-full rounded-sm transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="data-cell text-right tabular-nums">
                        {total.toLocaleString()}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
