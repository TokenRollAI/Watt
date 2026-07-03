/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import type { ContextEntry, ContextEntryMeta } from '@watt/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { StructuredContextProvider } from '../src/context/providers/structured.ts';

/**
 * structured ContextProvider 单测（真实 DB_CONTEXT binding，vitest-pool-workers）。
 * oracle 硬编码自 Proto §4.1（Write 幂等 upsert / Update not_found / metadata 浅合并 /
 * ifVersion conflict）/ §0.2（List limit 默认 50 钳 200、非法 filter 键 invalid_argument）。
 * 与 core verbs 单测互补：这里测真实 D1 I/O（core 只测纯逻辑判定）。
 */

const NS = 'feedback/bugs';

async function clearDb() {
  await env.DB_CONTEXT.prepare('DELETE FROM entries').run();
}

beforeEach(async () => {
  await clearDb();
});

function provider(namespace = NS) {
  return new StructuredContextProvider(env.DB_CONTEXT, namespace);
}

function asMeta(x: ContextEntryMeta | { code: string }): ContextEntryMeta {
  if ('code' in x) throw new Error(`expected meta, got error ${x.code}`);
  return x;
}
function asEntry(x: ContextEntry | { code: string }): ContextEntry {
  if ('code' in x) throw new Error(`expected entry, got error ${x.code}`);
  return x;
}

describe('StructuredContextProvider Write / Get (§4.1)', () => {
  it('write creates an entry (version "1") and get returns content + meta', async () => {
    const p = provider();
    const meta = asMeta(
      await p.write('1235', {
        contentType: 'text/markdown',
        content: '## bug\ndetail',
        metadata: { status: 'open', severity: 'P1' },
      }),
    );
    expect(meta.uri).toBe('context://feedback/bugs/1235');
    expect(meta.version).toBe('1');
    expect(meta.metadata).toEqual({ status: 'open', severity: 'P1' });

    const entry = asEntry(await p.get('1235'));
    expect(entry.content).toBe('## bug\ndetail');
    expect(entry.contentType).toBe('text/markdown');
  });

  it('write is an idempotent upsert that bumps version', async () => {
    const p = provider();
    await p.write('id', { contentType: 'text/plain', content: 'v1' });
    const meta2 = asMeta(await p.write('id', { contentType: 'text/plain', content: 'v2' }));
    expect(meta2.version).toBe('2');
    expect(asEntry(await p.get('id')).content).toBe('v2');
  });

  it('get on a missing path returns not_found', async () => {
    const res = await provider().get('nope');
    expect(res).toMatchObject({ code: 'not_found' });
  });

  it('write with a matching ifVersion succeeds; a stale ifVersion conflicts', async () => {
    const p = provider();
    await p.write('id', { contentType: 'text/plain', content: 'v1' }); // version "1"
    const ok = await p.write('id', { contentType: 'text/plain', content: 'v2', ifVersion: '1' });
    expect('code' in ok).toBe(false);
    const conflict = await p.write('id', {
      contentType: 'text/plain',
      content: 'v3',
      ifVersion: '1', // 现版本已是 "2"
    });
    expect(conflict).toMatchObject({ code: 'conflict' });
  });
});

describe('StructuredContextProvider Update (§4.1)', () => {
  it('update on a missing path returns not_found', async () => {
    const res = await provider().update('nope', { content: 'x' });
    expect(res).toMatchObject({ code: 'not_found' });
  });

  it('update shallow-merges metadata and replaces content, bumping version', async () => {
    const p = provider();
    await p.write('id', {
      contentType: 'text/markdown',
      content: 'orig',
      metadata: { status: 'open', severity: 'P1' },
    });
    const meta = asMeta(await p.update('id', { content: 'fixed', metadata: { status: 'fixed' } }));
    expect(meta.version).toBe('2');
    // 浅合并：status 覆盖、severity 保留。
    expect(meta.metadata).toEqual({ status: 'fixed', severity: 'P1' });
    expect(asEntry(await p.get('id')).content).toBe('fixed');
  });

  it('update with a stale ifVersion conflicts', async () => {
    const p = provider();
    await p.write('id', { contentType: 'text/plain', content: 'v1' });
    await p.update('id', { content: 'v2' }); // version now "2"
    const res = await p.update('id', { content: 'v3', ifVersion: '1' });
    expect(res).toMatchObject({ code: 'conflict' });
  });
});

