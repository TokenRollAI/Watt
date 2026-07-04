import { useCallback, useEffect, useState } from 'react';
import { formatError } from '~/lib/api/core.ts';

/**
 * 极简数据加载 hook（自旧 dashboard ui.tsx 移植）：load fn + deps → {data,error,loading,reload}。
 * 错误统一经 formatError 文案化后由视图渲染；无缓存层（管理面板数据量小、实时性优先）。
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps 由调用方显式声明（与旧实现一致）。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    load()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(formatError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}
