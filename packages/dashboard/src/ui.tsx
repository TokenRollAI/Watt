import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { formatError } from './api.ts';

/**
 * Dashboard 共享 UI 原语（M10 → P6 拆分）——useLoad / Panel / Msg / Table。
 * 从 App.tsx 抽出，供 App.tsx 与 views/ 三视图（Secrets/Channels/Providers）共用，保持 Vite 构建不变。
 * 错误文案统一经 api.ts `formatError`（403 → "当前 token 无权限"）。
 */

/** 通用异步加载 hook（load fn + 依赖，返回 data/error/loading/reload）。 */
export function useLoad<T>(
  fn: () => Promise<T>,
  deps: unknown[] = [],
): {
  data: T | undefined;
  error: string;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const run = useCallback(() => {
    setLoading(true);
    setError('');
    fn()
      .then((d) => setData(d))
      .catch((e) => setError(formatError(e)))
      .finally(() => setLoading(false));
    // biome-ignore lint/correctness/useExhaustiveDependencies: fn 由 deps 驱动，避免 fn 引用抖动重渲。
  }, deps);
  useEffect(run, [run]);
  return { data, error, loading, reload: run };
}

export function Panel({
  title,
  children,
  onReload,
}: {
  title: string;
  children: ReactNode;
  onReload?: () => void;
}): ReactNode {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {onReload && (
          <button type="button" onClick={onReload}>
            Reload
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

export function Msg({ error, loading }: { error: string; loading: boolean }): ReactNode {
  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <p className="error">{error}</p>;
  return null;
}

/** 通用表格（纯字符串单元格）。 */
export function Table({ head, rows }: { head: string[]; rows: string[][] }): ReactNode {
  if (!rows.length) return <p className="muted">(none)</p>;
  return (
    <table>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.join('|')}>
            {r.map((cell, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 表格单元格顺序稳定，index 作 key 安全。
              <td key={i}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