describe('StructuredContextProvider List (§4.1 / §0.2)', () => {
  it('lists by path prefix within the namespace', async () => {
    const p = provider();
    await p.write('bugs/1', { contentType: 'text/plain', content: 'a' });
    await p.write('bugs/2', { contentType: 'text/plain', content: 'b' });
    await p.write('notes/1', { contentType: 'text/plain', content: 'c' });
    const page = asMeta_list(await p.list('bugs/'));
    expect(page.map((m) => m.uri).sort()).toEqual([
      'context://feedback/bugs/bugs/1',
      'context://feedback/bugs/bugs/2',
    ]);
  });

  it('does not leak entries from other namespaces', async () => {
    const a = provider('ns/a');
    const b = provider('ns/b');
    await a.write('x', { contentType: 'text/plain', content: '1' });
    await b.write('y', { contentType: 'text/plain', content: '2' });
    const listed = asMeta_list(await a.list(''));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.uri).toBe('context://ns/a/x');
  });

  it('rejects an unknown filter key with invalid_argument', async () => {
    const res = await provider().list('', { filter: { bogus: 'x' } });
    expect(res).toMatchObject({ code: 'invalid_argument' });
  });

  it('clamps a negative limit up to 1', async () => {
    const p = provider();
    await p.write('a', { contentType: 'text/plain', content: '1' });
    await p.write('b', { contentType: 'text/plain', content: '2' });
    const page = asMeta_list(await p.list('', { limit: -5 }));
    expect(page).toHaveLength(1);
  });
});

describe('StructuredContextProvider delete_ (§4.1 optional)', () => {
  it('delete removes an entry (missing is a no-op)', async () => {
    const p = provider();
    await p.write('id', { contentType: 'text/plain', content: 'x' });
    await p.delete_?.('missing');
    await p.delete_?.('id');
    expect(await p.get('id')).toMatchObject({ code: 'not_found' });
  });
});

describe('StructuredContextProvider concurrency (§4.1 — conditional write, P3 项 2)', () => {
  it('two conditional updates based on the same version: the second conflicts', async () => {
    const p = provider();
    await p.write('id', { contentType: 'text/plain', content: 'v1' }); // version "1"
    // 两次都基于读到的 version="1" 做条件 UPDATE：第一次成功推进到 "2"，
    // 第二次仍用陈旧 ifVersion="1" → 条件写 WHERE version='1' 命中 0 行 → conflict。
    const first = await p.update('id', { content: 'v2', ifVersion: '1' });
    expect('code' in first).toBe(false);
    const second = await p.update('id', { content: 'v3', ifVersion: '1' });
    expect(second).toMatchObject({ code: 'conflict' });
  });

  it('purgeNamespace deletes all rows for the namespace only', async () => {
    const a = provider('ns/a');
    const b = provider('ns/b');
    await a.write('x', { contentType: 'text/plain', content: '1' });
    await b.write('y', { contentType: 'text/plain', content: '2' });
    await a.purgeNamespace();
    expect(asMeta_list(await a.list(''))).toHaveLength(0);
    // 他 namespace 不受影响。
    expect(asMeta_list(await b.list(''))).toHaveLength(1);
  });
});

function asMeta_list(x: { items: ContextEntryMeta[] } | { code: string }): ContextEntryMeta[] {
  if ('code' in x) throw new Error(`expected page, got error ${x.code}`);
  return x.items;
}
