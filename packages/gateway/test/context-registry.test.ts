/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from 'cloudflare:test';
import type { NamespaceMount } from '@watt/core';
import { describe, expect, it } from 'vitest';
import type { ContextRegistry } from '../src/context/context-registry.ts';

/**
 * ContextRegistry DO 单测（真实 workerd DO，vitest-pool-workers runInDurableObject）。
 * oracle 硬编码自 Proto §4.2（List/Get/Write/Update/Delete/Resolve、NamespaceMount 形状、
 * ttl 到期整个 namespace 回收）/ §0.2（Page、limit 默认 50 钳 200）。
 *
 * 每个用例用唯一 idFromName 取独立 DO 实例（DO storage 跨用例持久，避免串扰）。
 * TTL 惰性回收测试：直接操纵 DO storage.sql 把 mounted_at/expires_at 注入到过去（access
 *   private sql via cast——private 仅编译期约束，运行时可达；比 sleep 更确定）。
 */

let counter = 0;
function freshRegistry() {
  const id = env.CONTEXT_REGISTRY.idFromName(`registry-test-${counter++}`);
  return env.CONTEXT_REGISTRY.get(id);
}

const M = (over: Partial<NamespaceMount> = {}): NamespaceMount => ({
  namespace: 'feedback/bugs',
  provider: 'structured',
  ...over,
});

/** 把某挂载的 mounted_at/expires_at 直接改到过去（模拟已过期），绕过 write 的 new Date()。 */
type SqlHost = { sql: { exec: (q: string, ...b: unknown[]) => unknown } };
function expireMount(instance: ContextRegistry, namespace: string): void {
  const past = new Date(Date.now() - 3600_000).toISOString();
  (instance as unknown as SqlHost).sql.exec(
    'UPDATE mounts SET mounted_at = ?, expires_at = ? WHERE namespace = ?',
    past,
    past,
    namespace,
  );
}

describe('ContextRegistry write / get / list (§4.2 / §0.2)', () => {
  it('write mounts a namespace and get returns it', async () => {
    const stub = freshRegistry();
    const written = await runInDurableObject(stub, (r: ContextRegistry) =>
      r.write(M({ namespace: 'skills/python', provider: 'object', readOnly: true })),
    );
    expect('code' in written).toBe(false);
    const got = await runInDurableObject(stub, (r: ContextRegistry) => r.get('skills/python'));
    expect(got).toEqual({ namespace: 'skills/python', provider: 'object', readOnly: true });
  });

  it('write is an idempotent upsert (re-mount replaces provider)', async () => {
    const stub = freshRegistry();
    await runInDurableObject(stub, (r: ContextRegistry) =>
      r.write(M({ namespace: 'ns/a', provider: 'object' })),
    );
    await runInDurableObject(stub, (r: ContextRegistry) =>
      r.write(M({ namespace: 'ns/a', provider: 'vector' })),
    );
    const got = await runInDurableObject(stub, (r: ContextRegistry) => r.get('ns/a'));
    expect((got as NamespaceMount).provider).toBe('vector');
    const page = await runInDurableObject(stub, (r: ContextRegistry) => r.list());
    expect(page.items).toHaveLength(1);
  });

  it('get on a missing namespace returns not_found', async () => {
    const stub = freshRegistry();
    const got = await runInDurableObject(stub, (r: ContextRegistry) => r.get('nope'));
    expect(got).toMatchObject({ code: 'not_found' });
  });

  it('write rejects an invalid mount (missing provider) with invalid_argument', async () => {
    const stub = freshRegistry();
    const res = await runInDurableObject(stub, (r: ContextRegistry) =>
      r.write({ namespace: 'x' } as unknown as NamespaceMount),
    );
    expect(res).toMatchObject({ code: 'invalid_argument' });
  });

  it('list clamps a negative limit up to 1 and an over-large limit down to 200', async () => {
    const stub = freshRegistry();
    await runInDurableObject(stub, (r: ContextRegistry) => {
      return Promise.all([r.write(M({ namespace: 'ns/a' })), r.write(M({ namespace: 'ns/b' }))]);
    });
    const clampedLow = await runInDurableObject(stub, (r: ContextRegistry) =>
      r.list({ limit: -5 }),
    );
    expect(clampedLow.items).toHaveLength(1);
    const clampedHigh = await runInDurableObject(stub, (r: ContextRegistry) =>
      r.list({ limit: 9999 }),
    );
    expect(clampedHigh.items).toHaveLength(2);
  });
});

