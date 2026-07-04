import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * agents domain wrapper 契约测试——锁定 agent List/Get/ListInstances/Spawn/Send/Terminate 请求形状。
 * 形状真源 = packages/cli/src/agent.ts + gateway packages/gateway/test/platform-agent.test.ts。
 * 尤其锁：ListInstances 全列不带 tree、tree 语义=某实例子树（非 'all'）、Send 带 expect{correlationId}
 * 的对话链路形状。模式参照 app/lib/api.test.ts：node 环境先 stub localStorage/fetch 再 import。
 */

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { agentsApi, newCorrelationId } = await import('./agents.ts');
const { setBase, setToken } = await import('./core.ts');

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function lastCall(): { url: string; body: { tool: string; arguments: Record<string, unknown> } } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, body: JSON.parse(init.body as string) };
}

beforeEach(() => {
  store.clear();
  setToken('tok-1');
  setBase('https://gw.test');
  fetchMock.mockReset();
});

describe('agents domain wrapper request shape', () => {
  it('listAgentDefs posts List with {opts:{}} to /htbp/platform/agent', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await agentsApi.listAgentDefs();
    const { url, body } = lastCall();
    expect(url).toBe('https://gw.test/htbp/platform/agent');
    expect(body).toEqual({ tool: 'List', arguments: { opts: {} } });
  });

  it('getAgentDef posts Get with {name}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ definition: { name: 'manage/cron' } }));
    await agentsApi.getAgentDef('manage/cron');
    expect(lastCall().body).toEqual({ tool: 'Get', arguments: { name: 'manage/cron' } });
  });

  it('listAgentInstances sends ListInstances with opts WITHOUT tree', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await agentsApi.listAgentInstances();
    const { body } = lastCall();
    expect(body.tool).toBe('ListInstances');
    expect(body.arguments.opts).toEqual({});
    expect('tree' in (body.arguments.opts as object)).toBe(false);
  });

  it('listAgentSubtree sends ListInstances with opts.tree=<instanceId> (subtree, not "all")', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await agentsApi.listAgentSubtree('root/i1');
    expect(lastCall().body).toEqual({
      tool: 'ListInstances',
      arguments: { opts: { tree: 'root/i1' } },
    });
  });

  it('spawnAgent posts Spawn with {request}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ instance: { instanceId: 'i1' } }));
    await agentsApi.spawnAgent({ definition: 'manage/cron', input: { foo: 1 } });
    expect(lastCall().body).toEqual({
      tool: 'Spawn',
      arguments: { request: { definition: 'manage/cron', input: { foo: 1 } } },
    });
  });

  it('sendAgent WITHOUT expect posts Send with {instanceId,event} (no expect key)', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ accepted: true }));
    const event = { source: { kind: 'system' }, type: 'agent.message', payload: { text: 'hi' } };
    await agentsApi.sendAgent('i1', event);
    const { body } = lastCall();
    expect(body.tool).toBe('Send');
    expect(body.arguments).toEqual({ instanceId: 'i1', event });
    expect('expect' in body.arguments).toBe(false);
  });

  it('sendAgent WITH expect posts Send carrying expect{correlationId,timeoutMs} (manage chat link)', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ accepted: true, correlationId: 'cid1' }));
    const event = { source: { kind: 'system' }, type: 'agent.message', payload: { text: 'hi' } };
    await agentsApi.sendAgent('i1', event, { correlationId: 'cid1', timeoutMs: 60000 });
    expect(lastCall().body).toEqual({
      tool: 'Send',
      arguments: { instanceId: 'i1', event, expect: { correlationId: 'cid1', timeoutMs: 60000 } },
    });
  });

  it('terminateAgent posts Terminate with {instanceId,cascade}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ terminated: true }));
    await agentsApi.terminateAgent('i1', true);
    expect(lastCall().body).toEqual({
      tool: 'Terminate',
      arguments: { instanceId: 'i1', cascade: true },
    });
  });

  it('pollCorrelation posts event List with {opts:{filter:{correlationId},limit}} (manage reply poll)', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await agentsApi.pollCorrelation('cid1', 10);
    const { url, body } = lastCall();
    expect(url).toBe('https://gw.test/htbp/platform/event');
    expect(body).toEqual({
      tool: 'List',
      arguments: { opts: { filter: { correlationId: 'cid1' }, limit: 10 } },
    });
  });
});

describe('newCorrelationId', () => {
  it('yields a whitelist-safe id ([A-Za-z0-9_-], length ≤80)', () => {
    const cid = newCorrelationId();
    expect(cid).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cid.length).toBeLessThanOrEqual(80);
    expect(cid).not.toContain('-');
  });
});
