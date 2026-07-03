import type { ContextEntry, ContextEntryMeta } from '@watt/core';
import { describe, expect, it } from 'vitest';
import {
  type Embedder,
  VectorContextProvider,
  type VectorIndex,
  type VectorMatch,
  type VectorRecord,
} from '../src/context/providers/vector.ts';

/**
 * vector ContextProvider 单测——AI/Vectorize 依赖注入 fake（不碰真实 Workers AI / Vectorize）。
 * 本地 miniflare 对 Vectorize 只 WARNING 不执行真实召回（toolchain §10），故此处 mock 流程语义：
 *   Write 调 embed + upsert；Search embed query + query + 按 score 降序。真实召回验证留部署冒烟。
 * oracle 硬编码自 Proto §4.1（Write/Get/Update、Search 排序、ifVersion conflict、List unavailable）。
 *
 * 纯 mock 测试，不跑在 workerd（无 cloudflare:test 依赖）——普通 vitest 环境即可。
 */

const NS = 'research/scratch';

/** in-memory fake Vectorize：记录 upsert 调用，query 返回预置 matches。 */
class FakeIndex implements VectorIndex {
  store = new Map<string, VectorRecord>();
  upsertCalls: VectorRecord[][] = [];
  queryResult: VectorMatch[] = [];

  async upsert(vectors: VectorRecord[]): Promise<unknown> {
    this.upsertCalls.push(vectors);
    for (const v of vectors) this.store.set(v.id, v);
    return { count: vectors.length };
  }
  async query(_values: number[], _opts: { topK: number }): Promise<{ matches: VectorMatch[] }> {
    return { matches: this.queryResult };
  }
  async getByIds(ids: string[]): Promise<VectorRecord[]> {
    return ids.map((id) => this.store.get(id)).filter((v): v is VectorRecord => v !== undefined);
  }
}

/** fake embedder：记录 embed 调用，返回固定 1024 维向量。 */
class FakeEmbedder implements Embedder {
  calls: string[] = [];
  async embed(text: string): Promise<number[]> {
    this.calls.push(text);
    return new Array(1024).fill(0.1);
  }
}

function setup(namespace = NS) {
  const index = new FakeIndex();
  const embedder = new FakeEmbedder();
  const provider = new VectorContextProvider(index, embedder, namespace);
  return { index, embedder, provider };
}

function asMeta(x: ContextEntryMeta | { code: string }): ContextEntryMeta {
  if ('code' in x) throw new Error(`expected meta, got error ${x.code}`);
  return x;
}
function asEntry(x: ContextEntry | { code: string }): ContextEntry {
  if ('code' in x) throw new Error(`expected entry, got error ${x.code}`);
  return x;
}
function asList(x: { items: ContextEntryMeta[] } | { code: string }): ContextEntryMeta[] {
  if ('code' in x) throw new Error(`expected page, got error ${x.code}`);
  return x.items;
}

describe('VectorContextProvider Write (§4.1)', () => {
  it('write embeds content then upserts with id = <namespace>/<path> and version "1"', async () => {
    const { index, embedder, provider } = setup();
    const meta = asMeta(
      await provider.write('note-1', {
        contentType: 'text/plain',
        content: 'the quick brown fox',
        metadata: { author: 'alice' },
      }),
    );
    expect(embedder.calls).toEqual(['the quick brown fox']);
    expect(index.upsertCalls).toHaveLength(1);
    const rec = index.upsertCalls[0]?.[0];
    expect(rec?.id).toBe('research/scratch/note-1');
    expect(rec?.values).toHaveLength(1024);
    expect(meta.uri).toBe('context://research/scratch/note-1');
    expect(meta.version).toBe('1');
    expect(meta.metadata).toEqual({ author: 'alice' });
  });

  it('write bumps version on re-write and a stale ifVersion conflicts', async () => {
    const { provider } = setup();
    await provider.write('n', { contentType: 'text/plain', content: 'v1' });
    const meta2 = asMeta(await provider.write('n', { contentType: 'text/plain', content: 'v2' }));
    expect(meta2.version).toBe('2');
    const conflict = await provider.write('n', {
      contentType: 'text/plain',
      content: 'v3',
      ifVersion: '1',
    });
    expect(conflict).toMatchObject({ code: 'conflict' });
  });
});

