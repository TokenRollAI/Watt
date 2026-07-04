import { Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, LoadingRows, PageHeader, StatusDot } from '~/components/page';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
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
import { Textarea } from '~/components/ui/textarea';
import { useLoad } from '~/hooks/use-load';
import {
  ApiError,
  api,
  type ChannelConfig,
  formatError,
  type PluginHealth,
  type PluginManifest,
} from '~/lib/api';

const FEISHU_PLUGIN_ID = 'channel-feishu';

/**
 * Channels（Proto §2.2 ChannelRegistry + §11 Plugin）——渠道列表 + set 表单 + feishu 状态卡。
 *
 *  - channel 列表（channel List）+ 每行 enabled 开关（Update {channelId,patch:{enabled}}）。
 *  - channel set（channel Write 完整 channel：id/adapter/settings JSON/defaultAgent/enabled）。
 *  - feishu 卡片：plugin 注册状态 + health（plugin Get/Health `channel-feishu`）。Get 404 → 未注册引导。
 */
export default function ChannelsView() {
  const channels = useLoad(() => api.listChannels(), []);
  const [open, setOpen] = useState(false);

  return (
    <>
      <PageHeader
        title="Channels"
        description="渠道注册（§2.2）：入站事件路由到默认 agent，出站经 adapter 发回。"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={channels.reload}>
              <RefreshCw className="size-4" />
              刷新
            </Button>
            <WriteChannelDialog
              open={open}
              onOpenChange={setOpen}
              onWritten={() => {
                setOpen(false);
                channels.reload();
              }}
            />
          </div>
        }
      />
      <FeishuCard />
      {channels.loading ? (
        <LoadingRows />
      ) : channels.error ? (
        <ErrorState error={channels.error} onRetry={channels.reload} />
      ) : !channels.data || channels.data.items.length === 0 ? (
        <EmptyState message="尚无渠道。点击「配置渠道」新增。" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>id</TableHead>
                  <TableHead>adapter</TableHead>
                  <TableHead>defaultAgent</TableHead>
                  <TableHead className="text-right">enabled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {channels.data.items.map((ch) => (
                  <ChannelRow key={ch.id} channel={ch} onChanged={channels.reload} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}

function ChannelRow({ channel, onChanged }: { channel: ChannelConfig; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      await api.updateChannel(channel.id, { enabled: !channel.enabled });
      toast.success(`${channel.id} ${channel.enabled ? '已停用' : '已启用'}`);
      onChanged();
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <TableRow>
      <TableCell className="data-cell">{channel.id}</TableCell>
      <TableCell className="data-cell text-muted-foreground">{channel.adapter}</TableCell>
      <TableCell className="data-cell text-muted-foreground">
        {channel.defaultAgent ?? '—'}
      </TableCell>
      <TableCell className="text-right">
        <Switch checked={channel.enabled} disabled={busy} onCheckedChange={toggle} />
      </TableCell>
    </TableRow>
  );
}

function WriteChannelDialog({
  open,
  onOpenChange,
  onWritten,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onWritten: () => void;
}) {
  const [id, setId] = useState('');
  const [adapter, setAdapter] = useState('');
  const [defaultAgent, setDefaultAgent] = useState('');
  const [settings, setSettings] = useState('{}');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  function reset() {
    setId('');
    setAdapter('');
    setDefaultAgent('');
    setSettings('{}');
    setEnabled(true);
  }

  async function submit() {
    let parsedSettings: Record<string, unknown>;
    try {
      parsedSettings = JSON.parse(settings) as Record<string, unknown>;
    } catch {
      toast.error('settings 必须是合法 JSON 对象');
      return;
    }
    setBusy(true);
    try {
      await api.writeChannel({
        id: id.trim(),
        adapter: adapter.trim(),
        settings: parsedSettings,
        enabled,
        ...(defaultAgent.trim() ? { defaultAgent: defaultAgent.trim() } : {}),
      });
      const savedId = id.trim();
      reset();
      toast.success(`渠道 ${savedId} 已保存`);
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
          配置渠道
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>配置 / 覆写渠道</DialogTitle>
          <DialogDescription>
            channel Write（§2.2）：settings 为不透明对象（adapter 自解释），defaultAgent 可空。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="ch-id">id</Label>
              <Input
                id="ch-id"
                className="font-mono"
                value={id}
                onChange={(e) => setId(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ch-adapter">adapter</Label>
              <Input
                id="ch-adapter"
                className="font-mono"
                placeholder="feishu"
                value={adapter}
                onChange={(e) => setAdapter(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ch-agent">defaultAgent（可空）</Label>
            <Input
              id="ch-agent"
              className="font-mono"
              placeholder="manage/platform"
              value={defaultAgent}
              onChange={(e) => setDefaultAgent(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ch-settings">settings（JSON 对象）</Label>
            <Textarea
              id="ch-settings"
              className="font-mono text-xs"
              rows={5}
              value={settings}
              onChange={(e) => setSettings(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Switch id="ch-enabled" checked={enabled} onCheckedChange={setEnabled} />
            <Label htmlFor="ch-enabled">enabled</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy || !id.trim() || !adapter.trim()}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type FeishuState =
  | { status: 'loading' }
  | { status: 'not-registered' }
  | { status: 'error'; message: string }
  | { status: 'ok'; plugin: PluginManifest; health: PluginHealth | null; healthErr: string };

/** feishu plugin 注册/health 状态卡。Get 404 → 未注册引导；其余错误如实显示。 */
function FeishuCard() {
  const [state, setState] = useState<FeishuState>({ status: 'loading' });

  const load = useCallback(() => {
    setState({ status: 'loading' });
    api
      .getPlugin(FEISHU_PLUGIN_ID)
      .then(async ({ plugin }) => {
        // 注册存在 → 再取 health（health 失败不阻塞卡片，单列错误）。
        let health: PluginHealth | null = null;
        let healthErr = '';
        try {
          health = (await api.pluginHealth(FEISHU_PLUGIN_ID)).health;
        } catch (e) {
          healthErr = formatError(e);
        }
        setState({ status: 'ok', plugin, health, healthErr });
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) {
          setState({ status: 'not-registered' });
        } else {
          setState({ status: 'error', message: formatError(e) });
        }
      });
  }, []);

  useEffect(load, [load]);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="text-base">飞书渠道 plugin</CardTitle>
          <CardDescription>
            <code>{FEISHU_PLUGIN_ID}</code> 注册状态与探活
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="size-4" />
          探活
        </Button>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {state.status === 'loading' ? (
          <p className="text-muted-foreground">加载中…</p>
        ) : state.status === 'error' ? (
          <p className="text-destructive">{state.message}</p>
        ) : state.status === 'not-registered' ? (
          <div className="space-y-1 text-muted-foreground">
            <p>
              飞书 plugin（<code>{FEISHU_PLUGIN_ID}</code>）未注册。
            </p>
            <p>
              引导：运行 <code>watt setup feishu</code> 完成注册与连接。
            </p>
          </div>
        ) : (
          <FeishuDetails plugin={state.plugin} health={state.health} healthErr={state.healthErr} />
        )}
      </CardContent>
    </Card>
  );
}

function FeishuDetails({
  plugin,
  health,
  healthErr,
}: {
  plugin: PluginManifest;
  health: PluginHealth | null;
  healthErr: string;
}) {
  const isHttps = plugin.endpoint.startsWith('https://');
  const webhookUrl = isHttps ? `${plugin.endpoint.replace(/\/+$/, '')}/webhook/event` : null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="section-label">注册</span>
        <StatusDot
          tone={plugin.enabled ? 'success' : 'muted'}
          label={plugin.enabled ? 'enabled' : 'disabled'}
        />
        <span className="text-muted-foreground text-xs">
          {plugin.kind} · {plugin.interfaceVersion}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="section-label">探活</span>
        {healthErr ? (
          <span className="text-destructive text-xs">{healthErr}</span>
        ) : health ? (
          <StatusDot
            tone={health.healthy ? 'success' : 'destructive'}
            label={health.healthy ? 'healthy' : 'unhealthy'}
          />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
        {health?.detail ? (
          <span className="text-muted-foreground text-xs">· {health.detail}</span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <span className="section-label">endpoint</span>
        <code className="text-xs">{plugin.endpoint}</code>
      </div>
      {webhookUrl ? (
        <div className="flex items-center gap-2">
          <span className="section-label">webhook</span>
          <code className="text-xs">{webhookUrl}</code>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          endpoint 为平台内绑定（<code>{plugin.endpoint}</code>）——飞书 WS push 型渠道由{' '}
          <code>watt connect feishu</code> 承载长连接，无对外 webhook URL。
        </p>
      )}
    </div>
  );
}
