/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import type { TokenClaims } from '@watt/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agent/agent-registry.ts';
import {
  ensureManageDefsSeeded,
  MANAGE_CRON_DEF,
  resetManageSeedGuardForTests,
  resolveManageBinding,
  SEED_MANAGE_DEFS,
} from '../src/agent/manage/manage-defs.ts';
import type { Bindings } from '../src/env.ts';

/**
 * manage/* 内置定义 + 运行时绑定单测（R25 DoD④ / M10）。
 *  - resolveManageBinding：manage/cron → scheduler 工具（scheduler_write/list）+ cron ~skill；
 *    manage/platform → prompt 无工具；非 manage → undefined。
 *  - ensureManageDefsSeeded：幂等写入 AgentRegistry（读回可见），once-guard 短路。
 */

const bindings = env as unknown as Bindings;
const CLAIMS: TokenClaims = { sub: 'user:admin', roles: ['admin'] };

beforeEach(() => {
  resetManageSeedGuardForTests();
});

describe('resolveManageBinding (M10)', () => {
  it('manage/cron → cron ~skill prompt + scheduler_write/list tools', () => {
    const binding = resolveManageBinding('manage/cron');
    expect(binding).toBeDefined();
    expect(binding?.systemPrompt).toContain('cron');
    const tools = binding?.buildTools(bindings, CLAIMS, 'tr-1') ?? [];
    expect(tools.map((t) => t.name).sort()).toEqual(['scheduler_list', 'scheduler_write']);
  });

  it('manage/platform → prompt, no tools', () => {
    const binding = resolveManageBinding('manage/platform');
    expect(binding).toBeDefined();
    expect(binding?.buildTools(bindings, CLAIMS)).toEqual([]);
  });

  it('non-manage definition → undefined (no tool injection)', () => {
    expect(resolveManageBinding('echo')).toBeUndefined();
    expect(resolveManageBinding('deep-research')).toBeUndefined();
  });
});

describe('MANAGE_CRON_DEF shape (§3.1)', () => {
  it('is a light do-class AgentInstance with model + scheduler manage grant', () => {
    expect(MANAGE_CRON_DEF).toMatchObject({
      name: 'manage/cron',
      runtime: 'light',
      entry: { kind: 'do-class', className: 'AgentInstance' },
      model: { preferred: 'glm-5.2' },
      grants: [{ resources: ['platform://scheduler'], actions: ['manage', 'read'] }],
    });
  });
});

describe('ensureManageDefsSeeded (幂等 / once-guard)', () => {
  it('seeds all manage defs into AgentRegistry (readable back)', async () => {
    const registry = new AgentRegistry(bindings.DB_PROVIDERS);
    await ensureManageDefsSeeded(registry);
    for (const def of SEED_MANAGE_DEFS) {
      const got = await registry.get(def.name);
      expect(got).toMatchObject({ name: def.name, runtime: 'light' });
    }
  });

  it('is idempotent (re-seed does not error; upsert)', async () => {
    const registry = new AgentRegistry(bindings.DB_PROVIDERS);
    await ensureManageDefsSeeded(registry);
    resetManageSeedGuardForTests();
    await ensureManageDefsSeeded(registry);
    const list = await registry.list({ limit: 200 });
    if ('items' in list) {
      const cronCount = list.items.filter((d) => d.name === 'manage/cron').length;
      expect(cronCount).toBe(1);
    }
  });
});
