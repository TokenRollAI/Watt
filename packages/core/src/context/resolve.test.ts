import { describe, expect, it } from 'vitest';
import { parseContextUri, resolveMount } from './resolve.ts';
import type { NamespaceMount } from './types.ts';

/**
 * URI 解析与挂载选路用例（test-first，Proto §4.2 Resolve / §0.1）。
 * oracle 硬编码期望，不复用被测函数产物。
 */

describe('parseContextUri', () => {
  it('解析 ns + path', () => {
    expect(parseContextUri('context://feedback/bugs/1235')).toEqual({
      namespace: 'feedback',
      path: 'bugs/1235',
    });
  });

  it('path 可空（context://ns）', () => {
    expect(parseContextUri('context://skills')).toEqual({ namespace: 'skills', path: '' });
  });

  it('path 可空（context://ns/ 尾斜杠）', () => {
    expect(parseContextUri('context://skills/')).toEqual({ namespace: 'skills', path: '' });
  });

  it('非 context:// scheme → invalid_argument', () => {
    const r = parseContextUri('tool://x/y');
    expect(r).toMatchObject({ code: 'invalid_argument' });
  });

  it('空 namespace（context://）→ invalid_argument', () => {
    const r = parseContextUri('context://');
    expect(r).toMatchObject({ code: 'invalid_argument' });
  });

  it('空 namespace（context:///path）→ invalid_argument', () => {
    const r = parseContextUri('context:///path');
    expect(r).toMatchObject({ code: 'invalid_argument' });
  });
});

describe('resolveMount', () => {
  const mounts: NamespaceMount[] = [
    { namespace: 'feedback', provider: 'object' },
    { namespace: 'feedback/bugs', provider: 'structured' },
    { namespace: 'research/scratch', provider: 'vector' },
  ];

  it('最长前缀匹配（feedback/bugs 胜过 feedback）', () => {
    const r = resolveMount('context://feedback/bugs/1235', mounts);
    expect(r).toEqual({ mount: mounts[1], path: '1235' });
  });

  it('较短前缀在无更具体挂载时命中', () => {
    const r = resolveMount('context://feedback/general/note', mounts);
    expect(r).toEqual({ mount: mounts[0], path: 'general/note' });
  });

  it('段边界：feedback/bugs 不匹配 feedback/bugsy', () => {
    // bugsy 命中的是 feedback（段边界），provider 内相对路径为 bugsy/x。
    const r = resolveMount('context://feedback/bugsy/x', mounts);
    expect(r).toEqual({ mount: mounts[0], path: 'bugsy/x' });
  });

  it('namespace 精确等于完整逻辑路径时 path 为空', () => {
    const r = resolveMount('context://research/scratch', mounts);
    expect(r).toEqual({ mount: mounts[2], path: '' });
  });

  it('无匹配 → not_found', () => {
    const r = resolveMount('context://unknown/x', mounts);
    expect(r).toMatchObject({ code: 'not_found' });
  });

  it('uri 无 path 段（context://feedback）→ full=namespace，path 空', () => {
    const r = resolveMount('context://feedback', mounts);
    expect(r).toEqual({ mount: mounts[0], path: '' });
  });

  it('较长 mount 先于较短 mount 时仍取最长（不被后续更短者覆盖）', () => {
    // 顺序颠倒：feedback/bugs 在前、feedback 在后，验证 length 比较分支的 false 侧。
    const ordered: NamespaceMount[] = [
      { namespace: 'feedback/bugs', provider: 'structured' },
      { namespace: 'feedback', provider: 'object' },
    ];
    const r = resolveMount('context://feedback/bugs/1', ordered);
    expect(r).toEqual({ mount: ordered[0], path: '1' });
  });

  it('透传 parseContextUri 的错误（非法 scheme）', () => {
    const r = resolveMount('tool://feedback/x', mounts);
    expect(r).toMatchObject({ code: 'invalid_argument' });
  });
});
