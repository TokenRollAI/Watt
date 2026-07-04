import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Context domain HTBP 客户端契约测试——锁定管理面（ContextRegistry）与消费面（ContextProvider）
 * 两条链路发出的请求形状与 URL，形状真源 = packages/cli/src/context.ts + gateway context-routes 测试。
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

const { contextApi, setBase, setToken } = await import('../api.ts');

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** 取第一次 fetch 的 [url, init]。 */
function call(): [string, RequestInit] {
  return fetchMock.mock.calls[0] as [string, RequestInit];
}
/** 取第一次 fetch 的 JSON body。 */
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

describe('ContextRegistry 管理面 (§4.2)', () => {
  it('listMounts → POST /htbp/platform/context {tool:List, opts:{}}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await contextApi.listMounts();
    const [url, init] = call();
    expect(url).toBe('https://gw.test/htbp/platform/context');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
    expect(reqBody()).toEqual({ tool: 'List', arguments: { opts: {} } });
  });

  it('mount → Write {mount} 只带显式字段（无 undefined 平铺）', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ mount: {} }));
    await contextApi.mount({ namespace: 'notes', provider: 'structured' });
    expect(reqBody()).toEqual({
      tool: 'Write',
      arguments: { mount: { namespace: 'notes', provider: 'structured' } },
    });
  });

  it('mount → 透传 ttl/readOnly/providerConfig', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ mount: {} }));
    await contextApi.mount({
      namespace: 'kb',
      provider: 'vector',
      ttl: 3600,
      readOnly: true,
      providerConfig: { dim: 1024 },
    });
    expect(reqBody().arguments).toEqual({
      mount: {
        namespace: 'kb',
        provider: 'vector',
        ttl: 3600,
        readOnly: true,
        providerConfig: { dim: 1024 },
      },
    });
  });

  it('unmount → Delete {namespace}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ deleted: true }));
    await contextApi.unmount('notes');
    expect(reqBody()).toEqual({ tool: 'Delete', arguments: { namespace: 'notes' } });
  });
});

describe('ContextProvider 消费面 (§4.1，走 /htbp/context/<ns>)', () => {
  it('listEntries → POST /htbp/context/<ns> {tool:List, path, opts:{}}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await contextApi.listEntries('notes', 'sub/');
    const [url] = call();
    expect(url).toBe('https://gw.test/htbp/context/notes');
    expect(reqBody()).toEqual({ tool: 'List', arguments: { path: 'sub/', opts: {} } });
  });

  it('listEntries 缺省 path 为空串', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await contextApi.listEntries('notes');
    expect(reqBody().arguments).toEqual({ path: '', opts: {} });
  });

  it('getEntry → Get {path}，精确解包 body.entry', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ entry: { uri: 'notes/a', content: 'hi' } }));
    const entry = await contextApi.getEntry('notes', 'a');
    expect(reqBody()).toEqual({ tool: 'Get', arguments: { path: 'a' } });
    expect(entry.content).toBe('hi');
  });

  it('getEntry 缺 entry 字段 → 抛错（禁双形态兜底）', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ uri: 'notes/a', content: 'hi' }));
    await expect(contextApi.getEntry('notes', 'a')).rejects.toThrow('missing entry');
  });

  it('putEntry → Write {path, entry}，contentType 缺省 text/plain', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ meta: { uri: 'notes/a' } }));
    await contextApi.putEntry('notes', 'a', { content: 'body' });
    expect(reqBody()).toEqual({
      tool: 'Write',
      arguments: { path: 'a', entry: { content: 'body', contentType: 'text/plain' } },
    });
  });

  it('putEntry → 透传 contentType/metadata/ifVersion', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ meta: {} }));
    await contextApi.putEntry('notes', 'a', {
      content: '{}',
      contentType: 'application/json',
      metadata: { k: 'v' },
      ifVersion: 'v1',
    });
    expect(reqBody().arguments).toEqual({
      path: 'a',
      entry: {
        content: '{}',
        contentType: 'application/json',
        metadata: { k: 'v' },
        ifVersion: 'v1',
      },
    });
  });

  it('putEntry 缺 meta 字段 → 抛错', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ uri: 'notes/a' }));
    await expect(contextApi.putEntry('notes', 'a', { content: 'x' })).rejects.toThrow(
      'missing meta',
    );
  });

  it('patchEntry → Update {path, patch} 只带显式字段', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ meta: {} }));
    await contextApi.patchEntry('notes', 'a', { content: 'new' });
    expect(reqBody()).toEqual({
      tool: 'Update',
      arguments: { path: 'a', patch: { content: 'new' } },
    });
  });

  it('patchEntry 只改 metadata（content 省略）', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ meta: {} }));
    await contextApi.patchEntry('notes', 'a', { metadata: { k: 'v' } });
    expect(reqBody().arguments).toEqual({ path: 'a', patch: { metadata: { k: 'v' } } });
  });
});
