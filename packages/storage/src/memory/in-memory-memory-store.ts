/**
 * MemoryStore 的内存实现。memory 是可更新知识：同 id put 覆盖（保留 createdAt）。
 */
import { notFound } from '../errors.js';
import type {
  MemoryRecord,
  MemoryStore,
  PutMemoryInput,
} from '../memory-store.js';
import { assertMemoryId } from '../memory-store.js';

export class InMemoryMemoryStore implements MemoryStore {
  private readonly items = new Map<string, MemoryRecord>();

  async put(input: PutMemoryInput): Promise<MemoryRecord> {
    const memoryId = assertMemoryId(input.memoryId);
    const now = new Date().toISOString();
    const existing = this.items.get(memoryId);
    const record: MemoryRecord = {
      memoryId,
      kind: input.kind,
      content: input.content,
      ...(input.tags ? { tags: { ...input.tags } } : {}),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    this.items.set(memoryId, record);
    return { ...record, ...(record.tags ? { tags: { ...record.tags } } : {}) };
  }

  async get(memoryId: string): Promise<MemoryRecord> {
    const record = this.items.get(assertMemoryId(memoryId));
    if (!record) throw notFound(`memory not found: ${memoryId}`);
    return { ...record, ...(record.tags ? { tags: { ...record.tags } } : {}) };
  }

  async list(kind?: string): Promise<MemoryRecord[]> {
    return [...this.items.values()]
      .filter((r) => kind === undefined || r.kind === kind)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map((r) => ({ ...r, ...(r.tags ? { tags: { ...r.tags } } : {}) }));
  }
}
