import { type WattError, wattError } from '@watt/shared';
import type { NamespaceMount } from './types.ts';

/**
 * Context URI 解析与挂载选路（Proto §4.2 Resolve / §0.1 URI）——纯函数，无 I/O。
 *
 * URI 形态：`context://<namespace>/<path>`（§4.1 ContextEntryMeta.uri）。
 * Resolve 把它拆成 {namespace, path}，再按 mount 表最长前缀匹配得到 {provider, path}。
 */

const SCHEME = 'context://';

export interface ParsedContextUri {
  namespace: string;
  path: string;
}

/**
 * 解析 `context://<ns>/<path>` → {namespace, path}。
 * - 非 context:// scheme → invalid_argument。
 * - 空 namespace（`context://` 或 `context:///x`）→ invalid_argument。
 * - path 可空（`context://ns` 与 `context://ns/` 均得 path=""）。
 * - namespace 取 scheme 之后的首段；path 为其余部分（不含分隔的 '/'）。
 */
export function parseContextUri(uri: string): ParsedContextUri | WattError {
  if (!uri.startsWith(SCHEME)) {
    return wattError('invalid_argument', `uri must start with '${SCHEME}': ${uri}`, false);
  }
  const rest = uri.slice(SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash === -1) {
    // `context://ns` —— 无 path 段。
    if (rest === '') {
      return wattError('invalid_argument', `empty namespace in uri: ${uri}`, false);
    }
    return { namespace: rest, path: '' };
  }
  const namespace = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  if (namespace === '') {
    return wattError('invalid_argument', `empty namespace in uri: ${uri}`, false);
  }
  return { namespace, path };
}

export interface ResolvedMount {
  mount: NamespaceMount;
  path: string;
}

/**
 * 按 namespace 最长前缀匹配选出挂载点（§4.2 Resolve）。
 * - namespace 可含 '/'（"feedback/bugs"）；前缀匹配须按**段边界**：mount namespace
 *   "feedback/bugs" 匹配 `context://feedback/bugs/x`，但**不**匹配 `context://feedback/bugsy`。
 * - 多个前缀命中时取最长（最具体）者。
 * - 无匹配 → not_found。
 * - 命中后返回的 path = 完整 uri 内 namespace 之后的相对路径（provider 内相对路径）。
 */
export function resolveMount(uri: string, mounts: NamespaceMount[]): ResolvedMount | WattError {
  const parsed = parseContextUri(uri);
  if ('code' in parsed) return parsed;
  // 完整逻辑路径 = namespace + '/' + path（path 可空）。用它做段边界前缀匹配。
  const full = parsed.path === '' ? parsed.namespace : `${parsed.namespace}/${parsed.path}`;

  let best: NamespaceMount | undefined;
  for (const mount of mounts) {
    if (!segmentPrefixMatches(mount.namespace, full)) continue;
    if (best === undefined || mount.namespace.length > best.namespace.length) {
      best = mount;
    }
  }
  if (best === undefined) {
    return wattError('not_found', `no mount for uri: ${uri}`, false);
  }
  // provider 内相对路径 = full 去掉 namespace 前缀（含分隔的 '/'）。
  const relative = full === best.namespace ? '' : full.slice(best.namespace.length + 1);
  return { mount: best, path: relative };
}

/**
 * 段边界前缀匹配：prefix 完全等于 full，或 full 以 `prefix + '/'` 开头。
 * 避免 "feedback/bugs" 误配 "feedback/bugsy"。
 */
function segmentPrefixMatches(prefix: string, full: string): boolean {
  if (prefix === full) return true;
  return full.startsWith(`${prefix}/`);
}