describe('VectorContextProvider Get / Update (§4.1)', () => {
  it('get returns the stored content snippet + meta', async () => {
    const { provider } = setup();
    await provider.write('n', { contentType: 'text/plain', content: 'hello world' });
    const entry = asEntry(await provider.get('n'));
    expect(entry.content).toBe('hello world');
    expect(entry.uri).toBe('context://research/scratch/n');
  });

  it('get on a missing path returns not_found', async () => {
    const { provider } = setup();
    expect(await provider.get('nope')).toMatchObject({ code: 'not_found' });
  });

  it('update re-embeds merged content and bumps version', async () => {
    const { embedder, provider } = setup();
    await provider.write('n', { contentType: 'text/plain', content: 'orig', metadata: { a: '1' } });
    const meta = asMeta(await provider.update('n', { content: 'new', metadata: { b: '2' } }));
    expect(meta.version).toBe('2');
    expect(meta.metadata).toEqual({ a: '1', b: '2' });
    // 第二次 embed 用的是合并后的新内容。
    expect(embedder.calls[embedder.calls.length - 1]).toBe('new');
  });

  it('update on a missing path returns not_found', async () => {
    const { provider } = setup();
    expect(await provider.update('nope', { content: 'x' })).toMatchObject({ code: 'not_found' });
  });
});

describe('VectorContextProvider Search (§4.1 可选能力)', () => {
  it('embeds the query then returns matches sorted by score descending', async () => {
    const { index, embedder, provider } = setup();
    // 预置乱序 matches（同 namespace），断言按 score 降序。
    index.queryResult = [
      {
        id: 'research/scratch/a',
        score: 0.3,
        metadata: { namespace: NS, path: 'a', content: 'A' },
      },
      {
        id: 'research/scratch/b',
        score: 0.9,
        metadata: { namespace: NS, path: 'b', content: 'B' },
      },
      {
        id: 'research/scratch/c',
        score: 0.6,
        metadata: { namespace: NS, path: 'c', content: 'C' },
      },
    ];
    const page = asList(await provider.search('query text'));
    expect(embedder.calls).toContain('query text');
    expect(page.map((m) => m.uri)).toEqual([
      'context://research/scratch/b',
      'context://research/scratch/c',
      'context://research/scratch/a',
    ]);
  });

  it('filters out matches from other namespaces', async () => {
    const { index, provider } = setup();
    index.queryResult = [
      { id: 'research/scratch/a', score: 0.9, metadata: { namespace: NS, path: 'a' } },
      { id: 'other/ns/x', score: 0.8, metadata: { namespace: 'other/ns', path: 'x' } },
    ];
    const page = asList(await provider.search('q'));
    expect(page).toHaveLength(1);
    expect(page[0]?.uri).toBe('context://research/scratch/a');
  });

  it('respects opts.limit as topK (clamped to [1,100])', async () => {
    const { index, provider } = setup();
    let capturedTopK = -1;
    index.query = async (_v, opts) => {
      capturedTopK = opts.topK;
      return { matches: [] };
    };
    await provider.search('q', { limit: 5 });
    expect(capturedTopK).toBe(5);
    await provider.search('q', { limit: 9999 });
    expect(capturedTopK).toBe(100);
  });
});

describe('VectorContextProvider List (§4.1 unavailable)', () => {
  it('list returns unavailable (Vectorize has no native prefix enumeration)', async () => {
    const { provider } = setup();
    expect(await provider.list('')).toMatchObject({ code: 'unavailable' });
  });

  it('declares search capability and not delete', () => {
    const { provider } = setup();
    expect(provider.capabilities).toEqual({ search: true, delete: false });
  });
});
