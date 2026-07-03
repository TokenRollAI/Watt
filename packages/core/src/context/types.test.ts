import { describe, expect, it } from 'vitest';
import {
  contextEntryInputSchema,
  contextEntryMetaSchema,
  contextEntrySchema,
  contextPatchSchema,
  namespaceMountSchema,
} from './types.ts';

/**
 * Context 类型层 zod schema 用例（test-first，Proto §4.1/§4.2）。
 * 断言字段名/约束与 Proto 原文一致，且 schema 行被覆盖执行。
 */

describe('namespaceMountSchema（§4.2）', () => {
  it('接受最小挂载（仅 namespace + provider）', () => {
    const m = namespaceMountSchema.parse({ namespace: 'feedback/bugs', provider: 'object' });
    expect(m).toEqual({ namespace: 'feedback/bugs', provider: 'object' });
  });

  it('接受完整挂载（providerConfig/ttl/readOnly）', () => {
    const m = namespaceMountSchema.parse({
      namespace: 'research/scratch',
      provider: 'vector',
      providerConfig: { index: 'watt-context-index' },
      ttl: 3600,
      readOnly: true,
    });
    expect(m.ttl).toBe(3600);
    expect(m.readOnly).toBe(true);
  });

  it('拒绝非正整数 ttl', () => {
    expect(
      namespaceMountSchema.safeParse({ namespace: 'x', provider: 'object', ttl: 0 }).success,
    ).toBe(false);
    expect(
      namespaceMountSchema.safeParse({ namespace: 'x', provider: 'object', ttl: 1.5 }).success,
    ).toBe(false);
    expect(
      namespaceMountSchema.safeParse({ namespace: 'x', provider: 'object', ttl: -5 }).success,
    ).toBe(false);
  });
});

describe('contextEntryMetaSchema / contextEntrySchema（§4.1）', () => {
  const meta = {
    uri: 'context://feedback/bugs/1235',
    contentType: 'text/markdown',
    version: 'v1',
    updatedAt: '2026-07-03T00:00:00Z',
    metadata: { status: 'open' },
  };

  it('接受最小 meta（无 size）', () => {
    expect(contextEntryMetaSchema.parse(meta)).toMatchObject({ uri: meta.uri, version: 'v1' });
  });

  it('entry extends meta + content', () => {
    const e = contextEntrySchema.parse({ ...meta, content: '## bug' });
    expect(e.content).toBe('## bug');
    expect(e.uri).toBe(meta.uri);
  });

  it('metadata 必须为 Record<string,string>', () => {
    expect(contextEntryMetaSchema.safeParse({ ...meta, metadata: { n: 1 } }).success).toBe(false);
  });
});

describe('contextPatchSchema（§4.1）', () => {
  it('全字段可选，空 patch 合法', () => {
    expect(contextPatchSchema.parse({})).toEqual({});
  });

  it('接受 content/metadata/ifVersion', () => {
    const p = contextPatchSchema.parse({
      content: 'x',
      metadata: { status: 'fixed' },
      ifVersion: 'v1',
    });
    expect(p.ifVersion).toBe('v1');
  });
});

describe('contextEntryInputSchema（§4.1 Write 入参）', () => {
  it('contentType + content 必填', () => {
    expect(contextEntryInputSchema.safeParse({ content: 'x' }).success).toBe(false);
    const i = contextEntryInputSchema.parse({ contentType: 'text/plain', content: 'x' });
    expect(i.contentType).toBe('text/plain');
  });

  it('接受 metadata/ifVersion', () => {
    const i = contextEntryInputSchema.parse({
      contentType: 'application/json',
      content: { a: 1 },
      metadata: { src: 'test' },
      ifVersion: 'v2',
    });
    expect(i.ifVersion).toBe('v2');
  });
});
