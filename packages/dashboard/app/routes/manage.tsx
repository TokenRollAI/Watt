import { MessageSquarePlus, Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '~/components/page';
import { Button } from '~/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Textarea } from '~/components/ui/textarea';
import { ChatBubble, type ChatRole, TypingIndicator } from '~/components/view-b-parts';
import { useLoad } from '~/hooks/use-load';
import { formatError } from '~/lib/api';
import { agentsApi, newCorrelationId } from '~/lib/api/agents.ts';

/** 前端兜底超时：超过则停止轮询（略高于 Send 的 60s expect timeout）。 */
const REPLY_TIMEOUT_MS = 70_000;
/** 轮询间隔。 */
const POLL_INTERVAL_MS = 1_500;

interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
}

const instanceKey = (def: string) => `watt.manage.instance:${def}`;
const messagesKey = (instanceId: string) => `watt.manage.messages:${instanceId}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** agent.result 的 payload.output → 展示文本：优先 text 字段，否则 JSON pretty。 */
function renderOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (
    output !== null &&
    typeof output === 'object' &&
    'text' in output &&
    typeof (output as { text: unknown }).text === 'string'
  ) {
    return (output as { text: string }).text;
  }
  return JSON.stringify(output ?? null, null, 2);
}

/**
 * Manage 对话页（视图族 B 亮点）：选 manage/* 定义 → 新会话（Spawn 拿 instanceId）→ 聊天。
 * 发送 = agent Send（agent.message + expect{correlationId}）；取回复 = 轮询 event List
 * {filter:{correlationId}}（真源 event-store.ts）取 agent.result/agent.failed。
 * 会话 instanceId 与消息存 sessionStorage（平台无会话历史 API，刷新只恢复本机缓存，关标签页即丢）。
 */
export default function ManageView() {
  const { data: defs, error, loading } = useLoad(() => agentsApi.listAgentDefs(), []);
  const manageDefs = (defs?.items ?? []).filter((d) => d.name.startsWith('manage/'));

  const [def, setDef] = useState<string>('');
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [spawning, setSpawning] = useState(false);

  // 轮询代次：新会话/发送时自增，旧轮询循环发现代次变化即退出（避免重叠与卸载后写状态）。
  const genRef = useRef(0);
  const scrollAnchor = useRef<HTMLDivElement>(null);

  // 默认选中 manage/cron（无则第一个）——defs 到位后一次性设定。
  useEffect(() => {
    if (def || manageDefs.length === 0) return;
    const preferred = manageDefs.find((d) => d.name === 'manage/cron') ?? manageDefs[0];
    if (preferred) setDef(preferred.name);
  }, [def, manageDefs]);

  // 切换 def：从 sessionStorage 恢复该 def 的会话实例与消息（若有）。
  useEffect(() => {
    if (!def) return;
    genRef.current++; // 取消进行中的轮询
    setBusy(false);
    const savedInstance = sessionStorage.getItem(instanceKey(def));
    setInstanceId(savedInstance);
    if (savedInstance) {
      try {
        const raw = sessionStorage.getItem(messagesKey(savedInstance));
        setMessages(raw ? (JSON.parse(raw) as ChatMessage[]) : []);
      } catch {
        setMessages([]);
      }
    } else {
      setMessages([]);
    }
  }, [def]);

  // 消息变更持久化到 sessionStorage（按 instanceId）。
  useEffect(() => {
    if (!instanceId) return;
    sessionStorage.setItem(messagesKey(instanceId), JSON.stringify(messages));
  }, [instanceId, messages]);

  // 卸载时取消轮询。
  useEffect(() => () => void genRef.current++, []);

  // 新消息滚到底部。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖 messages 长度触发滚动。
  useEffect(() => {
    scrollAnchor.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const push = useCallback((msg: ChatMessage) => setMessages((m) => [...m, msg]), []);

  async function newSession() {
    if (!def) return;
    setSpawning(true);
    try {
      const { instance } = await agentsApi.spawnAgent({ definition: def });
      genRef.current++; // 取消旧轮询
      setBusy(false);
      sessionStorage.setItem(instanceKey(def), instance.instanceId);
      sessionStorage.removeItem(messagesKey(instance.instanceId));
      setInstanceId(instance.instanceId);
      setMessages([]);
      toast.success('新会话已创建');
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setSpawning(false);
    }
  }

  /** 轮询 correlationId 直到 result/failed 或超时；代次不符即静默退出。 */
  async function pollForReply(cid: string, myGen: number) {
    const startedAt = Date.now();
    while (genRef.current === myGen) {
      if (Date.now() - startedAt > REPLY_TIMEOUT_MS) {
        push({
          id: `${cid}-timeout`,
          role: 'error',
          text: '等待回复超时（70s），已停止轮询。可重试。',
        });
        setBusy(false);
        return;
      }
      try {
        const page = await agentsApi.pollCorrelation(cid, 10);
        if (genRef.current !== myGen) return;
        const evt = page.items.find(
          (e) =>
            e.payload?.correlationId === cid &&
            (e.type === 'agent.result' || e.type === 'agent.failed'),
        );
        if (evt) {
          if (evt.type === 'agent.result') {
            push({ id: evt.id, role: 'assistant', text: renderOutput(evt.payload?.output) });
          } else {
            push({
              id: evt.id,
              role: 'error',
              text: `助手报错：${String(evt.payload?.reason ?? '未知原因')}`,
            });
          }
          setBusy(false);
          return;
        }
      } catch (e) {
        if (genRef.current !== myGen) return;
        push({ id: `${cid}-err`, role: 'error', text: formatError(e) });
        setBusy(false);
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || !instanceId || busy) return;
    const cid = newCorrelationId();
    setInput('');
    push({ id: cid, role: 'user', text });
    setBusy(true);
    const myGen = ++genRef.current;
    try {
      await agentsApi.sendAgent(
        instanceId,
        { source: { kind: 'system' }, type: 'agent.message', payload: { text } },
        { correlationId: cid, timeoutMs: 60_000 },
      );
    } catch (e) {
      push({ id: `${cid}-senderr`, role: 'error', text: formatError(e) });
      setBusy(false);
      return;
    }
    void pollForReply(cid, myGen);
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter 发送，Shift+Enter 换行。
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Manage"
        description="与 manage Agent 对话（cron 助手等）。会话与消息仅存本机 sessionStorage，刷新可恢复、关标签页即丢。"
      />

      {loading ? (
        <LoadingRows />
      ) : error ? (
        <ErrorState error={error} />
      ) : manageDefs.length === 0 ? (
        <EmptyState message="未找到 manage/* 定义。请先在 Agents 页登记一个 manage 前缀的定义。" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
          {/* 左侧会话区 */}
          <aside className="space-y-4">
            <div className="space-y-2">
              <p className="section-label">Manage 定义</p>
              <Select value={def} onValueChange={setDef}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择定义…" />
                </SelectTrigger>
                <SelectContent>
                  {manageDefs.map((d) => (
                    <SelectItem key={d.name} value={d.name}>
                      <span className="font-mono">{d.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button className="w-full" onClick={newSession} disabled={spawning || !def}>
              <MessageSquarePlus className="size-4" />
              {spawning ? '创建中…' : '新会话'}
            </Button>
            <div className="space-y-1.5 rounded-md border p-3">
              <p className="section-label">当前会话</p>
              {instanceId ? (
                <p className="data-cell break-all">{instanceId}</p>
              ) : (
                <p className="text-muted-foreground text-sm">尚无会话，点「新会话」开始。</p>
              )}
            </div>
            <p className="text-muted-foreground text-xs leading-relaxed">
              提示：manage/cron 走调用者权限。若当前 token 无 platform://scheduler
              管理权限，模型会如实告知无权限——这是预期行为。
            </p>
          </aside>

          {/* 聊天主区 */}
          <section className="bg-grid flex h-[calc(100vh-16rem)] min-h-96 flex-col rounded-lg border">
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {!instanceId ? (
                <div className="text-muted-foreground flex h-full items-center justify-center text-center text-sm">
                  选择定义并点「新会话」后即可开始对话。
                </div>
              ) : messages.length === 0 ? (
                <div className="text-muted-foreground flex h-full items-center justify-center text-center text-sm">
                  会话已就绪，在下方输入消息开始对话。
                </div>
              ) : (
                messages.map((m) => <ChatBubble key={m.id} role={m.role} text={m.text} />)
              )}
              {busy ? <TypingIndicator /> : null}
              <div ref={scrollAnchor} />
            </div>
            <div className="border-t p-3">
              <div className="flex items-end gap-2">
                <Textarea
                  className="max-h-40 min-h-11 flex-1 resize-none"
                  placeholder={
                    instanceId ? '输入消息，Enter 发送，Shift+Enter 换行…' : '请先创建会话'
                  }
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onInputKeyDown}
                  disabled={!instanceId || busy}
                />
                <Button
                  size="icon"
                  className="size-11 shrink-0"
                  onClick={send}
                  disabled={!instanceId || busy || !input.trim()}
                >
                  <Send className="size-4" />
                </Button>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
