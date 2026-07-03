/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from 'vitest';
import { pluginHealth, type StoredPlugin } from '../src/plugin/plugin-registry.ts';

/**
 * pluginHealth 探活逻辑单测（§11.2）——built_in / binding:<name> / 外部 HTTPS 三分支。
 * 外部探活分支用注入 fetch（不真实打网络）：2xx→healthy、非 2xx→unhealthy、抛错→unhealthy。
 * 存储 CRUD 已由 platform-plugin.test.ts 经真实 D1 路由穿透覆盖，此处只补 fetch 分支（本地不可路由触发）。
 */

const EXTERNAL: StoredPlugin = {
  id: 'ext',
  kind: 'context-provider',
  interfaceVersion: 'context-provider/v1',
  endpoint: 'https://plugin.example.com/',
  auth: { kind: 'platform-token' },
  requiredGrants: [],
  healthPath: '/health',
  enabled: true,
  builtIn: false,
};

const builtIn = (over: Partial<StoredPlugin> = {}): StoredPlugin => ({
  ...EXTERNAL,
  id: 'builtin',
  endpoint: 'binding:webhook',
  builtIn: true,
  ...over,
});

describe('pluginHealth（§11.2）', () => {
  it('built_in → healthy without probe', async () => {
    let called = false;
    const health = await pluginHealth(builtIn(), async () => {
      called = true;
      return new Response(null);
    });
    expect(health.healthy).toBe(true);
    expect(called).toBe(false);
    expect(health.detail).toContain('built-in');
  });

  it('binding:<name> endpoint (non-built-in) → healthy without probe', async () => {
    const health = await pluginHealth(
      { ...EXTERNAL, endpoint: 'binding:my-worker', builtIn: false },
      async () => new Response(null),
    );
    expect(health.healthy).toBe(true);
    expect(health.detail).toContain('in-platform');
  });

  it('external HTTPS 2xx → healthy; probes endpoint+healthPath (trailing slash trimmed)', async () => {
    let probedUrl = '';
    const health = await pluginHealth(EXTERNAL, async (input) => {
      probedUrl = String(input);
      return new Response('ok', { status: 200 });
    });
    expect(health.healthy).toBe(true);
    expect(probedUrl).toBe('https://plugin.example.com/health');
  });

  it('external HTTPS non-2xx → unhealthy with status detail', async () => {
    const health = await pluginHealth(EXTERNAL, async () => new Response('down', { status: 503 }));
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain('503');
  });

  it('external probe throws → unhealthy with reason', async () => {
    const health = await pluginHealth(EXTERNAL, async () => {
      throw new Error('connect timeout');
    });
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain('connect timeout');
  });
});
