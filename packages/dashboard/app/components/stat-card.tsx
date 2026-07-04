import type { ReactNode } from 'react';
import { Card } from '~/components/ui/card';
import { cn } from '~/lib/utils';

/**
 * 控制台仪表统计卡（视图族A 自用共享组件）——大号 mono 读数 + 区块标签 + 可选状态指示/脚注。
 * 「电力控制台」读数位：label 走 section-label，value 走 data-cell 放大。
 */
export function StatCard({
  label,
  value,
  hint,
  icon,
  loading,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  loading?: boolean;
  tone?: 'success' | 'destructive' | 'warning';
}) {
  const toneClass = tone
    ? { success: 'text-success', destructive: 'text-destructive', warning: 'text-warning' }[tone]
    : 'text-foreground';
  return (
    <Card className="gap-3 py-4">
      <div className="flex items-start justify-between px-4">
        <span className="section-label">{label}</span>
        {icon ? <span className="text-muted-foreground/70">{icon}</span> : null}
      </div>
      <div className="px-4">
        <div
          className={cn(
            'data-cell text-2xl font-medium leading-none tracking-tight tabular-nums',
            toneClass,
          )}
        >
          {loading ? <span className="text-muted-foreground/40">—</span> : value}
        </div>
        {hint ? <p className="text-muted-foreground mt-2 text-xs">{hint}</p> : null}
      </div>
    </Card>
  );
}
