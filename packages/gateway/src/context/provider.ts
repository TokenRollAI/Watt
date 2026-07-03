/**
 * ContextProvider SPI（Proto §4.1）——三个内置 provider（object/structured/vector）的公共契约。
 *
 * 签名对齐 Proto §4.1 四动词 + 可选能力：
 * - List(path, opts?): Page<ContextEntryMeta>
 * - Get(path): ContextEntry
 * - Write(path, input): ContextEntryMeta   —— 幂等 upsert（§0.4）
 * - Update(path, patch): ContextEntryMeta  —— 不存在 → not_found
 * - Search?(query, opts?): Page<ContextEntryMeta>  —— vector 必须声明
 * - delete_?(path): void                   —— 可选（保留字避让：Proto 名 Delete）
 *
 * 错误走返回值（WattError），不抛异常——对齐 event-store.ts 风格。调用方以 'code' in x 判别。
 * 乐观并发：ifVersion 不匹配 → conflict（复用 core checkIfVersion）。
 */

import type {
  ContextEntry,
  ContextEntryInput,
  ContextEntryMeta,
  ContextPatch,
} from '@watt/core';
import type { WattError } from '@watt/shared';

/** Proto ListOptions（§0.2）——List/Search 整体入参对象（不平铺）。core 未导出，本地定义
 *  （对齐 event-store.ts；cursor 分页延后，doc-gap #22）。 */
export interface ListOptions {
  cursor?: string;
  limit?: number;
  filter?: Record<string, string>;
}

/** Proto Page<T>（§0.2）。cursor 分页延后（doc-gap #22，Page 返 {items} 合法）。 */
export interface Page<T> {
  items: T[];
}

/**
 * ContextProvider 契约（§4.1）。所有 path 为 namespace 内相对路径（provider 内相对）。
 * capabilities：可选能力探测（vector 声明 search=true）——供 Help DSL 生成与 Registry 校验。
 */
export interface ContextProvider {
  /** 内置 provider 类型标识（"object"|"structured"|"vector"）。 */
  readonly kind: string;
  /** 可选能力声明（capability 探测，§4.1 ContextProviderOptional）。 */
  readonly capabilities: { search: boolean; delete: boolean };

  list(path: string, opts?: ListOptions): Promise<Page<ContextEntryMeta> | WattError>;
  get(path: string): Promise<ContextEntry | WattError>;
  write(path: string, input: ContextEntryInput): Promise<ContextEntryMeta | WattError>;
  update(path: string, patch: ContextPatch): Promise<ContextEntryMeta | WattError>;

  /** vector 语义/全文检索（§4.1 Search）——非声明 search 的 provider 不实现。 */
  search?(query: string, opts?: ListOptions): Promise<Page<ContextEntryMeta> | WattError>;
  /** 可选删除（§4.1 Delete；保留字避让）。 */
  delete_?(path: string): Promise<void | WattError>;
}
