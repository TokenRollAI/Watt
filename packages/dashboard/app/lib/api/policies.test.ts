import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 视图族 C policies domain wrapper 契约测试——锁请求形状（module/tool/arguments）。
 * 形状真源 = packages/cli/src/policy.ts + gateway 路由测试（§34 禁双形态兜底）。
 */

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { policiesApi } = await import('./policies.ts');
const { setBase, setToken } = await import('../api.ts');

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function lastBody(): { tool: string; arguments: Record<string, unknown> } {
  const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return JSON.parse(init.body as string);
}

function lastUrl(): string {
  return (fetchMock.mock.calls.at(-1) as [string, RequestInit])[0];
}

beforeEach(() => {
  store.clear();
  setToken('tok-1');
  setBase('https://gw.test');
  fetchMock.mockReset();
});

describe('policies domain wrappers', () => {
  it('listPolicies (no subject) → policy List {opts:{}}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await policiesApi.listPolicies();
    expect(lastUrl()).toBe('https://gw.test/htbp/platform/policy');
    expect(lastBody()).toEqual({ tool: 'List', arguments: { opts: {} } });
  });

  it('listPolicies (subject) → filter nested under opts.filter (not flattened)', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await policiesApi.listPolicies('user:alice');
    expect(lastBody()).toEqual({
      tool: 'List',
      arguments: { opts: { filter: { subject: 'user:alice' } } },
    });
  });

  it('writePolicy → policy Write {policy}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ policy: {} }));
    await policiesApi.writePolicy({
      id: 'pol-1',
      subject: 'user:alice',
      resource: 'platform://scheduler',
      actions: ['read', 'manage'],
      effect: 'allow',
    });
    expect(lastBody()).toEqual({
      tool: 'Write',
      arguments: {
        policy: {
          id: 'pol-1',
          subject: 'user:alice',
          resource: 'platform://scheduler',
          actions: ['read', 'manage'],
          effect: 'allow',
        },
      },
    });
  });

  it('deletePolicy → policy Delete {id}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ deleted: true }));
    await policiesApi.deletePolicy('pol-1');
    expect(lastBody()).toEqual({ tool: 'Delete', arguments: { id: 'pol-1' } });
  });

  it('mapIdentity → policy MapIdentity {channel,channelUserId,principal}', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ channel: 'feishu', channelUserId: 'ou_x', principal: 'user:alice' }),
    );
    await policiesApi.mapIdentity({
      channel: 'feishu',
      channelUserId: 'ou_x',
      principal: 'user:alice',
    });
    expect(lastBody()).toEqual({
      tool: 'MapIdentity',
      arguments: { channel: 'feishu', channelUserId: 'ou_x', principal: 'user:alice' },
    });
  });
});
