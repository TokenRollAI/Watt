import { Copy, Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, LoadingRows, PageHeader, StatusDot } from '~/components/page';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Switch } from '~/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { Textarea } from '~/components/ui/textarea';
import { useLoad } from '~/hooks/use-load';
import { api, formatError, type PluginManifest } from '~/lib/api';
import { type PluginRegistration, registerPlugin } from '~/lib/api/config.ts';

const PLUGIN_KINDS = [
  'context-provider',
  'tool-provider',
  'channel-adapter',
  'agent-harness',
] as const;

/**
 * Plugins（Proto §11.1 PluginRegistry + §11.2 PluginLifecycle.Health）——通用插件管理。
 *
 *  - List：全部 manifest（kind/interfaceVersion/endpoint/enabled）。
 *  - Health：每行探活按钮（plugin Health）。
 *  - Register（Dialog）：manifest 表单（对照 cli/src/plugin.ts）。响应 registration 含 pluginToken
 *    ——仅注册响应回传一次，用独立提示卡展示并要求保存（关闭后不再可见）。
 */
export default function PluginsView() {
  const plugins = useLoad(() => api.listPlugins(), []);
  const [open, setOpen] = useState(false);

  return (
    <>
      <PageHeader
        title="Plugins"
        description="插件注册（§11）：四类契约 context/tool/channel/agent-harness。pluginToken 仅注册时回传一次。"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={plugins.reload}>
              <RefreshCw className="size-4" />
              刷新
            </Button>
            <RegisterPluginDialog
              open={open}
              onOpenChange={setOpen}
              onRegistered={() => {
                setOpen(false);
                plugins.reload();
              }}
            />
          </div>
        }
      />
      {plugins.loading ? (
        <LoadingRows />
      ) : plugins.error ? (
        <ErrorState error={plugins.error} onRetry={plugins.reload} />
      ) : !plugins.data || plugins.data.items.length === 0 ? (
        <EmptyState message="尚无插件。点击「注册插件」新增。" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>id</TableHead>
                  <TableHead>kind</TableHead>
                  <TableHead>interfaceVersion</TableHead>
                  <TableHead>endpoint</TableHead>
                  <TableHead>enabled</TableHead>
                  <TableHead className="text-right">探活</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plugins.data.items.map((p) => (
                  <PluginRow key={p.id} plugin={p} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}

function PluginRow({ plugin }: { plugin: PluginManifest }) {
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<{ healthy: boolean; detail?: string } | null>(null);

  async function probe() {
    setBusy(true);
    try {
      const { health: h } = await api.pluginHealth(plugin.id);
      setHealth(h);
      toast[h.healthy ? 'success' : 'error'](
        `${plugin.id}: ${h.healthy ? 'healthy' : 'unhealthy'}${h.detail ? ` · ${h.detail}` : ''}`,
      );
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <TableRow>
      <TableCell className="data-cell">{plugin.id}</TableCell>
      <TableCell>
        <Badge variant="outline" className="font-mono text-xs">
          {plugin.kind}
        </Badge>
      </TableCell>
      <TableCell className="data-cell text-muted-foreground">{plugin.interfaceVersion}</TableCell>
      <TableCell className="data-cell text-muted-foreground max-w-[16rem] truncate">
        {plugin.endpoint}
      </TableCell>
      <TableCell>
        <StatusDot
          tone={plugin.enabled ? 'success' : 'muted'}
          label={plugin.enabled ? 'enabled' : 'disabled'}
        />
      </TableCell>
      <TableCell className="text-right">
        <span className="inline-flex items-center gap-2">
          {health ? (
            <StatusDot
              tone={health.healthy ? 'success' : 'destructive'}
              label={health.healthy ? 'healthy' : 'unhealthy'}
            />
          ) : null}
          <Button variant="ghost" size="sm" disabled={busy} onClick={probe}>
            {busy ? '探活中…' : '探活'}
          </Button>
        </span>
      </TableCell>
    </TableRow>
  );
}

function RegisterPluginDialog({
  open,
  onOpenChange,
  onRegistered,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onRegistered: () => void;
}) {
  const [id, setId] = useState('');
  const [kind, setKind] = useState<string>('tool-provider');
  const [interfaceVersion, setInterfaceVersion] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [healthPath, setHealthPath] = useState('/health');
  const [secretRef, setSecretRef] = useState('');
  const [grants, setGrants] = useState('[]');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  // 注册成功后 pluginToken 只展示一次；关闭卡片即丢弃（组件卸载 state 清空）。
  const [registration, setRegistration] = useState<PluginRegistration | null>(null);

  function resetForm() {
    setId('');
    setKind('tool-provider');
    setInterfaceVersion('');
    setEndpoint('');
    setHealthPath('/health');
    setSecretRef('');
    setGrants('[]');
    setEnabled(true);
  }

  async function submit() {
    let parsedGrants: unknown;
    try {
      parsedGrants = JSON.parse(grants);
    } catch {
      toast.error('requiredGrants 必须是合法 JSON 数组');
      return;
    }
    if (!Array.isArray(parsedGrants)) {
      toast.error('requiredGrants 必须是 JSON 数组');
      return;
    }
    // manifest 形状真源：cli/src/plugin.ts——auth 无 secretRef 时为 platform-token。
    const manifest = {
      id: id.trim(),
      kind,
      interfaceVersion: interfaceVersion.trim(),
      endpoint: endpoint.trim(),
      auth: secretRef.trim()
        ? { kind: 'bearer', secretRef: secretRef.trim() }
        : { kind: 'platform-token' },
      requiredGrants: parsedGrants,
      healthPath: healthPath.trim() || '/health',
      enabled,
    };
    setBusy(true);
    try {
      const reg = await registerPlugin(manifest);
      resetForm();
      setRegistration(reg);
      toast.success(`插件 ${reg.id} 已注册`);
      onRegistered();
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (!registration) return;
    try {
      await navigator.clipboard.writeText(registration.pluginToken);
      toast.success('pluginToken 已复制');
    } catch {
      toast.error('复制失败，请手动选择文本');
    }
  }

  function handleOpenChange(v: boolean) {
    if (!v) {
      resetForm();
      setRegistration(null);
    }
    onOpenChange(v);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" />
          注册插件
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        {registration ? (
          <>
            <DialogHeader>
              <DialogTitle>插件 {registration.id} 已注册</DialogTitle>
              <DialogDescription>
                pluginToken 仅此一次可见，关闭后无法再取回——请立即保存到插件侧配置。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <div className="space-y-1">
                <span className="section-label">pluginToken</span>
                <div className="flex items-start gap-2">
                  <code className="bg-muted flex-1 rounded-md p-2 text-xs break-all">
                    {registration.pluginToken}
                  </code>
                  <Button variant="outline" size="icon" onClick={copyToken} aria-label="复制 token">
                    <Copy className="size-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <span className="section-label">platformBaseUrl</span>
                <code className="text-xs">{registration.platformBaseUrl}</code>
              </div>
              <div className="space-y-1">
                <span className="section-label">jwksUrl</span>
                <code className="text-xs break-all">{registration.jwksUrl}</code>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => handleOpenChange(false)}>我已保存，关闭</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>注册插件</DialogTitle>
              <DialogDescription>
                字段对照 <code>watt plugin register</code>。endpoint 支持 HTTPS base URL 或{' '}
                <code>binding:&lt;NAME&gt;</code>（同账户 service binding）。
              </DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="pl-id">id</Label>
                <Input
                  id="pl-id"
                  className="font-mono"
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pl-kind">kind</Label>
                <Select value={kind} onValueChange={setKind}>
                  <SelectTrigger id="pl-kind" className="w-full font-mono">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PLUGIN_KINDS.map((k) => (
                      <SelectItem key={k} value={k} className="font-mono">
                        {k}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="pl-iface">interfaceVersion</Label>
                <Input
                  id="pl-iface"
                  className="font-mono"
                  placeholder="tool-provider/v1"
                  value={interfaceVersion}
                  onChange={(e) => setInterfaceVersion(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pl-health">healthPath</Label>
                <Input
                  id="pl-health"
                  className="font-mono"
                  value={healthPath}
                  onChange={(e) => setHealthPath(e.target.value)}
                />
              </div>
              <div className="col-span-2 space-y-2">
                <Label htmlFor="pl-endpoint">endpoint</Label>
                <Input
                  id="pl-endpoint"
                  className="font-mono"
                  placeholder="https://plugin.example.com 或 binding:MY_PLUGIN"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                />
              </div>
              <div className="col-span-2 space-y-2">
                <Label htmlFor="pl-secret">secretRef（可空 → platform-token 认证）</Label>
                <Input
                  id="pl-secret"
                  className="font-mono"
                  value={secretRef}
                  onChange={(e) => setSecretRef(e.target.value)}
                />
              </div>
              <div className="col-span-2 space-y-2">
                <Label htmlFor="pl-grants">requiredGrants（JSON 数组）</Label>
                <Textarea
                  id="pl-grants"
                  className="font-mono text-xs"
                  rows={3}
                  placeholder='[{"resources":["platform://scheduler"],"actions":["manage"]}]'
                  value={grants}
                  onChange={(e) => setGrants(e.target.value)}
                />
              </div>
              <div className="col-span-2 flex items-center gap-2 text-sm">
                <Switch id="pl-enabled" checked={enabled} onCheckedChange={setEnabled} />
                <Label htmlFor="pl-enabled">enabled</Label>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>
                取消
              </Button>
              <Button
                onClick={submit}
                disabled={busy || !id.trim() || !interfaceVersion.trim() || !endpoint.trim()}
              >
                {busy ? '注册中…' : '注册'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
