import { Ban, Play, RefreshCw } from 'lucide-react';
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
import { DetailRow, JsonField, TaskStateBadge } from '~/components/view-c-parts';
import { useLoad } from '~/hooks/use-load';
import { api, formatError } from '~/lib/api';
import { type TaskDetail, tasksApi } from '~/lib/api/tasks.ts';

/**
 * Tasks 视图（视图族 C）：List（七态徽记）+ Get 详情（Dialog：checkpoints/steps/结果）
 * + Run（选 def + input JSON → task Write）+ Signal（checkpoint 决策）+ Cancel（确认）。
 */
export default function TasksView() {
  const { data, error, loading, reload } = useLoad(() => api.listTasks(), []);
  const [runOpen, setRunOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tasks"
        description="Workflow 任务：运行、审批 checkpoint、取消。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={reload}>
              <RefreshCw className="size-4" />
              刷新
            </Button>
            <Button size="sm" onClick={() => setRunOpen(true)}>
              <Play className="size-4" />
              运行任务
            </Button>
          </>
        }
      />

      {loading ? (
        <LoadingRows />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState message="暂无任务。点击「运行任务」从定义启动一个。" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Task ID</TableHead>
              <TableHead>定义</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>创建者</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((t) => (
              <TableRow key={t.taskId}>
                <TableCell className="data-cell">{t.taskId}</TableCell>
                <TableCell className="data-cell">{t.definition}</TableCell>
                <TableCell>
                  <TaskStateBadge state={t.state} />
                </TableCell>
                <TableCell className="data-cell text-muted-foreground">
                  {t.createdBy ?? '-'}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => setDetailId(t.taskId)}>
                    详情
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setCancelId(t.taskId)}
                  >
                    <Ban className="size-4" />
                    取消
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <RunTaskDialog
        open={runOpen}
        onOpenChange={setRunOpen}
        onDone={() => {
          setRunOpen(false);
          reload();
        }}
      />
      {detailId ? (
        <TaskDetailDialog
          taskId={detailId}
          onClose={() => setDetailId(null)}
          onSignalled={reload}
        />
      ) : null}
      <CancelTaskDialog
        taskId={cancelId}
        onClose={() => setCancelId(null)}
        onDone={() => {
          setCancelId(null);
          reload();
        }}
      />
    </div>
  );
}

/** 运行任务：ListDefinitions 选 def + input JSON textarea → task Write。 */
function RunTaskDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const { data: defs, loading, error } = useLoad(() => tasksApi.listTaskDefs(), [open]);
  const [definition, setDefinition] = useState('');
  const [inputText, setInputText] = useState('');
  const [inputParsed, setInputParsed] = useState<unknown>(undefined);
  const [inputValid, setInputValid] = useState(true);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!definition) return;
    setBusy(true);
    try {
      const t = await tasksApi.runTask({
        definition,
        ...(inputParsed !== undefined ? { input: inputParsed } : {}),
      });
      toast.success(`任务已启动：${t.task.taskId}`);
      setDefinition('');
      setInputText('');
      onDone();
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>运行任务</DialogTitle>
          <DialogDescription>选择任务定义并提供输入（JSON，可选）。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="run-definition">任务定义</Label>
            {loading ? (
              <LoadingRows rows={1} />
            ) : error ? (
              <ErrorState error={error} />
            ) : (
              <Select value={definition} onValueChange={setDefinition}>
                <SelectTrigger id="run-definition" className="w-full">
                  <SelectValue placeholder="选择一个定义…" />
                </SelectTrigger>
                <SelectContent>
                  {(defs?.items ?? []).map((d) => (
                    <SelectItem key={d.name} value={d.name}>
                      <span className="font-mono">{d.name}</span>
                      <span className="text-muted-foreground">{d.description}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <JsonField
            id="run-input"
            label="Input（JSON，可选）"
            value={inputText}
            onChange={setInputText}
            onParsed={(p, valid) => {
              setInputParsed(p);
              setInputValid(valid);
            }}
            placeholder='{"key": "value"}'
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={busy || !definition || !inputValid} onClick={submit}>
            {busy ? '启动中…' : '运行'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 任务详情：steps / pendingCheckpoint（决策）/ artifacts。 */
function TaskDetailDialog({
  taskId,
  onClose,
  onSignalled,
}: {
  taskId: string;
  onClose: () => void;
  onSignalled: () => void;
}) {
  const { data, loading, error, reload } = useLoad(() => tasksApi.getTask(taskId), [taskId]);
  const task = data?.task;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{taskId}</DialogTitle>
          <DialogDescription>任务详情、步骤与审批 checkpoint。</DialogDescription>
        </DialogHeader>
        {loading ? (
          <LoadingRows />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : task ? (
          <div className="space-y-5">
            <section className="rounded-md border p-3">
              <DetailRow label="定义">{task.definition}</DetailRow>
              <DetailRow label="状态">
                <TaskStateBadge state={task.state} />
              </DetailRow>
              {task.currentStep ? <DetailRow label="当前步骤">{task.currentStep}</DetailRow> : null}
              <DetailRow label="创建者">{task.createdBy}</DetailRow>
              <DetailRow label="创建于">{task.createdAt}</DetailRow>
              {task.note ? <DetailRow label="备注">{task.note}</DetailRow> : null}
            </section>

            {task.pendingCheckpoint ? (
              <CheckpointPanel
                taskId={taskId}
                checkpoint={task.pendingCheckpoint}
                onSignalled={() => {
                  reload();
                  onSignalled();
                }}
              />
            ) : null}

            <section className="space-y-2">
              <p className="section-label">步骤（{task.steps.length}）</p>
              {task.steps.length === 0 ? (
                <EmptyState message="暂无步骤记录。" />
              ) : (
                <div className="space-y-1.5">
                  {task.steps.map((s, i) => (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: 步骤序列无稳定 id，序号即语义。
                      key={`${s.name}-${i}`}
                      className="flex items-center justify-between rounded-md border px-3 py-2"
                    >
                      <span className="data-cell">{s.name}</span>
                      <StatusDot
                        tone={
                          s.state === 'completed'
                            ? 'success'
                            : s.state === 'running'
                              ? 'warning'
                              : s.state === 'failed'
                                ? 'destructive'
                                : 'muted'
                        }
                        label={s.state}
                      />
                    </div>
                  ))}
                </div>
              )}
            </section>

            {task.artifacts.length > 0 ? (
              <section className="space-y-2">
                <p className="section-label">产物（{task.artifacts.length}）</p>
                <ul className="space-y-1">
                  {task.artifacts.map((a) => (
                    <li key={a} className="data-cell break-all">
                      {a}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** pendingCheckpoint 决策面板：approve / reject / 自定义 decision + payload。 */
function CheckpointPanel({
  taskId,
  checkpoint,
  onSignalled,
}: {
  taskId: string;
  checkpoint: NonNullable<TaskDetail['pendingCheckpoint']>;
  onSignalled: () => void;
}) {
  const [custom, setCustom] = useState('');
  const [payloadText, setPayloadText] = useState('');
  const [payloadParsed, setPayloadParsed] = useState<unknown>(undefined);
  const [payloadValid, setPayloadValid] = useState(true);
  const [busy, setBusy] = useState(false);

  async function signal(decision: string) {
    if (!decision) return;
    setBusy(true);
    try {
      await tasksApi.signalTask(taskId, {
        checkpoint: checkpoint.checkpoint,
        decision,
        ...(payloadParsed !== undefined ? { payload: payloadParsed } : {}),
      });
      toast.success(`已提交决策：${decision}`);
      onSignalled();
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-warning/40 bg-warning/5 space-y-3 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <StatusDot tone="warning" label="待审批" />
        <span className="data-cell">{checkpoint.checkpoint}</span>
      </div>
      <p className="text-sm">{checkpoint.prompt}</p>
      <JsonField
        id="signal-payload"
        label="决策 payload（JSON，可选）"
        value={payloadText}
        onChange={setPayloadText}
        onParsed={(p, valid) => {
          setPayloadParsed(p);
          setPayloadValid(valid);
        }}
        rows={3}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || !payloadValid} onClick={() => signal('approve')}>
          批准
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={busy || !payloadValid}
          onClick={() => signal('reject')}
        >
          拒绝
        </Button>
        <div className="flex items-center gap-2">
          <Input
            className="h-8 w-40 font-mono"
            placeholder="自定义 decision"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !custom.trim() || !payloadValid}
            onClick={() => signal(custom.trim())}
          >
            提交
          </Button>
        </div>
      </div>
    </section>
  );
}

/** 取消任务确认（alert-dialog + 可选 reason）。 */
function CancelTaskDialog({
  taskId,
  onClose,
  onDone,
}: {
  taskId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (!taskId) return;
    setBusy(true);
    try {
      await tasksApi.cancelTask(taskId, reason.trim() || undefined);
      toast.success('任务已取消');
      setReason('');
      onDone();
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={taskId !== null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>取消任务？</AlertDialogTitle>
          <AlertDialogDescription>
            将请求终止任务 <span className="data-cell">{taskId}</span>。此操作不可撤销。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor="cancel-reason">原因（可选）</Label>
          <Input
            id="cancel-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="记录取消原因"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>返回</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={confirm}>
            {busy ? '取消中…' : '确认取消'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
