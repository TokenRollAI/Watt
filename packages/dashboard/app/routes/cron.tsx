import { Plus, RefreshCw, Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, LoadingRows, PageHeader, StatusDot } from '~/components/page';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
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
import { DetailRow, JsonField } from '~/components/view-c-parts';
import { useLoad } from '~/hooks/use-load';
import { api, formatError } from '~/lib/api';
import { tasksApi } from '~/lib/api/tasks.ts';
import type { CronJob } from '~/lib/api/types.ts';

/**
 * Cron 视图（视图族 C）：List（schedule/enabled/action.kind）+ Create（三型 action）
 * + Get 详情 + Trigger（手动触发）+ Delete（确认）。
 * action 三型形状真源：packages/cli/src/cli.ts buildCronAction。
 */
export default function CronView() {
  const { data, error, loading, reload } = useLoad(() => api.listCron(), []);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [triggering, setTriggering] = useState<string | null>(null);

  async function trigger(jobId: string) {
    setTriggering(jobId);
    try {
      const { eventId } = await tasksApi.triggerCron(jobId);
      toast.success(`已触发，事件 ${eventId}`);
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setTriggering(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cron"
        description="定时任务：发布事件 / 起 Agent / 跑脚本。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={reload}>
              <RefreshCw className="size-4" />
              刷新
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              新建
            </Button>
          </>
        }
      />

      {loading ? (
        <LoadingRows />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState message="暂无定时任务。点击「新建」创建一个。" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>动作</TableHead>
              <TableHead>描述</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((j) => (
              <TableRow key={j.id}>
                <TableCell className="data-cell">{j.id}</TableCell>
                <TableCell>
                  <StatusDot
                    tone={j.enabled ? 'success' : 'muted'}
                    label={j.enabled ? 'enabled' : 'disabled'}
                  />
                </TableCell>
                <TableCell className="data-cell">{j.schedule}</TableCell>
                <TableCell className="data-cell">{String(j.action.kind)}</TableCell>
                <TableCell className="text-muted-foreground max-w-xs truncate">
                  {j.description}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => setDetailId(j.id)}>
                    详情
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={triggering === j.id}
                    onClick={() => trigger(j.id)}
                  >
                    <Zap className="size-4" />
                    触发
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDeleteId(j.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <CreateCronDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onDone={() => {
          setCreateOpen(false);
          reload();
        }}
      />
      {detailId ? <CronDetailDialog jobId={detailId} onClose={() => setDetailId(null)} /> : null}
      <DeleteCronDialog
        jobId={deleteId}
        onClose={() => setDeleteId(null)}
        onDone={() => {
          setDeleteId(null);
          reload();
        }}
      />
    </div>
  );
}

type ActionKind = 'publish' | 'agent' | 'script';

/** 新建 cron：五段 schedule + 三型 action（publish/agent/script）。 */
function CreateCronDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const [id, setId] = useState('');
  const [description, setDescription] = useState('');
  const [schedule, setSchedule] = useState('');
  const [enabled, setEnabled] = useState('true');
  const [kind, setKind] = useState<ActionKind>('publish');
  const [busy, setBusy] = useState(false);

  // publish
  const [eventType, setEventType] = useState('');
  const [payloadText, setPayloadText] = useState('');
  const [payloadParsed, setPayloadParsed] = useState<unknown>(undefined);
  const [payloadValid, setPayloadValid] = useState(true);
  // agent
  const [definition, setDefinition] = useState('');
  const [inputText, setInputText] = useState('');
  const [inputParsed, setInputParsed] = useState<unknown>(undefined);
  const [inputValid, setInputValid] = useState(true);
  const [instanceBy, setInstanceBy] = useState('none');
  // script
  const [scriptRef, setScriptRef] = useState('');
  const [grantsText, setGrantsText] = useState('');
  const [grantsParsed, setGrantsParsed] = useState<unknown>(undefined);
  const [grantsValid, setGrantsValid] = useState(true);

  function reset() {
    setId('');
    setDescription('');
    setSchedule('');
    setEnabled('true');
    setKind('publish');
    setEventType('');
    setPayloadText('');
    setDefinition('');
    setInputText('');
    setInstanceBy('none');
    setScriptRef('');
    setGrantsText('');
  }

  /** 按 kind 构造 action（对齐 cli buildCronAction）。返回 null 表示必填缺失。 */
  function buildAction(): Record<string, unknown> | null {
    if (kind === 'publish') {
      if (!eventType.trim()) return null;
      const event: Record<string, unknown> = { type: eventType.trim() };
      if (payloadParsed !== undefined) event.payload = payloadParsed;
      return { kind: 'publish', event };
    }
    if (kind === 'agent') {
      if (!definition.trim()) return null;
      const action: Record<string, unknown> = { kind: 'agent', definition: definition.trim() };
      if (inputParsed !== undefined) action.input = inputParsed;
      if (instanceBy !== 'none') action.instanceBy = instanceBy;
      return action;
    }
    if (!scriptRef.trim()) return null;
    return { kind: 'script', scriptRef: scriptRef.trim(), grants: grantsParsed ?? [] };
  }

  const jsonValid = payloadValid && inputValid && grantsValid;

  async function submit() {
    const action = buildAction();
    if (!id.trim() || !schedule.trim() || !action) return;
    setBusy(true);
    try {
      await api.createCron({
        id: id.trim(),
        description: description.trim(),
        schedule: schedule.trim(),
        enabled: enabled === 'true',
        action,
      });
      toast.success(`定时任务已创建：${id.trim()}`);
      reset();
      onDone();
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>新建定时任务</DialogTitle>
          <DialogDescription>标准五段 cron 表达式 + 三选一动作。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="cron-id">ID</Label>
              <Input
                id="cron-id"
                className="font-mono"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="daily-report"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cron-enabled">启用</Label>
              <Select value={enabled} onValueChange={setEnabled}>
                <SelectTrigger id="cron-enabled" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">enabled</SelectItem>
                  <SelectItem value="false">disabled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cron-schedule">Schedule（五段 cron）</Label>
            <Input
              id="cron-schedule"
              className="font-mono"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              placeholder="0 9 * * *"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cron-desc">描述</Label>
            <Input
              id="cron-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="每天 9 点发日报"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cron-action-kind">动作类型</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as ActionKind)}>
              <SelectTrigger id="cron-action-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="publish">publish — 发布事件</SelectItem>
                <SelectItem value="agent">agent — 起 Agent</SelectItem>
                <SelectItem value="script">script — 跑脚本</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {kind === 'publish' ? (
            <div className="space-y-4 rounded-md border p-3">
              <div className="space-y-2">
                <Label htmlFor="cron-event-type">Event Type</Label>
                <Input
                  id="cron-event-type"
                  className="font-mono"
                  value={eventType}
                  onChange={(e) => setEventType(e.target.value)}
                  placeholder="report.daily"
                />
              </div>
              <JsonField
                id="cron-payload"
                label="Payload（JSON，可选）"
                value={payloadText}
                onChange={setPayloadText}
                onParsed={(p, v) => {
                  setPayloadParsed(p);
                  setPayloadValid(v);
                }}
                rows={3}
              />
            </div>
          ) : kind === 'agent' ? (
            <div className="space-y-4 rounded-md border p-3">
              <div className="space-y-2">
                <Label htmlFor="cron-def">Definition</Label>
                <Input
                  id="cron-def"
                  className="font-mono"
                  value={definition}
                  onChange={(e) => setDefinition(e.target.value)}
                  placeholder="manage/cron"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cron-instance-by">Instance By（可选）</Label>
                <Select value={instanceBy} onValueChange={setInstanceBy}>
                  <SelectTrigger id="cron-instance-by" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">（默认）</SelectItem>
                    <SelectItem value="singleton">singleton</SelectItem>
                    <SelectItem value="event">event</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <JsonField
                id="cron-input"
                label="Input（JSON，可选）"
                value={inputText}
                onChange={setInputText}
                onParsed={(p, v) => {
                  setInputParsed(p);
                  setInputValid(v);
                }}
                rows={3}
              />
            </div>
          ) : (
            <div className="space-y-4 rounded-md border p-3">
              <div className="space-y-2">
                <Label htmlFor="cron-script-ref">Script Ref</Label>
                <Input
                  id="cron-script-ref"
                  className="font-mono"
                  value={scriptRef}
                  onChange={(e) => setScriptRef(e.target.value)}
                  placeholder="scripts/cleanup.js"
                />
              </div>
              <JsonField
                id="cron-grants"
                label="Grants（JSON 数组，可选）"
                value={grantsText}
                onChange={setGrantsText}
                onParsed={(p, v) => {
                  setGrantsParsed(p);
                  setGrantsValid(v);
                }}
                rows={3}
                placeholder='[{"resource":"platform://...","actions":["read"]}]'
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={
              busy || !id.trim() || !schedule.trim() || buildAction() === null || !jsonValid
            }
            onClick={submit}
          >
            {busy ? '创建中…' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** cron 详情：schedule/enabled/action 全字段。 */
function CronDetailDialog({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const { data, loading, error, reload } = useLoad(() => tasksApi.getCron(jobId), [jobId]);
  const job: CronJob | undefined = data?.job;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{jobId}</DialogTitle>
          <DialogDescription>定时任务详情。</DialogDescription>
        </DialogHeader>
        {loading ? (
          <LoadingRows />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : job ? (
          <div className="space-y-4">
            <section className="rounded-md border p-3">
              <DetailRow label="描述">{job.description}</DetailRow>
              <DetailRow label="Schedule">{job.schedule}</DetailRow>
              <DetailRow label="状态">
                <StatusDot
                  tone={job.enabled ? 'success' : 'muted'}
                  label={job.enabled ? 'enabled' : 'disabled'}
                />
              </DetailRow>
              <DetailRow label="动作">{String(job.action.kind)}</DetailRow>
              {job.createdBy ? <DetailRow label="创建者">{job.createdBy}</DetailRow> : null}
            </section>
            <section className="space-y-2">
              <p className="section-label">Action</p>
              <pre className="bg-muted/40 overflow-x-auto rounded-md border p-3 font-mono text-[12px]">
                {JSON.stringify(job.action, null, 2)}
              </pre>
            </section>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** 删除 cron 确认。 */
function DeleteCronDialog({
  jobId,
  onClose,
  onDone,
}: {
  jobId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  async function confirm() {
    if (!jobId) return;
    setBusy(true);
    try {
      await api.deleteCron(jobId);
      toast.success('定时任务已删除');
      onDone();
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AlertDialog open={jobId !== null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除定时任务？</AlertDialogTitle>
          <AlertDialogDescription>
            将永久删除 <span className="data-cell">{jobId}</span>。此操作不可撤销。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>返回</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={confirm}>
            {busy ? '删除中…' : '确认删除'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
