import { describe, expect, it } from 'vitest';
import { newArtifactId, newMemoryId } from '@watt/protocol';
import { InMemoryArtifactStore, InMemoryMemoryStore } from '../src/index.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (u: Uint8Array) => new TextDecoder().decode(u);

describe('ArtifactStore', () => {
  it('put/get 往返，含元数据', async () => {
    const store = new InMemoryArtifactStore();
    const id = newArtifactId();
    const meta = await store.put({
      artifactId: id,
      name: 'report.md',
      kind: 'markdown',
      content: bytes('# hi'),
    });
    expect(meta.sizeBytes).toBe(4);
    const got = await store.get(id);
    expect(text(got.content)).toBe('# hi');
    expect(got.meta.name).toBe('report.md');
    expect((await store.head(id)).kind).toBe('markdown');
  });

  it('内容不可变：重复 put 同 id 抛 conflict', async () => {
    const store = new InMemoryArtifactStore();
    const id = newArtifactId();
    await store.put({ artifactId: id, name: 'a', kind: 'log', content: bytes('x') });
    await expect(
      store.put({ artifactId: id, name: 'a', kind: 'log', content: bytes('y') }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('坏 artifactId 被拒', async () => {
    const store = new InMemoryArtifactStore();
    await expect(
      store.put({ artifactId: 'bad', name: 'a', kind: 'log', content: bytes('x') }),
    ).rejects.toThrow();
    await expect(store.get('also-bad')).rejects.toThrow();
  });

  it('缺失 get 抛 not_found', async () => {
    const store = new InMemoryArtifactStore();
    await expect(store.get(newArtifactId())).rejects.toMatchObject({ code: 'not_found' });
  });

  it('存储拷贝内容，外部改动不影响已存', async () => {
    const store = new InMemoryArtifactStore();
    const id = newArtifactId();
    const content = bytes('abc');
    await store.put({ artifactId: id, name: 'a', kind: 'log', content });
    content[0] = 0; // 改原数组
    expect(text((await store.get(id)).content)).toBe('abc');
  });
});

describe('MemoryStore', () => {
  it('put/get 往返', async () => {
    const store = new InMemoryMemoryStore();
    const id = newMemoryId();
    await store.put({ memoryId: id, kind: 'preference', content: 'likes concise output' });
    const got = await store.get(id);
    expect(got.content).toBe('likes concise output');
    expect(got.kind).toBe('preference');
  });

  it('同 id put 覆盖（可更新），保留 createdAt', async () => {
    const store = new InMemoryMemoryStore();
    const id = newMemoryId();
    const first = await store.put({ memoryId: id, kind: 'experience', content: 'v1' });
    await new Promise((r) => setTimeout(r, 2));
    const second = await store.put({ memoryId: id, kind: 'experience', content: 'v2' });
    expect(second.content).toBe('v2');
    expect(second.createdAt).toBe(first.createdAt);
    expect((await store.get(id)).content).toBe('v2');
  });

  it('list 可按 kind 过滤', async () => {
    const store = new InMemoryMemoryStore();
    await store.put({ memoryId: newMemoryId(), kind: 'preference', content: 'a' });
    await store.put({ memoryId: newMemoryId(), kind: 'experience', content: 'b' });
    expect(await store.list('preference')).toHaveLength(1);
    expect(await store.list()).toHaveLength(2);
  });

  it('坏 memoryId 被拒；缺失 get 抛 not_found', async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.put({ memoryId: 'bad', kind: 'x', content: 'y' }),
    ).rejects.toThrow();
    await expect(store.get(newMemoryId())).rejects.toMatchObject({ code: 'not_found' });
  });
});
