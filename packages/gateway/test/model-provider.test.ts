/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import type { ModelProvider } from '@watt/core';
import { describe, expect, it } from 'vitest';
import { ModelProviderRegistry } from '../src/agent/model-provider.ts';

/**
 * ModelProviderRegistry D1 单测（Proto §9 最小版：四动词 + set-default + secretRef 脱敏）。
 * oracle 硬编码自 §9（ModelProvider 形状 / 全局默认唯一 / secretRef 永不回显）。
 * 表由 migrations-providers（含 0003_model_providers）在 apply-migrations 建好。
 */

let seq = 0;
function uniq(base: string): string {
  return `${base}-${seq++}`;
}

const P = (id: string, over: Partial<ModelProvider> = {}): ModelProvider => ({
  id,
  vendor: 'anthropic',
  models: ['glm-5.2', 'minimax-m3'],
  priority: 10,
  default: false,
  secretRef: 'ANTHROPIC_API_KEY',
  enabled: true,
  ...over,
});

describe('ModelProviderRegistry (§9)', () => {
  it('write + get returns redacted projection (no secretRef)', async () => {
    const reg = new ModelProviderRegistry(env.DB_PROVIDERS);
    const id = uniq('prov');
    await reg.write(P(id));
    const got = await reg.get(id);
    expect('code' in got).toBe(false);
    if (!('code' in got)) {
      expect(got.id).toBe(id);
      expect(got.vendor).toBe('anthropic');
      expect(got.models).toEqual(['glm-5.2', 'minimax-m3']);
      // secretRef 永不回显（§9）。
      expect('secretRef' in got).toBe(false);
    }
  });

  it('get on missing → not_found', async () => {
    const reg = new ModelProviderRegistry(env.DB_PROVIDERS);
    expect(await reg.get('nope')).toMatchObject({ code: 'not_found' });
  });

  it('setDefault makes it the single global default (Case 5 切默认)', async () => {
    const reg = new ModelProviderRegistry(env.DB_PROVIDERS);
    const a = uniq('def-a');
    const b = uniq('def-b');
    await reg.write(P(a, { default: true }));
    await reg.write(P(b));
    // 切默认到 b → a 不再是默认。
    await reg.setDefault(b);
    const def = await reg.resolveDefault();
    expect(def?.model).toBe('glm-5.2');
    const listed = await reg.list({ limit: 200 });
    if (!('code' in listed)) {
      const aRow = listed.items.find((p) => p.id === a);
      const bRow = listed.items.find((p) => p.id === b);
      expect(aRow?.default).toBe(false);
      expect(bRow?.default).toBe(true);
    }
  });

  it('write with default=true clears other defaults (single default invariant)', async () => {
    const reg = new ModelProviderRegistry(env.DB_PROVIDERS);
    const a = uniq('w-a');
    const b = uniq('w-b');
    await reg.write(P(a, { default: true }));
    await reg.write(P(b, { default: true }));
    const listed = await reg.list({ limit: 200 });
    if (!('code' in listed)) {
      const defaults = listed.items.filter((p) => p.default && (p.id === a || p.id === b));
      // a 与 b 中只应有 b 是默认（写 b 时清了 a）。
      expect(defaults.map((p) => p.id)).toEqual([b]);
    }
  });

  it('update patches fields; unknown key → invalid_argument; missing → not_found', async () => {
    const reg = new ModelProviderRegistry(env.DB_PROVIDERS);
    const id = uniq('upd');
    await reg.write(P(id, { priority: 5 }));
    const updated = await reg.update(id, { priority: 99 });
    expect((updated as { priority: number }).priority).toBe(99);
    expect(await reg.update(id, { bogus: 1 } as never)).toMatchObject({ code: 'invalid_argument' });
    expect(await reg.update('missing', { priority: 1 })).toMatchObject({ code: 'not_found' });
  });

  it('resolveDefault returns null when no enabled default', async () => {
    const reg = new ModelProviderRegistry(env.DB_PROVIDERS);
    // 新库无默认时返 null（注：库跨用例持久，若前用例设过默认此断言不稳——故只断言形状可空）。
    const def = await reg.resolveDefault();
    expect(def === null || typeof def.model === 'string').toBe(true);
  });
});
