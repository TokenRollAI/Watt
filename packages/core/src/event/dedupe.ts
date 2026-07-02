/**
 * dedupeKey 幂等（§1 L117–118 / §2.3）：纯函数 + 存储接口。
 *
 * 语义：相同 dedupeKey 的重复 Publish 在时间窗内幂等返回原 eventId
 * （不产生新事件、不再投递）。
 *
 * 时间窗基线 Proto 未定量（doc-gap #11）。本轮默认取 **24 小时**：
 * 覆盖渠道级重投/补投的最坏窗口（如飞书离线消息重推、webhook 供应商长重试），
 * 比调研报告 §11 的 5 分钟保守——宁可多去重也不误产重复事件。窗口做成可注入参数，
 * Phase 2 接 KV 时以 TTL 落地，可按渠道覆盖此默认。
 *
 * DedupeStore 接口：Phase 2 接 D1/KV；本轮 InMemoryDedupeStore 用于测语义。
 */

export const DEFAULT_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 去重记录：原始 eventId + 记录时刻（epoch ms）。 */
export interface DedupeRecord {
  eventId: string;
  storedAt: number;
}

/** 去重存储接口。Phase 2 由 KV/D1 实现；本轮内存实现测语义。 */
export interface DedupeStore {
  get(dedupeKey: string): DedupeRecord | undefined;
  set(dedupeKey: string, record: DedupeRecord): void;
}

/** 内存实现（测试/单进程用）。 */
export class InMemoryDedupeStore implements DedupeStore {
  private readonly map = new Map<string, DedupeRecord>();

  get(dedupeKey: string): DedupeRecord | undefined {
    return this.map.get(dedupeKey);
  }

  set(dedupeKey: string, record: DedupeRecord): void {
    this.map.set(dedupeKey, record);
  }
}

export interface ResolveDedupeInput {
  dedupeKey: string;
  /** 本次拟采用的新 eventId（未命中去重时会被记录并返回）。 */
  eventId: string;
  /** 当前时刻（epoch ms，可注入以便测试）。 */
  now: number;
  /** 去重时间窗（ms），缺省用 DEFAULT_DEDUPE_WINDOW_MS。 */
  windowMs?: number;
}

export interface DedupeResult {
  /** 最终生效的 eventId：命中窗内去重时为原 eventId，否则为本次 eventId。 */
  eventId: string;
  /** 是否为窗内重复（命中则调用方不应新建事件/投递）。 */
  duplicate: boolean;
}

/**
 * 纯逻辑幂等判定。
 * - 命中且在窗内（now - storedAt ≤ windowMs）→ 返回原 eventId、duplicate=true，不覆写存储。
 * - 未命中或已过窗 → 记录本次 eventId、duplicate=false（过窗时刷新为新记录）。
 */
export function resolveDedupe(store: DedupeStore, input: ResolveDedupeInput): DedupeResult {
  const windowMs = input.windowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  const existing = store.get(input.dedupeKey);
  if (existing !== undefined && input.now - existing.storedAt <= windowMs) {
    return { eventId: existing.eventId, duplicate: true };
  }
  store.set(input.dedupeKey, { eventId: input.eventId, storedAt: input.now });
  return { eventId: input.eventId, duplicate: false };
}
