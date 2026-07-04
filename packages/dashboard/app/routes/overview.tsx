import { Activity, Bot, Coins, ListChecks } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyState, ErrorState, LoadingRows, PageHeader, StatusDot } from '~/components/page';
import { StatCard } from '~/components/stat-card';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
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
import { api, eventsApi, healthz } from '~/lib/api';

/** MetricSeries[] 全点求和（tokens 汇总；与 CLI metrics.ts sumSeries 同义）。 */
function sumSeries(series: MetricSeries[]): number {
  return series.reduce((acc, s) => acc + s.points.reduce((a, p) => a + p.v, 0), 0);
}

/** 最近 7 天窗口（tokens 汇总用）。 */
function last7dRange(): { from: string; to: string } {
  const now = Date.now();
  return { from: new Date(now - 7 * 86_400_000).toISOString(), to: new Date(now).toISOString() };
}

export default function OverviewView() {
  const health = useLoad(() => healthz().catch(() => ({ ok: false })), []);
  const instances = useLoad(() => api.listAgentInstances(), []);
  const tasks = useLoad(() => api.listTasks(), []);
  const range = last7dRange();
  const tokens = useLoad(() => api.queryMetric('tokens', range.from, range.to), []);
  const recentAudit = useLoad(() => api.listAudit({}, 8), []);
  const recentEvents = useLoad(() => eventsApi.listEvents({}, 8), []);

  const health7 = health.data;
  const tokenTotal = tokens.data ? sumSeries(tokens.data.series) : 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Overview"
        description="平台运行态一览——健康探针、实例/任务规模与近 7 日 token 用量。"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              health.reload();
              instances.reload();
              tasks.reload();
              tokens.reload();
              recentAudit.reload();
              recentEvents.reload();
            }}
          >
            刷新
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Gateway"
          icon={<Activity className="size-4" />}
          loading={health.loading}
          value={
            <StatusDot
              tone={health7?.ok ? 'success' : 'destructive'}
              label={health7?.ok ? 'healthy' : 'down'}
            />
          }
          hint={
            health7?.ok
              ? 'version' in health7
                ? `v${health7.version ?? '—'}`
                : 'online'
              : '探针失败'
          }
        />
        <StatCard
          label="Agent Instances"
          icon={<Bot className="size-4" />}
          loading={instances.loading}
          value={instances.data?.items.length ?? 0}
          hint="运行中/已快照实例"
        />
        <StatCard
          label="Tasks"
          icon={<ListChecks className="size-4" />}
          loading={tasks.loading}
          value={tasks.data?.items.length ?? 0}
          hint="Workflow 任务实例"
        />
        <StatCard
          label="Tokens · 7d"
          icon={<Coins className="size-4" />}
          loading={tokens.loading}
          value={tokenTotal.toLocaleString()}
          hint="input + output（近 7 日合计）"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="font-mono text-sm">最近判定 · Audit</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link to="/audit">查看全部</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {recentAudit.loading ? (
              <LoadingRows rows={4} />
            ) : recentAudit.error ? (
              <ErrorState error={recentAudit.error} onRetry={recentAudit.reload} />
            ) : !recentAudit.data?.items.length ? (
              <EmptyState message="暂无审计记录" />
            ) : (
              <Table>
                <TableBody>
                  {recentAudit.data.items.map((rec) => (
                    <TableRow key={rec.id}>
                      <TableCell className="py-2">
                        <StatusDot
                          tone={rec.decision === 'allow' ? 'success' : 'destructive'}
                          label={rec.decision}
                        />
                      </TableCell>
                      <TableCell className="data-cell text-muted-foreground py-2">
                        {rec.context.principal}
                      </TableCell>
                      <TableCell className="data-cell py-2">
                        {rec.action} {rec.resource}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="font-mono text-sm">最近事件 · Events</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link to="/events">查看全部</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {recentEvents.loading ? (
              <LoadingRows rows={4} />
            ) : recentEvents.error ? (
              <ErrorState error={recentEvents.error} onRetry={recentEvents.reload} />
            ) : !recentEvents.data?.items.length ? (
              <EmptyState message="暂无事件" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>时间</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>来源</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentEvents.data.items.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="data-cell text-muted-foreground py-2">
                        {new Date(e.occurredAt).toLocaleTimeString()}
                      </TableCell>
                      <TableCell className="data-cell py-2">{e.type}</TableCell>
                      <TableCell className="data-cell text-muted-foreground py-2">
                        {e.source.channel ?? e.source.kind}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
