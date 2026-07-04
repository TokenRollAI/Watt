import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P6 配置面 HTBP 客户端契约测试——锁定 Secret/Channel/Plugin/Provider 四组 wrapper 发出的请求形状
 * 与 formatError 语义（403 → "当前 token 无权限"），沿用 api.test.ts 的 node-env + stub 风格。
 * 形状真源 = gateway 路由测试（platform-{secret,plugin,provider}.test.ts + channel 段）。
 */

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { api, ApiError, formatError, setBase, setToken } = await import('./api.ts');

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function body(): { tool: string; arguments: Record<string, unknown> } {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string) as { tool: string; arguments: Record<string, unknown> };
}

beforeEach(() => {
  store.clear();
  setToken('tok-1');
  setBase('https://gw.test');
  fetchMock.mockReset();
});

describe('SecretStore wrappers (§6.6)', () => {
  it('listSecrets → POST secret List with empty args', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await api.listSecrets();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://gw.test/htbp/platform/secret');
    expect(body()).toEqual({ tool: 'List', arguments: {} });
  });

  it('writeSecret → name/value at args top-level (NOT opts envelope)', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ secret: { name: 'K', updatedAt: 'now' } }));
    await api.writeSecret('API_KEY', 'plaintext');
    expect(body()).toEqual({ tool: 'Write', arguments: { name: 'API_KEY', value: 'plaintext' } });
  });

  it('deleteSecret → Delete with name', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ deleted: true }));
    await api.deleteSecret('API_KEY');
    expect(body()).toEqual({ tool: 'Delete', arguments: { name: 'API_KEY' } });
  });
});

describe('ChannelRegistry wrappers (§2.2)', () => {
  it('listChannels → List opts:{}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await api.listChannels();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://gw.test/htbp/platform/channel');
    expect(body()).toEqual({ tool: 'List', arguments: { opts: {} } });
  });

  it('updateChannel → Update {channelId,patch}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ channel: {} }));
    await api.updateChannel('feishu', { enabled: false });
    expect(body()).toEqual({
      tool: 'Update',
      arguments: { channelId: 'feishu', patch: { enabled: false } },
    });
  });
});

describe('PluginRegistry wrappers (§11)', () => {
  it('getPlugin → Get {pluginId}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ plugin: {} }));
    await api.getPlugin('channel-feishu');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://gw.test/htbp/platform/plugin');
    expect(body()).toEqual({ tool: 'Get', arguments: { pluginId: 'channel-feishu' } });
  });

  it('pluginHealth → Health {pluginId}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ health: { healthy: true } }));
    await api.pluginHealth('channel-feishu');
    expect(body()).toEqual({ tool: 'Health', arguments: { pluginId: 'channel-feishu' } });
  });
});

describe('ModelProviderRegistry wrappers (§9)', () => {
  it('listProviders → List opts:{}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await api.listProviders();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://gw.test/htbp/platform/provider');
    expect(body().tool).toBe('List');
  });

  it('writeProvider → Write {provider} passthrough', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ provider: {} }));
    const prov = {
      id: 'p1',
      vendor: 'anthropic',
      models: ['glm-5.2'],
      priority: 10,
      default: false,
      secretRef: 'ANTHROPIC_API_KEY',
      enabled: true,
    };
    await api.writeProvider(prov);
    expect(body()).toEqual({ tool: 'Write', arguments: { provider: prov } });
  });

  it('setDefaultProvider → SetDefault {providerId}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ provider: {} }));
    await api.setDefaultProvider('p1');
    expect(body()).toEqual({ tool: 'SetDefault', arguments: { providerId: 'p1' } });
  });
});

describe('formatError (403 unified)', () => {
  it('403 → 当前 token 无权限', () => {
    expect(formatError(new ApiError('permission_denied', 403, 'permission_denied'))).toContain(
      '无权限',
    );
  });
  it('network error (status 0) → 可重试提示', () => {
    expect(formatError(new ApiError('Cannot reach', 0))).toContain('可重试');
  });
  it('other status → backend message', () => {
    expect(formatError(new ApiError('not found', 404))).toBe('not found');
  });
  it('non-ApiError → String(e)', () => {
    expect(formatError(new Error('boom'))).toBe('Error: boom');
  });
});
