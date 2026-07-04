import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 视图族 C tasks/cron domain wrapper 契约测试——锁请求形状（module/tool/arguments），
 * 形状真源 = packages/cli/src/task.ts、cron.ts + gateway 路由测试（§34 禁双形态兜底）。
 * 模式参照 app/lib/api.test.ts：先 stub localStorage/fetch 再 import。
 */

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { tasksApi } = await import('./tasks.ts');
const { api, setBase, setToken } = await import('../api.ts');

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

describe('tasks domain wrappers', () => {
  it('getTask → task Get {taskId}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ task: {} }));
    await tasksApi.getTask('t-1');
    expect(lastUrl()).toBe('https://gw.test/htbp/platform/task');
    expect(lastBody()).toEqual({ tool: 'Get', arguments: { taskId: 't-1' } });
  });

  it('listTaskDefs → task ListDefinitions {}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await tasksApi.listTaskDefs();
    expect(lastBody()).toEqual({ tool: 'ListDefinitions', arguments: {} });
  });

  it('runTask → task Write {request} (input omitted when undefined)', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ task: {} }));
    await tasksApi.runTask({ definition: 'echo' });
    expect(lastBody()).toEqual({ tool: 'Write', arguments: { request: { definition: 'echo' } } });
  });

  it('runTask → carries input when provided', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ task: {} }));
    await tasksApi.runTask({ definition: 'echo', input: { a: 1 } });
    expect(lastBody().arguments).toEqual({ request: { definition: 'echo', input: { a: 1 } } });
  });

  it('signalTask → task Signal {taskId,signal}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ signalled: true }));
    await tasksApi.signalTask('t-1', { checkpoint: 'approve-cp', decision: 'approve' });
    expect(lastBody()).toEqual({
      tool: 'Signal',
      arguments: { taskId: 't-1', signal: { checkpoint: 'approve-cp', decision: 'approve' } },
    });
  });

  it('cancelTask → task Cancel {taskId} (no reason key when undefined)', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ cancelled: true }));
    await tasksApi.cancelTask('t-1');
    expect(lastBody()).toEqual({ tool: 'Cancel', arguments: { taskId: 't-1' } });
  });

  it('cancelTask → includes reason when provided', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ cancelled: true }));
    await tasksApi.cancelTask('t-1', 'obsolete');
    expect(lastBody().arguments).toEqual({ taskId: 't-1', reason: 'obsolete' });
  });
});

describe('cron domain wrappers (Get/Trigger here; List/Write/Delete in platform.ts)', () => {
  it('getCron → scheduler Get {jobId}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ job: {} }));
    await tasksApi.getCron('daily');
    expect(lastUrl()).toBe('https://gw.test/htbp/platform/scheduler');
    expect(lastBody()).toEqual({ tool: 'Get', arguments: { jobId: 'daily' } });
  });

  it('triggerCron → scheduler Trigger {jobId}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ eventId: 'evt-1' }));
    await tasksApi.triggerCron('daily');
    expect(lastBody()).toEqual({ tool: 'Trigger', arguments: { jobId: 'daily' } });
  });

  it('createCron (platform.ts) → scheduler Write {job} with publish action shape', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ job: {} }));
    await api.createCron({
      id: 'daily',
      description: 'd',
      schedule: '0 9 * * *',
      enabled: true,
      action: { kind: 'publish', event: { type: 'report.daily' } },
    });
    expect(lastBody()).toEqual({
      tool: 'Write',
      arguments: {
        job: {
          id: 'daily',
          description: 'd',
          schedule: '0 9 * * *',
          enabled: true,
          action: { kind: 'publish', event: { type: 'report.daily' } },
        },
      },
    });
  });
});
