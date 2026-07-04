import { Plus, RefreshCw, Star } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '~/components/page';
import { Badge } from '~/components/ui/badge';
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
import { Switch } from '~/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { useLoad } from '~/hooks/use-load';
import { api, formatError, type ModelProviderPublic } from '~/lib/api';

/**
 * Providers（Proto §9 ModelProviderRegistry）——模型 provider CRUD。
 *
 *  - List → 脱敏投影**不含 secretRef**（永不回显），列表不显示 secretRef 值。
 *  - Write（新增/覆写）：id/vendor/models/priority/secretRef/default/enabled 全字段。
 *  - Update：每行 enabled 开关（patch:{enabled}）。
 *  - SetDefault：每行「设为默认」（全局唯一 default 由后端保证）。
 *  - secretRef 用 datalist：候选 = SecretStore List 名字（读失败静默：空 datalist，仍可手输 env 名）。
 */
export default function ProvidersView() {
  const providers = useLoad(() => api.listProviders(), []);
  // secretRef 候选名（读失败静默：datalist 空，允许手输）。
  const secrets = useLoad(() => api.listSecrets(), []);
  const secretNames = (secrets.data?.items ?? []).map((s) => s.name);
  const [open, setOpen] = useState(false);

  return (
    <>
      <PageHeader
        title="Providers"
        description="模型 provider（§9）：按 priority 选路，secretRef 引用 SecretStore 名字，密钥永不回显。"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={providers.reload}>
              <RefreshCw className="size-4" />
              刷新
            </Button>
            <WriteProviderDialog
              open={open}
              onOpenChange={setOpen}
              secretNames={secretNames}
              onWritten={() => {
                setOpen(false);
                providers.reload();
              }}
            />
          </div>
        }
      />
      {providers.loading ? (
        <LoadingRows />
      ) : providers.error ? (
        <ErrorState error={providers.error} onRetry={providers.reload} />
      ) : !providers.data || providers.data.items.length === 0 ? (
        <EmptyState message="尚无 provider。点击「新增 provider」配置模型渠道。" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>id</TableHead>
                  <TableHead>vendor</TableHead>
                  <TableHead>models</TableHead>
                  <TableHead>priority</TableHead>
                  <TableHead>enabled</TableHead>
                  <TableHead className="text-right">默认</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.data.items.map((p) => (
                  <ProviderRow key={p.id} provider={p} onChanged={providers.reload} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}

function ProviderRow({
  provider,
  onChanged,
}: {
  provider: ModelProviderPublic;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function toggleEnabled() {
    setBusy(true);
    try {
      await api.updateProvider(provider.id, { enabled: !provider.enabled });
      toast.success(`${provider.id} ${provider.enabled ? '已停用' : '已启用'}`);
      onChanged();
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault() {
    setBusy(true);
    try {
      await api.setDefaultProvider(provider.id);
      toast.success(`已将 ${provider.id} 设为默认 provider`);
      onChanged();
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <TableRow>
      <TableCell className="data-cell">
        <span className="inline-flex items-center gap-2">
          {provider.id}
          {provider.default ? (
            <Badge variant="outline" className="text-warning gap-1">
              <Star className="size-3 fill-current" />
              default
            </Badge>
          ) : null}
        </span>
      </TableCell>
      <TableCell className="data-cell text-muted-foreground">{provider.vendor}</TableCell>
      <TableCell className="data-cell text-muted-foreground max-w-[16rem] truncate">
        {provider.models.join(', ')}
      </TableCell>
      <TableCell className="data-cell">{provider.priority}</TableCell>
      <TableCell>
        <Switch checked={provider.enabled} disabled={busy} onCheckedChange={toggleEnabled} />
      </TableCell>
      <TableCell className="text-right">
        <Button variant="ghost" size="sm" disabled={provider.default || busy} onClick={makeDefault}>
          {provider.default ? '当前默认' : '设为默认'}
        </Button>
      </TableCell>
    </TableRow>
  );
}

function WriteProviderDialog({
  open,
  onOpenChange,
  secretNames,
  onWritten,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  secretNames: string[];
  onWritten: () => void;
}) {
  const [id, setId] = useState('');
  const [vendor, setVendor] = useState('anthropic');
  const [models, setModels] = useState('');
  const [priority, setPriority] = useState('10');
  const [secretRef, setSecretRef] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  function reset() {
    setId('');
    setVendor('anthropic');
    setModels('');
    setPriority('10');
    setSecretRef('');
    setIsDefault(false);
    setEnabled(true);
  }

  async function submit() {
    setBusy(true);
    try {
      await api.writeProvider({
        id: id.trim(),
        vendor: vendor.trim(),
        models: models
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean),
        priority: Number(priority) || 0,
        default: isDefault,
        secretRef: secretRef.trim(),
        enabled,
      });
      const savedId = id.trim();
      reset();
      toast.success(`provider ${savedId} 已保存`);
      onWritten();
    } catch (e) {
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
          新增 provider
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>新增 / 覆写 provider</DialogTitle>
          <DialogDescription>
            <code>secretRef</code> 引用 SecretStore 名字或环境变量名（存放 API key）——provider
            本身永不回显密钥。
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="prov-id">id</Label>
            <Input
              id="prov-id"
              className="font-mono"
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="prov-vendor">vendor</Label>
            <Input
              id="prov-vendor"
              className="font-mono"
              placeholder="anthropic"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
            />
          </div>
          <div className="col-span-2 space-y-2">
            <Label htmlFor="prov-models">models（逗号分隔）</Label>
            <Input
              id="prov-models"
              className="font-mono"
              placeholder="glm-5.2, claude-opus-4"
              value={models}
              onChange={(e) => setModels(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="prov-priority">priority</Label>
            <Input
              id="prov-priority"
              type="number"
              className="font-mono"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="prov-secret">secretRef</Label>
            <Input
              id="prov-secret"
              list="provider-secret-names"
              className="font-mono"
              value={secretRef}
              onChange={(e) => setSecretRef(e.target.value)}
            />
            <datalist id="provider-secret-names">
              {secretNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </div>
          <div className="col-span-2 flex items-center gap-6 pt-1">
            <div className="flex items-center gap-2 text-sm">
              <Switch id="prov-enabled" checked={enabled} onCheckedChange={setEnabled} />
              <Label htmlFor="prov-enabled">enabled</Label>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Switch id="prov-default" checked={isDefault} onCheckedChange={setIsDefault} />
              <Label htmlFor="prov-default">设为默认</Label>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button
            onClick={submit}
            disabled={busy || !id.trim() || !vendor.trim() || !secretRef.trim()}
          >
            {busy ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
