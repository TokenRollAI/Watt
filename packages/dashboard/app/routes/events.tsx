import { useEffect, useState } from 'react';
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '~/components/page';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent } from '~/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Switch } from '~/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs';
import { useLoad } from '~/hooks/use-load';
import type { EventView } from '~/lib/api';
import { eventsApi } from '~/lib/api';
import { cn } from '~/lib/utils';

const TAIL_INTERVAL_MS = 5000;

/** JSON pretty（payload 详情用；非法对象降级为 String）。 */
function pretty(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function EventsTab() {
  const [typeFilter, setTypeFilter] = useState('');
  const [q, setQ] = useState('');
  const [tail, setTail] = useState(false);
  const [selected, setSelected] = useState<EventView | null>(null);

  const events = useLoad(() => eventsApi.listEvents(q.trim() ? { type: q.trim() } : {}, 100), [q]);

  // tail 模式：每 5s 自动 reload（轮询 List，与 CLI event tail 同义）。
  const { reload } = events;
  useEffect(() => {
    if (!tail) return;
    const id = setInterval(reload, TAIL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [tail, reload]);

  const items = events.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-end gap-3">
          <div className="space-y-1.5">
            <Label className="section-label">Type 过滤</Label>
            <Input
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && setQ(typeFilter)}
              placeholder="agent.result / inbound.message ..."
              className="w-64 font-mono text-xs"
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => setQ(typeFilter)}>
            查询
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="tail-toggle" checked={tail} onCheckedChange={setTail} />
          <Label
            htmlFor="tail-toggle"
            className={cn(
              'cursor-pointer text-sm',
              tail ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            tail（5s 自动刷新）
          </Label>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          {events.loading && !items.length ? (
            <LoadingRows rows={8} />
          ) : events.error ? (
            <ErrorState error={events.error} onRetry={events.reload} />
          ) : !items.length ? (
            <EmptyState message="无事件" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">时间</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>Session</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((e) => (
                  <TableRow key={e.id} className="cursor-pointer" onClick={() => setSelected(e)}>
                    <TableCell className="data-cell text-muted-foreground">
                      {new Date(e.occurredAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="data-cell">{e.type}</TableCell>
                    <TableCell className="data-cell text-muted-foreground">
                      {e.source.channel ?? e.source.kind}
                    </TableCell>
                    <TableCell className="data-cell text-muted-foreground">
                      {e.session ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={selected !== null} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{selected?.type}</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              {selected?.id} · {selected ? new Date(selected.occurredAt).toLocaleString() : ''}
            </DialogDescription>
          </DialogHeader>
          {selected ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline" className="font-mono text-[10px]">
                  source: {selected.source.kind}
                  {selected.source.ref ? ` · ${selected.source.ref}` : ''}
                </Badge>
                {selected.source.channel ? (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    channel: {selected.source.channel}
                  </Badge>
                ) : null}
                {selected.session ? (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    session: {selected.session}
                  </Badge>
                ) : null}
              </div>
              <div>
                <p className="section-label mb-1.5">Payload</p>
                <pre className="bg-muted max-h-96 overflow-auto rounded-md p-3 font-mono text-xs leading-relaxed">
                  {pretty(selected.payload)}
                </pre>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SubscriptionsTab() {
  const subs = useLoad(() => eventsApi.listSubscriptions(), []);
  const items = subs.data?.items ?? [];
  return (
    <Card>
      <CardContent className="pt-6">
        {subs.loading ? (
          <LoadingRows rows={5} />
        ) : subs.error ? (
          <ErrorState error={subs.error} onRetry={subs.reload} />
        ) : !items.length ? (
          <EmptyState message="无订阅" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-40">ID</TableHead>
                <TableHead>Match</TableHead>
                <TableHead>Sink</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((s, i) => (
                <TableRow key={s.id ?? i}>
                  <TableCell className="data-cell">{s.id ?? '—'}</TableCell>
                  <TableCell className="data-cell text-muted-foreground">
                    {pretty(s.match)}
                  </TableCell>
                  <TableCell className="data-cell text-muted-foreground">
                    {pretty(s.sink)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export default function EventsView() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Events"
        description="事件流 tail 与订阅——点击行看信封 payload，tail 开关 5s 轮询刷新。"
      />
      <Tabs defaultValue="events">
        <TabsList>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="subscriptions">Subscriptions</TabsTrigger>
        </TabsList>
        <TabsContent value="events">
          <EventsTab />
        </TabsContent>
        <TabsContent value="subscriptions">
          <SubscriptionsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
