import { Link2, Plus, RefreshCw, Trash2 } from 'lucide-react';
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
import { useLoad } from '~/hooks/use-load';
import { formatError } from '~/lib/api';
import { policiesApi } from '~/lib/api/policies.ts';

/**
 * Policies 视图（视图族 C）：List（filter subject）+ Add（Dialog）+ Delete（确认）
 * + MapIdentity（外部身份 → principal 映射表单）。
 * effect allow/deny 用 StatusDot。形状真源：packages/cli/src/policy.ts。
 */
export default function PoliciesView() {
  const [subject, setSubject] = useState('');
  const [subjectFilter, setSubjectFilter] = useState('');
  const { data, error, loading, reload } = useLoad(
    () => policiesApi.listPolicies(subjectFilter || undefined),
    [subjectFilter],
  );
  const [addOpen, setAddOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Policies"
        description="访问控制策略与外部身份映射。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setMapOpen(true)}>
              <Link2 className="size-4" />
              身份映射
            </Button>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" />
              新增策略
            </Button>
          </>
        }
      />

      <div className="flex items-end gap-2">
        <div className="space-y-2">
          <Label htmlFor="filter-subject">按 subject 过滤</Label>
          <Input
            id="filter-subject"
            className="w-64 font-mono"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && setSubjectFilter(subject.trim())}
            placeholder="user:alice"
          />
        </div>
        <Button variant="outline" size="sm" onClick={() => setSubjectFilter(subject.trim())}>
          过滤
        </Button>
        {subjectFilter ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSubject('');
              setSubjectFilter('');
            }}
          >
            清除
          </Button>
        ) : null}
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={reload}>
          <RefreshCw className="size-4" />
          刷新
        </Button>
      </div>

      {loading ? (
        <LoadingRows />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState message="暂无策略。点击「新增策略」创建一条。" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Effect</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Resource</TableHead>
              <TableHead>Actions</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <StatusDot
                    tone={p.effect === 'allow' ? 'success' : 'destructive'}
                    label={p.effect}
                  />
                </TableCell>
                <TableCell className="data-cell">{p.subject}</TableCell>
                <TableCell className="data-cell">{p.resource}</TableCell>
                <TableCell className="data-cell text-muted-foreground">
                  {p.actions.join(', ')}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDeleteId(p.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <AddPolicyDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onDone={() => {
          setAddOpen(false);
          reload();
        }}
      />
      <MapIdentityDialog open={mapOpen} onOpenChange={setMapOpen} />
      <DeletePolicyDialog
        policyId={deleteId}
        onClose={() => setDeleteId(null)}
        onDone={() => {
          setDeleteId(null);
          reload();
        }}
      />
    </div>
  );
}

/** 新增策略：principal(subject)/resource/actions/effect。 */
function AddPolicyDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const [subject, setSubject] = useState('');
  const [resource, setResource] = useState('');
  const [actions, setActions] = useState('');
  const [effect, setEffect] = useState<'allow' | 'deny'>('allow');
  const [busy, setBusy] = useState(false);

  function reset() {
    setSubject('');
    setResource('');
    setActions('');
    setEffect('allow');
  }

  async function submit() {
    const actionList = actions
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    if (!subject.trim() || !resource.trim() || actionList.length === 0) return;
    setBusy(true);
    try {
      // id 由客户端生成（与 CLI policyAdd 一致：pol-<uuid>）。
      await policiesApi.writePolicy({
        id: `pol-${crypto.randomUUID()}`,
        subject: subject.trim(),
        resource: resource.trim(),
        actions: actionList,
        effect,
      });
      toast.success('策略已新增');
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新增策略</DialogTitle>
          <DialogDescription>授予或拒绝某 principal 对资源执行的动作。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pol-subject">Principal（subject）</Label>
            <Input
              id="pol-subject"
              className="font-mono"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="user:alice"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pol-resource">Resource</Label>
            <Input
              id="pol-resource"
              className="font-mono"
              value={resource}
              onChange={(e) => setResource(e.target.value)}
              placeholder="platform://scheduler"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pol-actions">Actions（逗号分隔，或 *）</Label>
            <Input
              id="pol-actions"
              className="font-mono"
              value={actions}
              onChange={(e) => setActions(e.target.value)}
              placeholder="read, manage"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pol-effect">Effect</Label>
            <Select value={effect} onValueChange={(v) => setEffect(v as 'allow' | 'deny')}>
              <SelectTrigger id="pol-effect" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">allow</SelectItem>
                <SelectItem value="deny">deny</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={busy || !subject.trim() || !resource.trim() || !actions.trim()}
            onClick={submit}
          >
            {busy ? '提交中…' : '新增'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 身份映射：外部渠道身份 → principal。 */
function MapIdentityDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [channel, setChannel] = useState('');
  const [channelUserId, setChannelUserId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!channel.trim() || !channelUserId.trim() || !principal.trim()) return;
    setBusy(true);
    try {
      const r = await policiesApi.mapIdentity({
        channel: channel.trim(),
        channelUserId: channelUserId.trim(),
        principal: principal.trim(),
      });
      toast.success(`已映射 ${r.channelUserId} → ${r.principal}`);
      setChannel('');
      setChannelUserId('');
      setPrincipal('');
      onOpenChange(false);
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
          <DialogTitle>身份映射</DialogTitle>
          <DialogDescription>
            将某渠道下的外部用户绑定到平台 principal（IdentityMapper，§6.3）。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="map-channel">Channel</Label>
            <Input
              id="map-channel"
              className="font-mono"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              placeholder="feishu"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="map-user">Channel User ID</Label>
            <Input
              id="map-user"
              className="font-mono"
              value={channelUserId}
              onChange={(e) => setChannelUserId(e.target.value)}
              placeholder="ou_xxx"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="map-principal">Principal</Label>
            <Input
              id="map-principal"
              className="font-mono"
              value={principal}
              onChange={(e) => setPrincipal(e.target.value)}
              placeholder="user:alice"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={busy || !channel.trim() || !channelUserId.trim() || !principal.trim()}
            onClick={submit}
          >
            {busy ? '映射中…' : '映射'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 删除策略确认。 */
function DeletePolicyDialog({
  policyId,
  onClose,
  onDone,
}: {
  policyId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  async function confirm() {
    if (!policyId) return;
    setBusy(true);
    try {
      await policiesApi.deletePolicy(policyId);
      toast.success('策略已删除');
      onDone();
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AlertDialog open={policyId !== null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除策略？</AlertDialogTitle>
          <AlertDialogDescription>
            将永久删除策略 <span className="data-cell">{policyId}</span>。此操作不可撤销。
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
