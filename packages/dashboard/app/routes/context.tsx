import { FolderTree, Plus, RefreshCw, Unplug } from 'lucide-react';
import { useCallback, useState } from 'react';
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
import { Textarea } from '~/components/ui/textarea';
import { useLoad } from '~/hooks/use-load';
import {
  type ContextEntry,
  type ContextEntryMeta,
  type ContextMountInput,
  contextApi,
  formatError,
  type NamespaceMount,
} from '~/lib/api';
import { cn } from '~/lib/utils';

/** JSON 内容尝试 pretty；非 JSON 原样返回。 */
function prettyContent(value: unknown, contentType?: string): string {
  if (typeof value === 'object' && value !== null) return JSON.stringify(value, null, 2);
  const s = typeof value === 'string' ? value : String(value);
  if (contentType?.includes('json') || (s.trim().startsWith('{') && s.trim().endsWith('}'))) {
    try {
      return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
      return s;
    }
  }
  return s;
}

/** 条目 uri 末段（去 namespace/前缀）作显示名。 */
function entryLeaf(uri: string): string {
  const parts = uri.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? uri;
}

const PROVIDERS = ['structured', 'object', 'vector'];

export default function ContextView() {
  const mounts = useLoad<{ items: NamespaceMount[] }>(() => contextApi.listMounts(), []);
  const [selectedNs, setSelectedNs] = useState<string | null>(null);
  const [mountOpen, setMountOpen] = useState(false);

  const nsList = mounts.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Context"
        description="命名空间挂载与条目浏览器（ContextRegistry §4.2 + ContextProvider §4.1）。"
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
        {/* 左：namespace 列表 */}
        <div className="rounded-md border">
          <div className="section-label px-3 py-2">Namespaces</div>
          <Separator />
          <ScrollArea className="h-[calc(100vh-16rem)]">
            {mounts.loading ? (
              <p className="text-muted-foreground p-3 text-sm">加载中…</p>
            ) : mounts.error ? (
              <p className="text-destructive p-3 text-sm">{mounts.error}</p>
            ) : nsList.length === 0 ? (
              <p className="text-muted-foreground p-3 text-sm">无挂载。点击「挂载」新建。</p>
            ) : (
              <ul className="p-1">
                {nsList.map((m) => (
                  <li key={m.namespace}>
                    <button
                      type="button"
                      onClick={() => setSelectedNs(m.namespace)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors',
                        selectedNs === m.namespace
                          ? 'bg-accent text-accent-foreground'
                          : 'hover:bg-muted',
                      )}
                    >
                      <FolderTree className="text-muted-foreground size-4 shrink-0" />
                      <span className="font-mono truncate">{m.namespace}</span>
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

        {/* 右：条目浏览 + 详情 */}
        {selectedNs ? (
          <NamespacePane
            key={selectedNs}
            mount={
              nsList.find((m) => m.namespace === selectedNs) ?? {
                namespace: selectedNs,
                provider: '?',
              }
            }
            onUnmounted={() => {
              setSelectedNs(null);
              mounts.reload();
            }}
          />
        ) : (
          <div className="text-muted-foreground flex h-64 items-center justify-center rounded-md border border-dashed text-sm">
            选择左侧命名空间以浏览条目
          </div>
        )}
      </div>
    </>
  );
}

/** 挂载 provider 表单（Dialog 内容）。 */
function MountDialog({ onDone }: { onDone: () => void }) {
  const [namespace, setNamespace] = useState('');
  const [provider, setProvider] = useState('structured');
  const [ttl, setTtl] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [providerConfig, setProviderConfig] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!namespace.trim()) {
      toast.error('命名空间必填');
      return;
    }
    const input: ContextMountInput = { namespace: namespace.trim(), provider };
    if (ttl.trim()) {
      const n = Number(ttl);
      if (!Number.isFinite(n) || n <= 0) {
        toast.error('TTL 必须是正整数（秒）');
        return;
      }
      input.ttl = n;
    }
    if (readOnly) input.readOnly = true;
    if (providerConfig.trim()) {
      try {
        input.providerConfig = JSON.parse(providerConfig) as Record<string, unknown>;
      } catch {
        toast.error('providerConfig 不是合法 JSON');
        return;
      }
    }
    setBusy(true);
    try {
      await contextApi.mount(input);
      toast.success(`已挂载 ${input.namespace}`);
      onDone();
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle className="font-mono">挂载命名空间</DialogTitle>
        <DialogDescription>
          ContextRegistry.Write（幂等 upsert；重挂载刷新 TTL）。
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="ns">命名空间</Label>
          <Input
            id="ns"
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
            placeholder="notes"
            className="font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="prov">Provider</Label>
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger id="prov">
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
        <div className="space-y-1.5">
          <Label htmlFor="ttl">TTL（秒，可选）</Label>
          <Input
            id="ttl"
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
            placeholder="永不过期留空"
            className="font-mono"
          />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="ro">只读</Label>
          <Switch id="ro" checked={readOnly} onCheckedChange={setReadOnly} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pc">providerConfig（JSON，可选）</Label>
          <Textarea
            id="pc"
            value={providerConfig}
            onChange={(e) => setProviderConfig(e.target.value)}
            placeholder='{"dim": 1024}'
            className="font-mono text-xs"
            rows={3}
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

/** 单命名空间面板：条目列表（左内栏）+ 条目详情（右内栏）+ put/patch/unmount。 */
function NamespacePane({ mount, onUnmounted }: { mount: NamespaceMount; onUnmounted: () => void }) {
  const ns = mount.namespace;
  const entries = useLoad<{ items: ContextEntryMeta[] }>(() => contextApi.listEntries(ns), [ns]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [putOpen, setPutOpen] = useState(false);
  const [unmountOpen, setUnmountOpen] = useState(false);

  const items = entries.data?.items ?? [];

  const doUnmount = async () => {
    try {
      await contextApi.unmount(ns);
      toast.success(`已卸载 ${ns}`);
      onUnmounted();
    } catch (e) {
      toast.error(formatError(e));
    }
  };

  return (
    <div className="min-w-0 rounded-md border">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="font-mono text-sm font-medium">{ns}</span>
        <Badge variant="outline" className="text-[10px]">
          {mount.provider}
        </Badge>
        {mount.readOnly ? (
          <Badge variant="secondary" className="text-[10px]">
            只读
          </Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={entries.reload} aria-label="刷新条目">
            <RefreshCw className="size-4" />
          </Button>
          <Dialog open={putOpen} onOpenChange={setPutOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={mount.readOnly}>
                <Plus className="size-4" />
                新建条目
              </Button>
            </DialogTrigger>
            <PutDialog
              ns={ns}
              onDone={() => {
                setPutOpen(false);
                entries.reload();
              }}
            />
          </Dialog>
          <Dialog open={unmountOpen} onOpenChange={setUnmountOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="卸载命名空间">
                <Unplug className="size-4" />
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle className="font-mono">卸载 {ns}？</DialogTitle>
                <DialogDescription>
                  仅卸载挂载点，provider 数据保留（§4.2 Delete=卸载）。重挂载同名可复用旧数据（TTL
                  未过期时）。
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setUnmountOpen(false)}>
                  取消
                </Button>
                <Button variant="destructive" onClick={doUnmount}>
                  <Unplug className="size-4" />
                  卸载
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      <Separator />
      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr]">
        {/* 条目列表 */}
        <div className="border-b md:border-r md:border-b-0">
          <ScrollArea className="h-[calc(100vh-20rem)]">
            {entries.loading ? (
              <p className="text-muted-foreground p-3 text-sm">加载中…</p>
            ) : entries.error ? (
              <p className="text-destructive p-3 text-sm">{entries.error}</p>
            ) : items.length === 0 ? (
              <p className="text-muted-foreground p-3 text-sm">（无条目）</p>
            ) : (
              <ul className="p-1">
                {items.map((it) => (
                  <li key={it.uri}>
                    <button
                      type="button"
                      onClick={() => setSelectedPath(entryLeaf(it.uri))}
                      className={cn(
                        'w-full truncate rounded-sm px-2 py-1.5 text-left font-mono text-[13px] transition-colors',
                        selectedPath === entryLeaf(it.uri)
                          ? 'bg-accent text-accent-foreground'
                          : 'hover:bg-muted',
                      )}
                      title={it.uri}
                    >
                      {entryLeaf(it.uri)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </div>
        {/* 条目详情 */}
        <div className="min-w-0">
          {selectedPath ? (
            <EntryDetail
              key={`${ns}:${selectedPath}`}
              ns={ns}
              path={selectedPath}
              readOnly={mount.readOnly ?? false}
              onPatched={entries.reload}
            />
          ) : (
            <div className="text-muted-foreground flex h-40 items-center justify-center p-4 text-sm">
              选择条目查看内容
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 条目详情：cat 内容代码块 + patch 编辑。 */
function EntryDetail({
  ns,
  path,
  readOnly,
  onPatched,
}: {
  ns: string;
  path: string;
  readOnly: boolean;
  onPatched: () => void;
}) {
  const entry = useLoad<ContextEntry>(() => contextApi.getEntry(ns, path), [ns, path]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const startEdit = useCallback(() => {
    if (!entry.data) return;
    setDraft(prettyContent(entry.data.content, entry.data.contentType));
    setEditing(true);
  }, [entry.data]);

  const savePatch = async () => {
    setBusy(true);
    try {
      await contextApi.patchEntry(ns, path, { content: draft });
      toast.success('已更新');
      setEditing(false);
      entry.reload();
      onPatched();
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 p-4">
      {entry.loading ? (
        <p className="text-muted-foreground text-sm">加载中…</p>
      ) : entry.error ? (
        <p className="text-destructive text-sm">{entry.error}</p>
      ) : entry.data ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{path}</span>
            <Badge variant="outline" className="text-[10px]">
              {entry.data.contentType}
            </Badge>
            <Badge variant="secondary" className="text-[10px]">
              v{entry.data.version}
            </Badge>
            <div className="ml-auto flex gap-2">
              {editing ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing(false)}
                    disabled={busy}
                  >
                    取消
                  </Button>
                  <Button size="sm" onClick={savePatch} disabled={busy}>
                    {busy ? '保存中…' : '保存'}
                  </Button>
                </>
              ) : (
                <Button variant="outline" size="sm" onClick={startEdit} disabled={readOnly}>
                  编辑
                </Button>
              )}
            </div>
          </div>
          {editing ? (
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="font-mono text-xs"
              rows={16}
            />
          ) : (
            <pre className="bg-muted max-h-[calc(100vh-24rem)] overflow-auto rounded-md p-3 font-mono text-xs">
              {prettyContent(entry.data.content, entry.data.contentType)}
            </pre>
          )}
        </>
      ) : null}
    </div>
  );
}

/** 新建/覆盖条目表单（put）。 */
function PutDialog({ ns, onDone }: { ns: string; onDone: () => void }) {
  const [path, setPath] = useState('');
  const [contentType, setContentType] = useState('text/plain');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!path.trim()) {
      toast.error('路径必填');
      return;
    }
    setBusy(true);
    try {
      await contextApi.putEntry(ns, path.trim(), {
        content,
        contentType: contentType.trim() || 'text/plain',
      });
      toast.success(`已写入 ${path.trim()}`);
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
        <DialogTitle className="font-mono">新建 / 覆盖条目</DialogTitle>
        <DialogDescription>
          ContextProvider.Write（幂等 upsert）到 <span className="font-mono">{ns}</span>。
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="put-path">路径</Label>
            <Input
              id="put-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="notes/hello"
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="put-ct">Content-Type</Label>
            <Input
              id="put-ct"
              value={contentType}
              onChange={(e) => setContentType(e.target.value)}
              className="font-mono"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="put-content">内容</Label>
          <Textarea
            id="put-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="font-mono text-xs"
            rows={12}
          />
        </div>
      </div>
      <DialogFooter>
        <Button onClick={submit} disabled={busy}>
          {busy ? '写入中…' : '写入'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
