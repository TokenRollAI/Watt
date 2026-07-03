import { describe, expect, it } from 'vitest';
import type { ContextEntry } from './types.ts';
import { applyPatch, checkIfVersion, requireExisting } from './verbs.ts';

/**
 * 四动词语义校验用例（test-first，Proto §4.1）。
 * ifVersion conflict / Update not_found / patch 浅合并。
 */

describe('checkIfVersion', () => {
  it('ifVersion 缺省 → 放行（null）', () => {
    expect(checkIfVersion('v1', undefined)).toBeNull();
    expect(checkIfVersion(undefined, undefined)).toBeNull();
  });

  it('current 匹配 ifVersion → 放行', () => {
    expect(checkIfVersion('v2', 'v2')).toBeNull();
  });

  it('current 不匹配 → conflict', () => {
    expect(checkIfVersion('v1', 'v2')).toMatchObject({ code: 'conflict' });
  });

  it('current 不存在但携带 ifVersion → conflict', () => {
    expect(checkIfVersion(undefined, 'v2')).toMatchObject({ code: 'conflict' });
  });
});

describe('requireExisting', () => {
  it('存在 → 原样返回', () => {
    expect(requireExisting({ a: 1 }, 'p')).toEqual({ a: 1 });
  });

  it('null（不存在）→ not_found', () => {
    expect(requireExisting(null, 'bugs/1')).toMatchObject({ code: 'not_found' });
  });
});

describe('applyPatch', () => {
  const base: ContextEntry = {
    uri: 'context://feedback/bugs/1',
    contentType: 'text/markdown',
    version: 'v1',
    updatedAt: '2026-07-03T00:00:00Z',
    metadata: { status: 'open', severity: 'P1' },
    content: '## old',
  };

  it('metadata 浅合并（覆盖命中键，保留未提及键）', () => {
    const r = applyPatch(base, { metadata: { status: 'fixed' } });
    expect(r.metadata).toEqual({ status: 'fixed', severity: 'P1' });
  });

  it('content 提供则替换', () => {
    const r = applyPatch(base, { content: '## new' });
    expect(r.content).toBe('## new');
  });

  it('content 可替换为空串（以 "in patch" 判定，非真值）', () => {
    const r = applyPatch(base, { content: '' });
    expect(r.content).toBe('');
  });

  it('空 patch 保持 content 与 metadata 不变', () => {
    const r = applyPatch(base, {});
    expect(r.content).toBe('## old');
    expect(r.metadata).toEqual({ status: 'open', severity: 'P1' });
  });

  it('version/updatedAt 由纯函数保持不变（调用方递增）', () => {
    const r = applyPatch(base, { content: 'x' });
    expect(r.version).toBe('v1');
    expect(r.updatedAt).toBe('2026-07-03T00:00:00Z');
  });

  it('content:undefined 显式提供时不替换（视同未提供）', () => {
    const r = applyPatch(base, { content: undefined, metadata: { status: 'fixing' } });
    expect(r.content).toBe('## old');
    expect(r.metadata.status).toBe('fixing');
  });
});
