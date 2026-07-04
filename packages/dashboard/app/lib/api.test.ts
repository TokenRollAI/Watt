import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Dashboard HTBP 客户端契约测试（R27 关门 MAJOR C10 收口）——锁定请求形状与错误语义，
 * 防止再次发生 listAgentInstances 传 tree:'all' 这类「视图恒空但不报错」的契约漂移。
 * 形状真源 = gateway 路由测试（api.ts 头注释约定），此处锁客户端发出的 body。
 */

// api.ts 模块级依赖 localStorage/fetch 全局——node 环境下先装 stub 再 import。
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { api, ApiError, htbp, setBase, setToken } = await import('./api.ts');

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  store.clear();
  setToken('tok-1');
  setBase('https://gw.test');
  fetchMock.mockReset();
});

describe('htbp client request shape', () => {
  it('POSTs {tool,arguments} with bearer token to /htbp/platform/<module>', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await htbp('agent', 'List', { opts: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gw.test/htbp/platform/agent');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
    expect(JSON.parse(init.body as string)).toEqual({ tool: 'List', arguments: { opts: {} } });
  });

  it('listAgentInstances sends opts WITHOUT tree (tree=<id> means subtree, not "all")', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await api.listAgentInstances();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { tool: string; arguments: { opts: object } };
    expect(body.tool).toBe('ListInstances');
    expect(body.arguments.opts).toEqual({});
    expect('tree' in body.arguments.opts).toBe(false);
  });

  it('throws ApiError with WattError code on non-2xx (bare WattError body)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'permission_denied', message: 'nope' }), {
        status: 403,
      }),
    );
    await expect(htbp('audit', 'List')).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      code: 'permission_denied',
    });
  });

  it('throws ApiError(401) before any network call when no token is set', async () => {
    store.delete('watt.token');
    await expect(htbp('agent', 'List')).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
