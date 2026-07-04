import { Play, Plus, RefreshCw, Wrench } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '~/components/page';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
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
import { ScrollArea } from '~/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Separator } from '~/components/ui/separator';
import { Switch } from '~/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs';
import { Textarea } from '~/components/ui/textarea';
import { useLoad } from '~/hooks/use-load';
import { formatError, type ToolMount, type ToolMountInput, toolsApi } from '~/lib/api';
import { cn } from '~/lib/utils';

const PROVIDERS = ['builtin', 'http', 'mcp'];

export default function ToolsView() {
  const mounts = useLoad<{ items: ToolMount[] }>(() => toolsApi.listMounts(), []);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [mountOpen, setMountOpen] = useState(false);

  const items = mounts.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Tools"
        description="工具挂载浏览、能力描述（~help）与调用（ToolRegistry §5.2 + ToolProvider §5.1）。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={mounts.reload}>
              <RefreshCw className="size-4" />
              刷新
            </Button>
            <Dialog open={mountOpen} onOpenChange={setMountOpen}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="size-4" />
                  挂载
                </Button>
              </DialogTrigger>
              <MountDialog
                onDone={() => {
                  setMountOpen(false);
                  mounts.reload();
                }}
              />
            </Dialog>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
        {/* 左：工具挂载树 */}
        <div className="rounded-md border">
          <div className="section-label px-3 py-2">Mounts</div>
          <Separator />
          <ScrollArea className="h-[calc(100vh-16rem)]">
            {mounts.loading ? (
              <p className="text-muted-foreground p-3 text-sm">加载中…</p>
            ) : mounts.error ? (
              <p className="text-destructive p-3 text-sm">{mounts.error}</p>
            ) : items.length === 0 ? (
              <p className="text-muted-foreground p-3 text-sm">无挂载。点击「挂载」新建。</p>
            ) : (
              <ul className="p-1">
                {items.map((m) => (
                  <li key={m.path}>
                    <button
                      type="button"
                      onClick={() => setSelectedPath(m.path)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors',
                        selectedPath === m.path
                          ? 'bg-accent text-accent-foreground'
                          : 'hover:bg-muted',
                        m.enabled ? '' : 'opacity-50',
                      )}
                    >
                      <Wrench className="text-muted-foreground size-4 shrink-0" />
                      <span className="font-mono truncate">{m.path}</span>
                      <Badge variant="outline" className="ml-auto text-[10px]">
                        {m.provider}
                      </Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </div>

        {/* 右：describe + call */}
        {selectedPath ? (
          <ToolPane
            key={selectedPath}
            mount={
              items.find((m) => m.path === selectedPath) ?? {
                path: selectedPath,
                provider: '?',
                enabled: true,
              }
            }
          />
        ) : (
          <div className="text-muted-foreground flex h-64 items-center justify-center rounded-md border border-dashed text-sm">
            选择左侧工具挂载以查看能力与调用
          </div>
        )}
      </div>
    </>
  );
}

/** 单挂载面板：describe（~help）Tab + call 调用 Tab。 */
function ToolPane({ mount }: { mount: ToolMount }) {
  const path = mount.path;
  return (
    <div className="min-w-0 rounded-md border">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="font-mono text-sm font-medium">{path}</span>
        <Badge variant="outline" className="text-[10px]">
          {mount.provider}
        </Badge>
        {mount.enabled ? null : (
          <Badge variant="secondary" className="text-[10px]">
            已禁用
          </Badge>
        )}
      </div>
      <Separator />
      <Tabs defaultValue="describe" className="p-3">
        <TabsList>
          <TabsTrigger value="describe">Describe</TabsTrigger>
          <TabsTrigger value="call">Call</TabsTrigger>
        </TabsList>
        <TabsContent value="describe">
          <DescribePane path={path} />
        </TabsContent>
        <TabsContent value="call">
          <CallPane path={path} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** describe → GET ~help，渲染 HTBP DSL 文本代码块。 */
function DescribePane({ path }: { path: string }) {
  const help = useLoad<string>(() => toolsApi.describe(path), [path]);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="section-label">HTBP ~help</span>
        <Button variant="ghost" size="sm" onClick={help.reload}>
          <RefreshCw className="size-4" />
          刷新
        </Button>
      </div>
      {help.loading ? (
        <p className="text-muted-foreground text-sm">加载中…</p>
      ) : help.error ? (
        <p className="text-destructive text-sm">{help.error}</p>
      ) : (
        <pre className="bg-muted max-h-[calc(100vh-22rem)] overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
          {help.data || '（空）'}
        </pre>
      )}
    </div>
  );
}

/** call → POST /htbp/tools/<path>/<tool> {arguments}，结果 pretty 展示。 */
function CallPane({ path }: { path: string }) {
  const [toolName, setToolName] = useState('');
  const [argsText, setArgsText] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [resource, setResource] = useState<string | undefined>();

  const run = async () => {
    if (!toolName.trim()) {
      toast.error('工具名必填（URL end-path 段定位）');
      return;
    }
    let args: Record<string, unknown>;
    try {
      args = argsText.trim() ? (JSON.parse(argsText) as Record<string, unknown>) : {};
    } catch {
      toast.error('arguments 不是合法 JSON');
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const out = await toolsApi.call(path, toolName.trim(), args);
      setResource(out.resource);
      setResult(JSON.stringify(out.result, null, 2));
      toast.success('调用成功');
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="tool-name">工具名</Label>
        <Input
          id="tool-name"
          value={toolName}
          onChange={(e) => setToolName(e.target.value)}
          placeholder="forecast"
          className="font-mono"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="tool-args">arguments（JSON 信封）</Label>
        <Textarea
          id="tool-args"
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          className="font-mono text-xs"
          rows={8}
        />
      </div>
      <Button onClick={run} disabled={busy}>
        <Play className="size-4" />
        {busy ? '调用中…' : '调用'}
      </Button>
      {result !== null ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="section-label">结果</span>
            {resource ? (
              <Badge variant="outline" className="text-[10px]">
                {resource}
              </Badge>
            ) : null}
          </div>
          <pre className="bg-muted max-h-[calc(100vh-30rem)] overflow-auto rounded-md p-3 font-mono text-xs">
            {result}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

/** 挂载工具 provider 表单（Dialog）。http 的 providerConfig 须是 HttpEndpointConfig {endpoints:[...]}。 */
function MountDialog({ onDone }: { onDone: () => void }) {
  const [path, setPath] = useState('');
  const [provider, setProvider] = useState('builtin');
  const [enabled, setEnabled] = useState(true);
  const [providerConfig, setProviderConfig] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!path.trim()) {
      toast.error('挂载路径必填');
      return;
    }
    const input: ToolMountInput = { path: path.trim(), provider, enabled };
    if (providerConfig.trim()) {
      try {
        input.providerConfig = JSON.parse(providerConfig) as Record<string, unknown>;
      } catch {
        toast.error('providerConfig 不是合法 JSON');
        return;
      }
    } else if (provider === 'http') {
      toast.error('http provider 需要 providerConfig（HttpEndpointConfig {endpoints:[...]}）');
      return;
    }
    setBusy(true);
    try {
      await toolsApi.mount(input);
      toast.success(`已挂载 ${input.path}`);
      onDone();
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle className="font-mono">挂载工具</DialogTitle>
        <DialogDescription>ToolRegistry.Write（幂等 upsert）。</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="mp">挂载路径</Label>
            <Input
              id="mp"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="weather"
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mprov">Provider</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger id="mprov">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="me">启用</Label>
          <Switch id="me" checked={enabled} onCheckedChange={setEnabled} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mpc">
            providerConfig（JSON{provider === 'http' ? '，必填' : '，可选'}）
          </Label>
          <Textarea
            id="mpc"
            value={providerConfig}
            onChange={(e) => setProviderConfig(e.target.value)}
            placeholder={
              provider === 'http'
                ? '{"endpoints":[{"name":"forecast","url":"https://api.example/f"}]}'
                : '{}'
            }
            className="font-mono text-xs"
            rows={5}
          />
        </div>
      </div>
      <DialogFooter>
        <Button onClick={submit} disabled={busy}>
          {busy ? '挂载中…' : '挂载'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
