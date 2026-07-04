import { useState } from 'react';
import { EmptyState, ErrorState, LoadingRows, PageHeader, StatusDot } from '~/components/page';
import { Button } from '~/components/ui/button';
import { Card, CardContent } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
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
import { api } from '~/lib/api';

const LIMITS = ['25', '50', '100', '200'];

export default function AuditView() {
  // 待输入的筛选态（改动不即时触发请求）。
  const [principal, setPrincipal] = useState('');
  const [decision, setDecision] = useState<'all' | 'allow' | 'deny'>('all');
  const [limit, setLimit] = useState('50');
  // 已提交的筛选态（点「查询」才落地）。
  const [q, setQ] = useState({ principal: '', decision: 'all', limit: 50 });

  const audit = useLoad(() => {
    const filter: Record<string, string> = {};
    if (q.principal.trim()) filter.principal = q.principal.trim();
    if (q.decision !== 'all') filter.decision = q.decision;
    return api.listAudit(filter, q.limit);
  }, [q]);

  const submit = () => setQ({ principal, decision, limit: Number.parseInt(limit, 10) || 50 });

  const records = audit.data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit"
        description="策略判定审计流——principal / decision 过滤，allow/deny 状态可视。"
        actions={
          <Button variant="outline" size="sm" onClick={audit.reload}>
            刷新
          </Button>
        }
      />

      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1.5">
              <Label className="section-label">Principal</Label>
              <Input
                value={principal}
                onChange={(e) => setPrincipal(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder="user:alice / agent:..."
                className="w-64 font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="section-label">Decision</Label>
              <Select value={decision} onValueChange={(v) => setDecision(v as typeof decision)}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="allow">allow</SelectItem>
                  <SelectItem value="deny">deny</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="section-label">Limit</Label>
              <Select value={limit} onValueChange={setLimit}>
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LIMITS.map((l) => (
                    <SelectItem key={l} value={l}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={submit}>查询</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          {audit.loading ? (
            <LoadingRows rows={8} />
          ) : audit.error ? (
            <ErrorState error={audit.error} onRetry={audit.reload} />
          ) : !records.length ? (
            <EmptyState message="无匹配审计记录" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">时间</TableHead>
                  <TableHead className="w-24">判定</TableHead>
                  <TableHead>Principal</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Resource</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((rec) => (
                  <TableRow key={rec.id}>
                    <TableCell className="data-cell text-muted-foreground">
                      {new Date(rec.at).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <StatusDot
                        tone={rec.decision === 'allow' ? 'success' : 'destructive'}
                        label={rec.decision}
                      />
                    </TableCell>
                    <TableCell className="data-cell">{rec.context.principal}</TableCell>
                    <TableCell className="data-cell">{rec.action}</TableCell>
                    <TableCell className="data-cell text-muted-foreground">
                      {rec.resource}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {records.length ? (
            <p className="text-muted-foreground mt-3 text-xs">
              共 {records.length} 条（上限 {q.limit}）
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
