/**
 * MemoryStore：长期可复用知识（docs/architecture.md「Memory Store」）。
 * Memory 不等于完整日志，是被筛选、可复用、可检索的知识；检索层（Vectorize）
 * 属后续里程碑，本接口只做 put / get / list 的权威存储。
 *
 * 窄到 put / get / list：
 * - put 用 MemoryId（newMemoryId 派生），同 id 重复 put 覆盖（memory 是可更新
 *   的知识条目，与 artifact 的不可变内容语义不同——这是有意区分）。
 * - kind 标注来源类别（'preference' / 'experience' / 'summary' 等）。
 */
import { MemoryId } from '@watt/protocol';

export interface MemoryRecord {
  memoryId: string;
  /** 知识类别 */
  kind: string;
  /** 可检索文本内容 */
  content: string;
  /** 自由结构标签，便于按维度过滤 */
  tags?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface PutMemoryInput {
  memoryId: string;
  kind: string;
  content: string;
  tags?: Record<string, string>;
}

export interface MemoryStore {
  /** 写入/更新 memory 条目。memoryId 必须通过校验；同 id 覆盖（保留 createdAt）。 */
  put(input: PutMemoryInput): Promise<MemoryRecord>;
  /** 取条目，缺失抛 not_found。 */
  get(memoryId: string): Promise<MemoryRecord>;
  /** 列出全部条目（可选按 kind 过滤），按 createdAt 升序。 */
  list(kind?: string): Promise<MemoryRecord[]>;
}

export const assertMemoryId = (id: string): string => MemoryId.parse(id);
