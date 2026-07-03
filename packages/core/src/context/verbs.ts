import { type WattError, wattError } from '@watt/shared';
import type { ContextEntry, ContextPatch } from './types.ts';

/**
 * ContextProvider 四动词语义校验纯逻辑（Proto §4.1）——供 gateway provider 复用，无 I/O。
 *
 * - Write = 幂等 upsert（§0.4）；Update 不存在 → not_found。
 * - 乐观并发：ifVersion 不匹配 → conflict（Write 和 Update 均可携带）。
 * - version 由调用方（Provider I/O 层）递增——这些纯函数不生成 version。
 */

/**
 * ifVersion 乐观并发校验（§4.1 L497/L503）。
 * - ifVersion 缺省（undefined）→ 跳过校验，返回 null（放行）。
 * - current 不存在（条目缺失，undefined）→ conflict（期望某版本但无条目）。
 * - current 与 ifVersion 不相等 → conflict。
 * - 匹配 → null（放行）。
 */
export function checkIfVersion(
  current: string | undefined,
  ifVersion: string | undefined,
): WattError | null {
  if (ifVersion === undefined) return null;
  if (current === undefined || current !== ifVersion) {
    return wattError(
      'conflict',
      `version mismatch: expected '${ifVersion}', got '${current}'`,
      false,
    );
  }
  return null;
}

/**
 * Update 前置存在性判定（§4.1 L465：不存在 → not_found）。
 * - value 为 null（条目不存在）→ not_found（带 path）。
 * - 否则原样返回该值。
 */
export function requireExisting<T>(value: T | null, path: string): T | WattError {
  if (value === null) {
    return wattError('not_found', `context entry not found: ${path}`, false);
  }
  return value;
}

/**
 * 对已存在条目施加 patch（§4.1 L500-504）——纯函数，不生成 version。
 * - metadata **浅合并**（patch.metadata 的键覆盖 current，未提及的键保留）。
 * - content 提供则替换（含替换为空串/falsy 值——以 "content in patch" 判定，而非真值）。
 * - version/updatedAt 保持 current 的值不变；由调用方在写回时递增/更新。
 */
export function applyPatch(current: ContextEntry, patch: ContextPatch): ContextEntry {
  const merged: ContextEntry = {
    ...current,
    metadata: { ...current.metadata, ...(patch.metadata ?? {}) },
  };
  if ('content' in patch && patch.content !== undefined) {
    merged.content = patch.content;
  }
  return merged;
}
