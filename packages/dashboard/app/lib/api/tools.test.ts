import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tools domain HTBP 客户端契约测试——锁定管理面（ToolRegistry）与消费面（watt-toolbridge 代理）
 * 两条链路发出的请求形状与 URL end-path 契约，形状真源 = packages/cli/src/tool.ts + gateway tools-proxy 测试。
 * 沿用 api.test.ts 的 node-env + stub localStorage/fetch 风格。
 */

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { toolsApi, setBase, setToken } = await import('../api.ts');

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
function okText(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/plain' } });
}

function call(): [string, RequestInit] {
  return fetchMock.mock.calls[0] as [string, RequestInit];
}
function reqBody(): { tool: string; arguments: Record<string, unknown> } {
  const [, init] = call();
  return JSON.parse(init.body as string) as { tool: string; arguments: Record<string, unknown> };
}

beforeEach(() => {
  store.clear();
  setToken('tok-1');
  setBase('https://gw.test');
  fetchMock.mockReset();
});

describe('ToolRegistry 管理面 (§5.2)', () => {
  it('listMounts → POST /htbp/platform/tool {tool:List, opts:{}}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await toolsApi.listMounts();
    const [url, init] = call();
    expect(url).toBe('https://gw.test/htbp/platform/tool');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
    expect(reqBody()).toEqual({ tool: 'List', arguments: { opts: {} } });
  });

  it('mount → Write {mount:{path,provider,enabled}}（无 providerConfig 不平铺）', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ mount: {} }));
    await toolsApi.mount({ path: 'weather', provider: 'builtin', enabled: true });
    expect(reqBody()).toEqual({
      tool: 'Write',
      arguments: { mount: { path: 'weather', provider: 'builtin', enabled: true } },
    });
  });

  it('mount → http provider 透传 providerConfig（HttpEndpointConfig {endpoints:[...]}）', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ mount: {} }));
    const providerConfig = { endpoints: [{ name: 'geocode', url: 'https://api.example/geo' }] };
    await toolsApi.mount({ path: 'geo', provider: 'http', enabled: true, providerConfig });
    expect(reqBody().arguments).toEqual({
      mount: { path: 'geo', provider: 'http', enabled: true, providerConfig },
    });
  });
});

describe('ToolProvider 消费面 (§5.1，代理到 watt-toolbridge)', () => {
  it('describe → GET /htbp/tools/<path>/~help，Accept text/plain', async () => {
    fetchMock.mockResolvedValueOnce(okText('# tool help'));
    const text = await toolsApi.describe('weather');
    const [url, init] = call();
    expect(url).toBe('https://gw.test/htbp/tools/weather/~help');
    expect(init.method ?? 'GET').toBe('GET');
    expect((init.headers as Record<string, string>).accept).toBe('text/plain');
    expect(text).toBe('# tool help');
  });

  it('describe 根路径（空 path）→ /htbp/tools/~help', async () => {
    fetchMock.mockResolvedValueOnce(okText('root'));
    await toolsApi.describe('');
    const [url] = call();
    expect(url).toBe('https://gw.test/htbp/tools/~help');
  });

  it('call → POST /htbp/tools/<path>/<tool>，body {arguments} 信封，工具名走 URL end-path', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ resource: 'r', result: { temp: 20 } }));
    const out = await toolsApi.call('weather', 'forecast', { city: 'SF' });
    const [url, init] = call();
    expect(url).toBe('https://gw.test/htbp/tools/weather/forecast');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ arguments: { city: 'SF' } });
    expect(out).toEqual({ resource: 'r', result: { temp: 20 } });
  });

  it('call 工具名经 encodeURIComponent', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ result: null }));
    await toolsApi.call('ns', 'a b', {});
    const [url] = call();
    expect(url).toBe('https://gw.test/htbp/tools/ns/a%20b');
  });

  it('call 缺 result 字段 → 抛错（禁双形态兜底）', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ resource: 'r' }));
    await expect(toolsApi.call('weather', 'forecast', {})).rejects.toThrow('missing result');
  });
});
