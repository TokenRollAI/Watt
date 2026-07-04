import { KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react';
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
import { Card, CardContent } from '~/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { useLoad } from '~/hooks/use-load';
import { api, formatError, type SecretMeta } from '~/lib/api';

/**
 * Secrets（Proto §6.6 SecretStore）——平台密钥管理面。
 *
 * 安全纪律（永不持久化/回显明文）：
 *  - value 输入 type=password；提交成功后立即清空本地 name/value state。
 *  - state/console/toast 均不含明文（List/Write 响应本就只回元数据 + shadowedByEnv）。
 *  - shadowedByEnv：存在同名 env 变量会先命中、KV 值不生效（徽记提示）。
 *  - 删除二次确认（AlertDialog）。
 */
export default function SecretsView() {
  const secrets = useLoad(() => api.listSecrets(), []);
  const [open, setOpen] = useState(false);

  return (
    <>
      <PageHeader
        title="Secrets"
        description="平台密钥（KV）：provider secretRef / plugin bearer 引用其 name。值只写不回显。"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={secrets.reload}>
              <RefreshCw className="size-4" />
              刷新
            </Button>
            <WriteSecretDialog
              open={open}
              onOpenChange={setOpen}
              onWritten={() => {
                setOpen(false);
                secrets.reload();
              }}
            />
          </div>
        }
      />
      {secrets.loading ? (
        <LoadingRows />
      ) : secrets.error ? (
        <ErrorState error={secrets.error} onRetry={secrets.reload} />
      ) : !secrets.data || secrets.data.items.length === 0 ? (
        <EmptyState message="尚无密钥。点击「写入密钥」新增。" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>name</TableHead>
                  <TableHead>updatedAt</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {secrets.data.items.map((s) => (
                  <SecretRow key={s.name} secret={s} onChanged={secrets.reload} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <p className="text-muted-foreground text-xs">
        <code>shadowedByEnv</code> 表示存在同名环境变量，会先命中、KV 值不生效。写入后 KV 传播约 1
        分钟生效。
      </p>
    </>
  );
}

function SecretRow({ secret, onChanged }: { secret: SecretMeta; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    try {
      await api.deleteSecret(secret.name);
      toast.success(`已删除密钥 ${secret.name}`);
      setConfirming(false);
      onChanged();
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <TableRow>
      <TableCell className="data-cell">{secret.name}</TableCell>
      <TableCell className="data-cell text-muted-foreground">
        {secret.updatedAt ?? '(env only)'}
      </TableCell>
      <TableCell>
        {secret.shadowedByEnv ? (
          <StatusDot tone="warning" label="env 影子" />
        ) : (
          <StatusDot tone="muted" label="KV" />
        )}
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive"
          onClick={() => setConfirming(true)}
        >
          <Trash2 className="size-4" />
          删除
        </Button>
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除密钥 {secret.name}？</AlertDialogTitle>
              <AlertDialogDescription>
                此操作不可撤销。引用该 secretRef 的 provider / plugin 将解析失败。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy}
                onClick={(e) => {
                  e.preventDefault();
                  void remove();
                }}
              >
                {busy ? '删除中…' : '确认删除'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TableCell>
    </TableRow>
  );
}

function WriteSecretDialog({
  open,
  onOpenChange,
  onWritten,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onWritten: () => void;
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  function reset() {
    setName('');
    setValue('');
  }

  async function submit() {
    setBusy(true);
    try {
      await api.writeSecret(name.trim(), value);
      // 提交成功立即清空明文 state（value 绝不留存/回显）。
      reset();
      toast.success('密钥已写入。KV 传播约 1 分钟生效。');
      onWritten();
    } catch (e) {
      // 失败路径也不回显 value，仅显示错误文案。
      toast.error(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" />
          写入密钥
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4" />
            写入 / 覆写密钥
          </DialogTitle>
          <DialogDescription>
            名字规范：大写字母 / 数字 / 下划线（如 <code>ANTHROPIC_API_KEY</code>）。值只写不回显。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="secret-name">name</Label>
            <Input
              id="secret-name"
              className="font-mono"
              autoComplete="off"
              placeholder="ANTHROPIC_API_KEY"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="secret-value">value（write-only）</Label>
            <Input
              id="secret-value"
              type="password"
              className="font-mono"
              autoComplete="new-password"
              placeholder="明文只发送不回显"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim() || !value}>
            {busy ? '写入中…' : '写入'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
