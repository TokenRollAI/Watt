/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import type { ContextEntry, ContextEntryMeta } from '@watt/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Embedder,
  VectorContextProvider,
  type VectorIndex,
  type VectorMatch,
  type VectorQueryOptions,
  type VectorRecord,
} from '../src/context/providers/vector.ts';

/**
 * vector ContextProvider 单测——D1 sidecar 权威存储（真实 DB_CONTEXT binding）+ 注入 fake
 * Vectorize/Embedder（本地 miniflare 对 Vectorize 只 WARNING，toolchain §10）。
 * P3 关门重构：content 全文/version/metadata 权威在 D1 → Get/Update/List 从 D1 读全文（无 2048
 * 截断、List 不再 unavailable、无最终一致问题）；Vectorize 只存向量 + {namespace,path} 引用。
 * oracle 硬编码自 Proto §4.1（Write/Get/Update/List 四动词、Search 排序 + namespace filter、
 * ifVersion conflict、metadata-only Update 不重 embed）。
 */

const NS = 'research/scratch';

/** in-memory fake Vectorize：记录 upsert/query/deleteByIds 调用，query 返回预置 matches。 */
class FakeIndex implements VectorIndex {
  store = new Map<string, VectorRecord>();
  upsertCalls: VectorRecord[][] = [];
  deletedIds: string[] = [];
  lastQueryOpts: VectorQueryOptions | null = null;
  queryResult: VectorMatch[] = [];

