/**
 * 存储层类型化错误。
 *
 * 设计原则：所有违反语义契约（单调性、幂等性、归属/互斥、坏 ID）的写入
 * 都抛 StorageError，而不是返回 false 或静默吞掉。调用方据 code 区分：
 * - 'conflict' 是真正的语义冲突（重复 index、同 seq 不同 params），必须暴露。
 * - 'not_found' 是读取缺失。
 * - 'validation' 是 schema/ID 校验失败（坏 ID、错 scope、错归属）。
 *
 * zod parse 抛出的 ZodError 不在此封装：坏 ID / 错 scope 由各接口在入口
 * 用 schema.parse 直接抛 ZodError（与 @watt/protocol 测试范式一致）。
 * StorageError 只承载 schema 之外的、跨记录的语义约束冲突。
 */
export type StorageErrorCode = 'conflict' | 'not_found' | 'validation';

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

export const conflict = (message: string) => new StorageError('conflict', message);
export const notFound = (message: string) => new StorageError('not_found', message);
export const validation = (message: string) => new StorageError('validation', message);
