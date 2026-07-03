/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import type { ContextEntry, ContextEntryMeta } from '@watt/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { ObjectContextProvider } from '../src/context/providers/object.ts';

/**
 * object ContextProvider 单测（真实 R2_CONTEXT_OBJECTS binding，vitest-pool-workers）。
 * oracle 硬编码自 Proto §4.1（Write 幂等 upsert / Update not_found / metadata 浅合并 /
 * ifVersion conflict）/ §0.2（List limit 钳制）。测真实 R2 put/get/list/delete I/O。
 */

const NS = 'skills/python';

async function clearBucket() {
  const listed = await env.R2_CONTEXT_OBJECTS.list();
  for (const obj of listed.objects) {
    await env.R2_CONTEXT_OBJECTS.delete(obj.key);
  }
}

beforeEach(async () => {
  await clearBucket();
});

function provider(namespace = NS) {
  return new ObjectContextProvider(env.R2_CONTEXT_OBJECTS, namespace);
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

describe('ObjectContextProvider Write / Get (§4.1)', () => {
  it('write stores content + customMetadata and get round-trips them', async () => {
    const p = provider();
    const meta = asMeta(
      await p.write('SKILL.md', {
        contentType: 'text/markdown',
        content: '# python skill',
        metadata: { domain: 'python' },
      }),
    );
    expect(meta.uri).toBe('context://skills/python/SKILL.md');
    expect(meta.version).toBe('1');
    const entry = asEntry(await p.get('SKILL.md'));
    expect(entry.content).toBe('# python skill');
    expect(entry.contentType).toBe('text/markdown');
    expect(entry.metadata).toEqual({ domain: 'python' });
  });

  it('write is an idempotent upsert that bumps version', async () => {
    const p = provider();
    await p.write('f', { contentType: 'text/plain', content: 'v1' });
    const meta2 = asMeta(await p.write('f', { contentType: 'text/plain', content: 'v2' }));
    expect(meta2.version).toBe('2');
    expect(asEntry(await p.get('f')).content).toBe('v2');
  });

  it('get on a missing path returns not_found', async () => {
    expect(await provider().get('nope')).toMatchObject({ code: 'not_found' });
  });

  it('write with a stale ifVersion conflicts', async () => {
    const p = provider();
    await p.write('f', { contentType: 'text/plain', content: 'v1' });
    await p.write('f', { contentType: 'text/plain', content: 'v2', ifVersion: '1' }); // → "2"
    const res = await p.write('f', { contentType: 'text/plain', content: 'v3', ifVersion: '1' });
    expect(res).toMatchObject({ code: 'conflict' });
  });
});

describe('ObjectContextProvider Update (§4.1)', () => {
  it('update on a missing path returns not_found', async () => {
    expect(await provider().update('nope', { content: 'x' })).toMatchObject({ code: 'not_found' });
  });

  it('update shallow-merges metadata and replaces content, bumping version', async () => {
    const p = provider();
    await p.write('f', {
      contentType: 'text/markdown',
      content: 'orig',
      metadata: { a: '1', b: '2' },
    });
    const meta = asMeta(await p.update('f', { content: 'new', metadata: { b: '9' } }));
    expect(meta.version).toBe('2');
    expect(meta.metadata).toEqual({ a: '1', b: '9' });
    expect(asEntry(await p.get('f')).content).toBe('new');
  });
});

describe('ObjectContextProvider List (§4.1 / §0.2)', () => {
  it('lists by path prefix and strips the namespace prefix from uris', async () => {
    const p = provider();
    await p.write('a/1', { contentType: 'text/plain', content: '1' });
    await p.write('a/2', { contentType: 'text/plain', content: '2' });
    await p.write('b/1', { contentType: 'text/plain', content: '3' });
    const listed = asList(await p.list('a/'));
    expect(listed.map((m) => m.uri).sort()).toEqual([
      'context://skills/python/a/1',
      'context://skills/python/a/2',
    ]);
  });

  it('does not leak objects from other namespaces', async () => {
    const a = provider('ns/a');
    const b = provider('ns/b');
    await a.write('x', { contentType: 'text/plain', content: '1' });
    await b.write('y', { contentType: 'text/plain', content: '2' });
    const listed = asList(await a.list(''));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.uri).toBe('context://ns/a/x');
  });
});

describe('ObjectContextProvider delete_ (§4.1 optional)', () => {
  it('delete removes an object', async () => {
    const p = provider();
    await p.write('f', { contentType: 'text/plain', content: 'x' });
    await p.delete_?.('f');
    expect(await p.get('f')).toMatchObject({ code: 'not_found' });
  });
});