  async upsert(vectors: VectorRecord[]): Promise<unknown> {
    this.upsertCalls.push(vectors);
    for (const v of vectors) this.store.set(v.id, v);
    return { count: vectors.length };
  }
  async query(_values: number[], opts: VectorQueryOptions): Promise<{ matches: VectorMatch[] }> {
    this.lastQueryOpts = opts;
    return { matches: this.queryResult };
  }
  async deleteByIds(ids: string[]): Promise<unknown> {
    this.deletedIds.push(...ids);
    return { count: ids.length };
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

async function clearDb() {
  await env.DB_CONTEXT.prepare('DELETE FROM entries').run();
}

beforeEach(async () => {
  await clearDb();
});

function setup(namespace = NS) {
  const index = new FakeIndex();
  const embedder = new FakeEmbedder();
  const provider = new VectorContextProvider(env.DB_CONTEXT, index, embedder, namespace);
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
  it('write embeds full content, upserts vector (id = <ns>/<path>) and persists D1 version "1"', async () => {
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
    // Vectorize metadata 只存引用 {namespace,path} + snippet（权威在 D1）。
    expect(rec?.metadata).toMatchObject({ namespace: NS, path: 'note-1' });
    expect(meta.uri).toBe('context://research/scratch/note-1');
    expect(meta.version).toBe('1');
    expect(meta.metadata).toEqual({ author: 'alice' });
  });

  it('write persists full content beyond 2048 chars (no truncation — read back from D1)', async () => {
    const { provider } = setup();
    const big = 'x'.repeat(5000);
    await provider.write('big', { contentType: 'text/plain', content: big });
    const entry = asEntry(await provider.get('big'));
    expect(entry.content).toBe(big);
    expect((entry.content as string).length).toBe(5000);
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
  it('get returns the full stored content + meta from D1', async () => {
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

  it('metadata-only update does not re-embed (skips Vectorize upsert)', async () => {
    const { index, embedder, provider } = setup();
    await provider.write('n', {
      contentType: 'text/plain',
      content: 'stable',
      metadata: { a: '1' },
    });
    expect(embedder.calls).toHaveLength(1);
    expect(index.upsertCalls).toHaveLength(1);
    // 只改 metadata，content 未变 → 不重算 embedding、不再 upsert 向量。
    const meta = asMeta(await provider.update('n', { metadata: { b: '2' } }));
    expect(meta.metadata).toEqual({ a: '1', b: '2' });
    expect(meta.version).toBe('2');
    expect(embedder.calls).toHaveLength(1); // 未新增 embed 调用
    expect(index.upsertCalls).toHaveLength(1); // 未新增 upsert
    // 但 D1 权威内容仍是原文（未损坏）。
    expect(asEntry(await provider.get('n')).content).toBe('stable');
  });

  it('update on a missing path returns not_found', async () => {
    const { provider } = setup();
    expect(await provider.update('nope', { content: 'x' })).toMatchObject({ code: 'not_found' });
  });
});

describe('VectorContextProvider Search (§4.1 可选能力)', () => {
  it('embeds the query, passes namespace filter, and reads full meta from D1 in score order', async () => {
    const { index, embedder, provider } = setup();
    // 先在 D1 落三条权威条目。
    await provider.write('a', { contentType: 'text/plain', content: 'A' });
    await provider.write('b', { contentType: 'text/plain', content: 'B' });
    await provider.write('c', { contentType: 'text/plain', content: 'C' });
    // Vectorize 返回乱序 matches（只带引用 metadata）；断言按 score 降序 + 从 D1 读回 meta。
    index.queryResult = [
      { id: 'research/scratch/a', score: 0.3, metadata: { namespace: NS, path: 'a' } },
      { id: 'research/scratch/b', score: 0.9, metadata: { namespace: NS, path: 'b' } },
      { id: 'research/scratch/c', score: 0.6, metadata: { namespace: NS, path: 'c' } },
    ];
    const page = asList(await provider.search('query text'));
    expect(embedder.calls).toContain('query text');
    // 透传 namespace $eq filter（项 3：收窄召回避免 topK 稀释）。
    expect(index.lastQueryOpts?.filter).toEqual({ namespace: { $eq: NS } });
    expect(page.map((m) => m.uri)).toEqual([
      'context://research/scratch/b',
      'context://research/scratch/c',
      'context://research/scratch/a',
    ]);
  });

  it('filters out matches from other namespaces (metadata.namespace mismatch)', async () => {
    const { index, provider } = setup();
    await provider.write('a', { contentType: 'text/plain', content: 'A' });
    index.queryResult = [
      { id: 'research/scratch/a', score: 0.9, metadata: { namespace: NS, path: 'a' } },
      { id: 'other/ns/x', score: 0.8, metadata: { namespace: 'other/ns', path: 'x' } },
    ];
    const page = asList(await provider.search('q'));
    expect(page).toHaveLength(1);
    expect(page[0]?.uri).toBe('context://research/scratch/a');
  });

  it('handles a match whose metadata lacks the namespace field (falls back to id prefix)', async () => {
    const { index, provider } = setup();
    await provider.write('a', { contentType: 'text/plain', content: 'A' });
    index.queryResult = [
      // 缺 namespace 字段但 id 前缀属本 ns → 保留（凭 id 前缀还原 path）。
      { id: 'research/scratch/a', score: 0.9, metadata: { path: 'a' } },
      // 缺 namespace 字段且 id 前缀属他 ns → 丢弃。
      { id: 'other/ns/x', score: 0.8, metadata: { path: 'x' } },
    ];
    const page = asList(await provider.search('q'));
    expect(page.map((m) => m.uri)).toEqual(['context://research/scratch/a']);
  });

  it('respects opts.limit as topK (clamped to [1,100])', async () => {
    const { index, provider } = setup();
    await provider.search('q', { limit: 5 });
    expect(index.lastQueryOpts?.topK).toBe(5);
    await provider.search('q', { limit: 9999 });
    expect(index.lastQueryOpts?.topK).toBe(100);
  });
});

describe('VectorContextProvider List (§4.1 — now backed by D1 sidecar)', () => {
  it('lists by path prefix from D1 (no longer unavailable)', async () => {
    const { provider } = setup();
    await provider.write('bugs/1', { contentType: 'text/plain', content: 'a' });
    await provider.write('bugs/2', { contentType: 'text/plain', content: 'b' });
    await provider.write('notes/1', { contentType: 'text/plain', content: 'c' });
    const page = asList(await provider.list('bugs/'));
    expect(page.map((m) => m.uri).sort()).toEqual([
      'context://research/scratch/bugs/1',
      'context://research/scratch/bugs/2',
    ]);
  });

  it('rejects an unknown filter key with invalid_argument', async () => {
    const { provider } = setup();
    expect(await provider.list('', { filter: { bogus: 'x' } })).toMatchObject({
      code: 'invalid_argument',
    });
  });

  it('declares search capability and not delete', () => {
    const { provider } = setup();
    expect(provider.capabilities).toEqual({ search: true, delete: false });
  });
});

describe('VectorContextProvider concurrency (§4.1 — conditional D1 write)', () => {
  it('a second write based on the same version conflicts (non-atomic read-modify-write guard)', async () => {
    const { provider } = setup();
    await provider.write('n', { contentType: 'text/plain', content: 'v1' }); // version "1"
    // 两次基于同一读到的 version="1" 的条件覆盖：模拟并发——先手工把 D1 版本推进到 "2"，
    // 再用陈旧 ifVersion="1" 覆盖应 conflict（条件写 WHERE version 命中 0 行）。
    await provider.write('n', { contentType: 'text/plain', content: 'v2', ifVersion: '1' });
    const conflict = await provider.write('n', {
      contentType: 'text/plain',
      content: 'v3',
      ifVersion: '1',
    });
    expect(conflict).toMatchObject({ code: 'conflict' });
  });
});

describe('VectorContextProvider purgeNamespace (§4.2 TTL 回收物理清理)', () => {
  it('deletes D1 rows and Vectorize vectors for the namespace', async () => {
    const { index, provider } = setup();
    await provider.write('a', { contentType: 'text/plain', content: 'A' });
    await provider.write('b', { contentType: 'text/plain', content: 'B' });
    await provider.purgeNamespace();
    // D1 权威行清空。
    expect(asList(await provider.list(''))).toHaveLength(0);
    // Vectorize 向量按 D1 path 集合 deleteByIds。
    expect(index.deletedIds.sort()).toEqual(['research/scratch/a', 'research/scratch/b']);
  });
});
