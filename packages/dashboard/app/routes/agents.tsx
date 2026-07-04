import { GitBranch, RefreshCw, Send, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '~/components/page';
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
import { AgentStateBadge, DetailRow, JsonField } from '~/components/view-b-parts';
import { useLoad } from '~/hooks/use-load';
import { formatError } from '~/lib/api';
import { type AgentDefinitionDetail, agentsApi } from '~/lib/api/agents.ts';

/**
 * Agents 视图（视图族 B）：定义（List + Get 详情）与实例（ListInstances + 派生子树）双标签页，
 * 覆盖 Spawn（选 def + input JSON）/ Send（instanceId + event type/payload）/ Terminate（确认 + cascade）
 * 全部写动词。请求形状真源 packages/cli/src/agent.ts。
 */
export default function AgentsView() {
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  // instances 与 defs 共享一个 reload nonce，写动词后一并刷新。
  const [nonce, setNonce] = useState(0);
  const bump = () => setNonce((n) => n + 1);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agents"
        description="Agent 定义与实例：查看定义、派生实例、发送事件、终止子树。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={bump}>
              <RefreshCw className="size-4" />
              刷新
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSendOpen(true)}>
              <Send className="size-4" />
              发送事件
            </Button>
            <Button size="sm" onClick={() => setSpawnOpen(true)}>
              <Sparkles className="size-4" />
              派生实例
            </Button>
          </>
        }
      />

      <Tabs defaultValue="defs">
        <TabsList>
          <TabsTrigger value="defs">定义</TabsTrigger>
          <TabsTrigger value="instances">实例</TabsTrigger>
        </TabsList>
        <TabsContent value="defs" className="mt-4">
          <DefinitionsPanel nonce={nonce} />
        </TabsContent>
        <TabsContent value="instances" className="mt-4">
          <InstancesPanel nonce={nonce} onChanged={bump} />
        </TabsContent>
      </Tabs>

      <SpawnDialog
        open={spawnOpen}
        onOpenChange={setSpawnOpen}
        onDone={() => {
          setSpawnOpen(false);
          bump();
        }}
      />
      <SendDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        onDone={() => {
          setSendOpen(false);
          bump();
        }}
      />
    </div>
  );
}

// ── 定义面板 ─────────────────────────────────────────────────────────────────

function DefinitionsPanel({ nonce }: { nonce: number }) {
  const { data, error, loading, reload } = useLoad(() => agentsApi.listAgentDefs(), [nonce]);
  const [detailName, setDetailName] = useState<string | null>(null);

  if (loading) return <LoadingRows />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data || data.items.length === 0) {
    return <EmptyState message="暂无 Agent 定义。" />;
  }
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>Runtime</TableHead>
            <TableHead>模型</TableHead>
            <TableHead>描述</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.items.map((d) => (
            <TableRow key={d.name}>
              <TableCell className="data-cell">{d.name}</TableCell>
              <TableCell className="data-cell text-muted-foreground">{d.runtime}</TableCell>
              <TableCell className="data-cell text-muted-foreground">
                {d.model?.preferred ?? '-'}
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">{d.description}</TableCell>
              <TableCell className="text-right">
                <Button variant="ghost" size="sm" onClick={() => setDetailName(d.name)}>
                  详情
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {detailName ? (
        <DefinitionDetailDialog name={detailName} onClose={() => setDetailName(null)} />
      ) : null}
    </>
  );
}