describe('ContextRegistry update / delete (§4.2)', () => {
  it('update patches provider without touching namespace', async () => {
    const stub = freshRegistry();
    await runInDurableObject(stub, (r: ContextRegistry) =>
      r.write(M({ namespace: 'ns/a', provider: 'object' })),
    );
    const updated = await runInDurableObject(stub, (r: ContextRegistry) =>
      r.update('ns/a', { provider: 'structured' }),
    );
    expect(updated).toMatchObject({ namespace: 'ns/a', provider: 'structured' });
  });

  it('update on a missing namespace returns not_found', async () => {
    const stub = freshRegistry();
    const res = await runInDurableObject(stub, (r: ContextRegistry) =>
      r.update('nope', { provider: 'object' }),
    );
    expect(res).toMatchObject({ code: 'not_found' });
  });

  it('delete unmounts the namespace (missing is a no-op)', async () => {
    const stub = freshRegistry();
    await runInDurableObject(stub, (r: ContextRegistry) => r.write(M({ namespace: 'ns/a' })));
    await runInDurableObject(stub, (r: ContextRegistry) => {
      r.delete('does-not-exist');
      r.delete('ns/a');
    });
    const got = await runInDurableObject(stub, (r: ContextRegistry) => r.get('ns/a'));
    expect(got).toMatchObject({ code: 'not_found' });
  });
});

describe('ContextRegistry resolve (§4.2 URI → provider/path)', () => {
  it('resolves a context:// uri to provider + relative path via longest-prefix mount', async () => {
    const stub = freshRegistry();
    await runInDurableObject(stub, (r: ContextRegistry) => {
      return Promise.all([
        r.write(M({ namespace: 'feedback', provider: 'object' })),
        r.write(M({ namespace: 'feedback/bugs', provider: 'structured' })),
      ]);
    });
    const res = await runInDurableObject(stub, (r: ContextRegistry) =>
      r.resolve('context://feedback/bugs/1235'),
    );
    expect(res).toEqual({ provider: 'structured', path: '1235' });
  });

  it('resolve returns not_found when no mount matches', async () => {
    const stub = freshRegistry();
    const res = await runInDurableObject(stub, (r: ContextRegistry) =>
      r.resolve('context://unmounted/x'),
    );
    expect(res).toMatchObject({ code: 'not_found' });
  });

  it('resolve returns invalid_argument for a non-context uri', async () => {
    const stub = freshRegistry();
    const res = await runInDurableObject(stub, (r: ContextRegistry) => r.resolve('http://x/y'));
    expect(res).toMatchObject({ code: 'invalid_argument' });
  });
});

describe('ContextRegistry TTL lazy reclaim (§4.2 ttl 到期整 namespace 回收)', () => {
  it('get on an expired mount returns not_found and removes the row', async () => {
    const stub = freshRegistry();
    await runInDurableObject(stub, (r: ContextRegistry) =>
      r.write(M({ namespace: 'tmp/scratch', ttl: 60 })),
    );
    await runInDurableObject(stub, (r: ContextRegistry) => expireMount(r, 'tmp/scratch'));
    const got = await runInDurableObject(stub, (r: ContextRegistry) => r.get('tmp/scratch'));
    expect(got).toMatchObject({ code: 'not_found' });
    // 惰性回收后行已删：list 不再返回。
    const page = await runInDurableObject(stub, (r: ContextRegistry) => r.list());
    expect(page.items).toHaveLength(0);
  });

  it('resolve on an expired mount returns not_found (mount reclaimed)', async () => {
    const stub = freshRegistry();
    await runInDurableObject(stub, (r: ContextRegistry) =>
      r.write(M({ namespace: 'tmp/scratch', provider: 'object', ttl: 60 })),
    );
    await runInDurableObject(stub, (r: ContextRegistry) => expireMount(r, 'tmp/scratch'));
    const res = await runInDurableObject(stub, (r: ContextRegistry) =>
      r.resolve('context://tmp/scratch/x'),
    );
    expect(res).toMatchObject({ code: 'not_found' });
  });

  it('list drops expired mounts and keeps live ones', async () => {
    const stub = freshRegistry();
    await runInDurableObject(stub, (r: ContextRegistry) => {
      return Promise.all([
        r.write(M({ namespace: 'live/one', ttl: 60 })),
        r.write(M({ namespace: 'dead/two', ttl: 60 })),
      ]);
    });
    await runInDurableObject(stub, (r: ContextRegistry) => expireMount(r, 'dead/two'));
    const page = await runInDurableObject(stub, (r: ContextRegistry) => r.list());
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.namespace).toBe('live/one');
  });

  it('a mount without ttl never expires', async () => {
    const stub = freshRegistry();
    await runInDurableObject(stub, (r: ContextRegistry) => r.write(M({ namespace: 'perm/keep' })));
    // 即便把 mounted_at 推到很久以前，无 ttl 也不回收。
    await runInDurableObject(stub, (r: ContextRegistry) => expireMount(r, 'perm/keep'));
    const got = await runInDurableObject(stub, (r: ContextRegistry) => r.get('perm/keep'));
    expect(got).toMatchObject({ namespace: 'perm/keep' });
  });
});
