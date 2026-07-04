import type { ReactNode } from 'react';
import { Button } from '~/components/ui/button';
import { Skeleton } from '~/components/ui/skeleton';
import { cn } from '~/lib/utils';

/** 页头：工业标牌式模块名 + 描述 + 右侧动作区。各视图统一使用保证一致节奏。 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="space-y-1">
        <h1 className="font-mono text-xl font-medium tracking-tight">{title}</h1>
        {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** 加载骨架：表格类视图通用。 */
export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 纯装饰骨架无身份语义。
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

/** 错误态：统一文案 + 重试。error 已经 formatError 文案化。 */
export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="border-destructive/40 bg-destructive/5 flex items-center justify-between gap-4 rounded-md border px-4 py-3">
      <p className="text-destructive text-sm">{error}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  );
}

/** 空态。 */
export function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-muted-foreground rounded-md border border-dashed px-4 py-10 text-center text-sm">
      {message}
    </div>
  );
}

/** 状态徽记：LED + 文本。tone 对应语义色。 */
export function StatusDot({
  tone,
  label,
  className,
}: {
  tone: 'success' | 'destructive' | 'warning' | 'muted';
  label: string;
  className?: string;
}) {
  const toneClass = {
    success: 'text-success',
    destructive: 'text-destructive',
    warning: 'text-warning',
    muted: 'text-muted-foreground',
  }[tone];
  return (
    <span className={cn('inline-flex items-center gap-2 text-sm', toneClass, className)}>
      <span className="led" />
      <span className="text-foreground">{label}</span>
    </span>
  );
}