/** 定义详情：runtime/model/grants/toolScopes/contextNamespaces/systemPrompt 展示。 */
function DefinitionDetailDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const { data, loading, error, reload } = useLoad(() => agentsApi.getAgentDef(name), [name]);
  const def: AgentDefinitionDetail | undefined = data?.definition;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{name}</DialogTitle>
          <DialogDescription>Agent 定义详情。</DialogDescription>
        </DialogHeader>
        {loading ? (
          <LoadingRows />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : def ? (
          <div className="space-y-5">
            <section className="rounded-md border p-3">
              <DetailRow label="描述">{def.description}</DetailRow>
              <DetailRow label="Runtime">{def.runtime}</DetailRow>
              <DetailRow label="模型">
                {def.model ? [def.model.preferred, ...(def.model.fallback ?? [])].join(' → ') : '-'}
              </DetailRow>
              {def.entry ? <DetailRow label="Entry">{def.entry.kind}</DetailRow> : null}
            </section>

            <section className="space-y-2">
              <p className="section-label">Grants（{def.grants.length}）</p>
              {def.grants.length === 0 ? (
                <EmptyState message="无授权（无工具/资源访问）。" />
              ) : (
                <div className="space-y-1.5">
                  {def.grants.map((g, i) => (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: grant 无稳定 id，序号即语义。
                      key={i}
                      className="rounded-md border px-3 py-2 text-sm"
                    >
                      <div className="data-cell break-all">{g.resources.join(', ')}</div>
                      <div className="text-muted-foreground mt-0.5 text-xs">
                        actions: {g.actions.join(', ')}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <ChipSection label="Tool Scopes" items={def.toolScopes} />
            <ChipSection label="Context Namespaces" items={def.contextNamespaces} />

            {def.systemPrompt ? (
              <section className="space-y-2">
                <p className="section-label">System Prompt</p>
                <pre className="bg-muted/40 max-h-64 overflow-auto rounded-md border p-3 font-mono text-[12px] whitespace-pre-wrap">
                  {def.systemPrompt}
                </pre>
              </section>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ChipSection({ label, items }: { label: string; items: string[] }) {
  return (
    <section className="space-y-2">
      <p className="section-label">
        {label}（{items.length}）
      </p>
      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm">—</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((it) => (
            <span key={it} className="data-cell bg-muted/50 rounded border px-2 py-0.5">
              {it}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

// ── 实例面板 ─────────────────────────────────────────────────────────────────

function InstancesPanel({ nonce, onChanged }: { nonce: number; onChanged: () => void }) {
  const { data, error, loading, reload } = useLoad(() => agentsApi.listAgentInstances(), [nonce]);
  const [treeOf, setTreeOf] = useState<string | null>(null);
  const [terminateId, setTerminateId] = useState<string | null>(null);

  if (loading) return <LoadingRows />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data || data.items.length === 0) {
    return <EmptyState message="暂无运行中的实例。点「派生实例」从定义启动一个。" />;
  }
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Instance ID</TableHead>
            <TableHead>定义</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>父实例</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.items.map((i) => (
            <TableRow key={i.instanceId}>
              <TableCell className="data-cell">{i.instanceId}</TableCell>
              <TableCell className="data-cell text-muted-foreground">{i.definition}</TableCell>
              <TableCell>
                <AgentStateBadge state={i.state} />
              </TableCell>
              <TableCell className="data-cell text-muted-foreground">{i.parent ?? '-'}</TableCell>
              <TableCell className="text-right">
                <Button variant="ghost" size="sm" onClick={() => setTreeOf(i.instanceId)}>
                  <GitBranch className="size-4" />
                  子树
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setTerminateId(i.instanceId)}
                >
                  <Trash2 className="size-4" />
                  终止
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {treeOf ? <SubtreeDialog instanceId={treeOf} onClose={() => setTreeOf(null)} /> : null}
      <TerminateDialog
        instanceId={terminateId}
        onClose={() => setTerminateId(null)}
        onDone={() => {
          setTerminateId(null);
          onChanged();
        }}
      />
    </>
  );
}

/** 派生子树：ListInstances{tree:instanceId}，缩进渲染父子关系（根在前）。 */
function SubtreeDialog({ instanceId, onClose }: { instanceId: string; onClose: () => void }) {
  const { data, loading, error, reload } = useLoad(
    () => agentsApi.listAgentSubtree(instanceId),
    [instanceId],
  );
  const items = data?.items ?? [];
  // 按 parent 反查缩进（parent 不在集合内视为根）。
  const ids = new Set(items.map((i) => i.instanceId));
  const byParent = new Map<string, typeof items>();
  for (const it of items) {
    const key = it.parent !== undefined && ids.has(it.parent) ? it.parent : '';
    byParent.set(key, [...(byParent.get(key) ?? []), it]);
  }
  const rows: { depth: number; item: (typeof items)[number] }[] = [];
  const walk = (parentKey: string, depth: number) => {
    for (const node of byParent.get(parentKey) ?? []) {
      rows.push({ depth, item: node });
      walk(node.instanceId, depth + 1);
    }
  };
  walk('', 0);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{instanceId}</DialogTitle>
          <DialogDescription>该实例的派生子树（含自身）。</DialogDescription>
        </DialogHeader>
        {loading ? (
          <LoadingRows />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : rows.length === 0 ? (
          <EmptyState message="子树为空。" />
        ) : (
          <div className="space-y-1.5">
            {rows.map(({ depth, item }) => (
              <div
                key={item.instanceId}
                className="flex items-center justify-between rounded-md border px-3 py-2"
                style={{ marginLeft: `${depth * 1.25}rem` }}
              >
                <div className="min-w-0">
                  <div className="data-cell truncate">{item.instanceId}</div>
                  <div className="text-muted-foreground text-xs">{item.definition}</div>
                </div>
                <AgentStateBadge state={item.state} />
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 终止实例确认（alert-dialog + cascade 开关）。 */
function TerminateDialog({
  instanceId,
  onClose,
  onDone,
}: {
  instanceId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [cascade, setCascade] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (!instanceId) return;
    setBusy(true);
    try {
      await agentsApi.terminateAgent(instanceId, cascade);
      toast.success(cascade ? '已终止实例及其子树' : '已终止实例');
      setCascade(false);
      onDone();
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={instanceId !== null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>终止实例？</AlertDialogTitle>
          <AlertDialogDescription>
            将终止 <span className="data-cell">{instanceId}</span>。此操作不可撤销。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
          <div className="space-y-0.5">
            <Label htmlFor="cascade">级联终止子树</Label>
            <p className="text-muted-foreground text-xs">同时终止该实例派生的所有子实例。</p>
          </div>
          <Switch id="cascade" checked={cascade} onCheckedChange={setCascade} />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>返回</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={confirm}>
            {busy ? '终止中…' : '确认终止'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── 写动词 Dialog（Spawn / Send）────────────────────────────────────────────

/** 派生实例：List 选 def + instanceKey（可选）+ input JSON → Spawn。 */
function SpawnDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const { data: defs, loading, error } = useLoad(() => agentsApi.listAgentDefs(), [open]);
  const [definition, setDefinition] = useState('');
  const [instanceKey, setInstanceKey] = useState('');
  const [inputText, setInputText] = useState('');
  const [inputParsed, setInputParsed] = useState<unknown>(undefined);
  const [inputValid, setInputValid] = useState(true);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!definition) return;
    setBusy(true);
    try {
      const { instance } = await agentsApi.spawnAgent({
        definition,
        ...(instanceKey.trim() ? { instanceKey: instanceKey.trim() } : {}),
        ...(inputParsed !== undefined ? { input: inputParsed } : {}),
      });
      toast.success(`已派生实例：${instance.instanceId}`);
      setDefinition('');
      setInstanceKey('');
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
          <DialogTitle>派生实例</DialogTitle>
          <DialogDescription>选择定义并提供实例键与输入（均可选）。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Agent 定义</Label>
            {loading ? (
              <LoadingRows rows={1} />
            ) : error ? (
              <ErrorState error={error} />
            ) : (
              <Select value={definition} onValueChange={setDefinition}>
                <SelectTrigger className="w-full">
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
          <div className="space-y-2">
            <Label htmlFor="spawn-key">实例键（可选，幂等键——同键同实例）</Label>
            <Input
              id="spawn-key"
              className="font-mono"
              value={instanceKey}
              onChange={(e) => setInstanceKey(e.target.value)}
              placeholder="留空则平台生成"
            />
          </div>
          <JsonField
            id="spawn-input"
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
            {busy ? '派生中…' : '派生'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 发送事件：instanceId + event type + payload JSON → Send（即发即忘，不带 expect）。 */
function SendDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const [instanceId, setInstanceId] = useState('');
  const [eventType, setEventType] = useState('agent.message');
  const [payloadText, setPayloadText] = useState('');
  const [payloadParsed, setPayloadParsed] = useState<unknown>(undefined);
  const [payloadValid, setPayloadValid] = useState(true);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!instanceId.trim() || !eventType.trim()) return;
    setBusy(true);
    try {
      const { accepted } = await agentsApi.sendAgent(instanceId.trim(), {
        source: { kind: 'system' },
        type: eventType.trim(),
        ...(payloadParsed !== undefined ? { payload: payloadParsed } : {}),
      });
      toast.success(accepted ? '事件已受理' : '事件未受理');
      setPayloadText('');
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
          <DialogTitle>发送事件</DialogTitle>
          <DialogDescription>
            向实例投递一个事件（即发即忘）。对话式交互请用「Manage」页。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="send-id">Instance ID</Label>
            <Input
              id="send-id"
              className="font-mono"
              value={instanceId}
              onChange={(e) => setInstanceId(e.target.value)}
              placeholder="目标实例 id"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="send-type">Event Type</Label>
            <Input
              id="send-type"
              className="font-mono"
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
              placeholder="agent.message"
            />
          </div>
          <JsonField
            id="send-payload"
            label="Payload（JSON，可选）"
            value={payloadText}
            onChange={setPayloadText}
            onParsed={(p, valid) => {
              setPayloadParsed(p);
              setPayloadValid(valid);
            }}
            placeholder='{"text": "hello"}'
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={busy || !instanceId.trim() || !eventType.trim() || !payloadValid}
            onClick={submit}
          >
            {busy ? '发送中…' : '发送'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
