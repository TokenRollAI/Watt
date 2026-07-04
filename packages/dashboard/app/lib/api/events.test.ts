import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * events domain wrapper 契约测试——锁定 event List/Get/ListSubscriptions 的请求形状。
 * 形状真源 = packages/cli/src/event.ts + gateway 路由测试；防止 filter 键漂移（服务端硬拒未知键）。
 * 模式参照 app/lib/api.test.ts：node 环境先 stub localStorage/fetch 再 import。
 */

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { eventsApi } = await import('./events.ts');
const { setBase, setToken } = await import('./core.ts');

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function lastBody(): { tool: string; arguments: Record<string, unknown> } {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string);
}

beforeEach(() => {
  store.clear();
  setToken('tok-1');
  setBase('https://gw.test');
  fetchMock.mockReset();
});

describe('events domain wrapper request shape', () => {
  it('listEvents posts List with opts.filter (whitelisted keys only) + limit at opts top-level', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await eventsApi.listEvents({ type: 'agent.result', since: '2026-07-05T00:00:00.000Z' }, 200);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gw.test/htbp/platform/event');
    expect(lastBody()).toEqual({
      tool: 'List',
      arguments: {
        opts: { filter: { type: 'agent.result', since: '2026-07-05T00:00:00.000Z' }, limit: 200 },
      },
    });
  });

  it('listEvents omits empty filter values (does not send unknown/empty keys)', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await eventsApi.listEvents({}, 100);
    expect(lastBody().arguments).toEqual({ opts: { filter: {}, limit: 100 } });
  });

  it('getEvent posts Get with {eventId}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ event: { id: 'e1' } }));
    await eventsApi.getEvent('e1');
    expect(lastBody()).toEqual({ tool: 'Get', arguments: { eventId: 'e1' } });
  });

  it('listSubscriptions posts ListSubscriptions with {opts:{}}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await eventsApi.listSubscriptions();
    expect(lastBody()).toEqual({ tool: 'ListSubscriptions', arguments: { opts: {} } });
  });
});
