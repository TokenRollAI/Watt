/**
 * Namespace TTL 过期判定（Proto §4.2 NamespaceMount.ttl）——纯函数，无 I/O。
 *
 * ttl 单位秒；到期整个 namespace 回收（临时 Context，Case 3）。惰性判定：每次访问时
 * 比对 now 与挂载起算点，供 ContextRegistry 判 not_found + 触发物理 GC。
 */

/**
 * 判定挂载是否已过期。
 * - ttl 缺省（undefined）→ 永不过期，恒返回 false。
 * - 到期时刻 = mountedAt(ms) + ttl*1000。**边界含等**（now === 到期时刻即视为已过期），
 *   语义为 "ttl 秒后回收"，第 ttl 秒整点起不再有效。
 * - mountedAt 为 ISO 8601 时间串。
 */
export function isExpired(mountedAt: string, ttl: number | undefined, nowMs: number): boolean {
  if (ttl === undefined) return false;
  const mountedMs = Date.parse(mountedAt);
  const expiresMs = mountedMs + ttl * 1000;
  return nowMs >= expiresMs;
}
