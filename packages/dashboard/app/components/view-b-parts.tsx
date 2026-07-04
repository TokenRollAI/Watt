/**
 * 视图族 B 共享小组件（Agents / Manage 对话）——自持，不耦合他人共享文件。
 * 提供 Agent 四态徽记、JSON 校验 textarea、详情键值行、聊天气泡与打字指示动画。
 */
import { AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { StatusDot } from '~/components/page';
import { Label } from '~/components/ui/label';
import { Textarea } from '~/components/ui/textarea';
import { cn } from '~/lib/utils';

/**
 * Agent 实例四态（§3.2）→ StatusDot tone：
 * running=warning（活跃）、idle=success（就绪）、waiting=muted（挂起等待）、terminated=destructive。
 */
export function AgentStateBadge({ state }: { state: string }) {
  const tone =
    state === 'running'
      ? 'warning'
      : state === 'idle'
        ? 'success'
        : state === 'terminated'
          ? 'destructive'
          : 'muted';
  return <StatusDot tone={tone} label={state} />;
}

/** 纯校验：空串视为「未填」（无错），否则试 JSON.parse。 */
function parseJsonError(value: string): string | null {
  if (!value.trim()) return null;
  try {
    JSON.parse(value);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'invalid JSON';
  }
}

/**
 * JSON 输入区（spawn input / send payload 复用）：值受控，change 时回吐 parse 结果。
 * onParsed 传 (parsed, valid)；空串视为「未填」（valid=true，parsed=undefined）。
 * 副作用只在 onChange 触发（不在渲染期），避免 parsed 为对象时的 setState 回环。
 */
export function JsonField({
  id,
  label,
  value,
  onChange,
  onParsed,
  placeholder,
  rows = 5,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onParsed?: (parsed: unknown, valid: boolean) => void;
  placeholder?: string;
  rows?: number;
}) {
  const error = parseJsonError(value);

  function handleChange(next: string) {
    onChange(next);
    if (!next.trim()) {
      onParsed?.(undefined, true);
      return;
    }
    try {
      onParsed?.(JSON.parse(next), true);
    } catch {
      onParsed?.(undefined, false);
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        className={cn('font-mono text-[13px]', error && 'border-destructive')}
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={(e) => handleChange(e.target.value)}
      />
      {error ? (
        <p className="text-destructive flex items-center gap-1.5 text-xs">
          <AlertCircle className="size-3.5" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** 详情键值行（Get 详情 Dialog 复用）：左标签右 mono 值。 */
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-start gap-2 py-1.5">
      <span className="section-label pt-0.5">{label}</span>
      <div className="data-cell break-all whitespace-pre-wrap">{children}</div>
    </div>
  );
}

/** 一条聊天消息。role=user 右对齐 primary/10 底；assistant 左对齐 card 底；error 左对齐 destructive 底。 */
export type ChatRole = 'user' | 'assistant' | 'error';

export function ChatBubble({ role, text }: { role: ChatRole; text: string }) {
  const isUser = role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] whitespace-pre-wrap break-words rounded-lg border px-3.5 py-2 text-sm',
          isUser
            ? 'bg-primary/10 border-primary/30'
            : role === 'error'
              ? 'bg-destructive/5 border-destructive/40 text-destructive'
              : 'bg-card border-border',
        )}
      >
        {text}
      </div>
    </div>
  );
}

/** 助手「正在思考」打字指示：三点脉冲动画（左对齐，card 底气泡内）。 */
export function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="bg-card border-border flex items-center gap-1.5 rounded-lg border px-3.5 py-3">
        <span className="typing-dot" />
        <span className="typing-dot" style={{ animationDelay: '0.2s' }} />
        <span className="typing-dot" style={{ animationDelay: '0.4s' }} />
        <style>{`
          .typing-dot {
            display: inline-block;
            width: 6px;
            height: 6px;
            border-radius: 9999px;
            background: var(--muted-foreground);
            animation: watt-typing 1s ease-in-out infinite;
          }
          @keyframes watt-typing {
            0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
            30% { opacity: 1; transform: translateY(-3px); }
          }
        `}</style>
      </div>
    </div>
  );
}
