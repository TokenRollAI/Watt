/**
 * 视图族 C 共享小组件（Tasks/Cron/Policies）——不改动他人共享文件。
 * 提供任务七态徽记、JSON 校验 textarea、键值明细行。
 */
import { AlertCircle } from 'lucide-react';
import { StatusDot } from '~/components/page';
import { Label } from '~/components/ui/label';
import { Textarea } from '~/components/ui/textarea';
import { cn } from '~/lib/utils';

/**
 * 任务七态 → StatusDot tone（Proto §8 TaskManager 状态机）：
 * running=warning、completed=success、failed/cancelled=destructive、其余（pending/waiting/paused）=muted。
 */
export function TaskStateBadge({ state }: { state: string }) {
  const tone =
    state === 'completed'
      ? 'success'
      : state === 'running'
        ? 'warning'
        : state === 'failed' || state === 'cancelled'
          ? 'destructive'
          : 'muted';
  return <StatusDot tone={tone} label={state} />;
}

/**
 * JSON 输入区（run input / cron payload / signal payload 复用）：值受控，输入时即时解析并回吐结果。
 * 空串视为「未填」（valid=true，parsed=undefined）；非法 JSON → valid=false、parsed=undefined 且显示错误。
 * 解析在 onChange 内进行（非渲染副作用），错误文案随 value 纯计算派生。
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

/** 纯计算：value 的 JSON 解析错误文案（空串/合法 → null）。 */
function parseJsonError(value: string): string | null {
  if (!value.trim()) return null;
  try {
    JSON.parse(value);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'invalid JSON';
  }
}

/** 详情键值行（详情抽屉/Dialog 复用）：左标签右 mono 值。 */
export function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-start gap-2 py-1.5">
      <span className="section-label pt-0.5">{label}</span>
      <div className="data-cell break-all">{children}</div>
    </div>
  );
}
