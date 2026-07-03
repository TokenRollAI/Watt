import { describe, expect, it, vi } from 'vitest';
import { run } from './cli.ts';

/**
 * `watt task list|get|run|signal|cancel|defs` 命令测试（fetch 注入）。
 * 断言 HTBP 请求体（tool/arguments）与响应形状解析——形状真源 = gateway platform-task.test.ts
 * （§34 禁双形态兜底：CLI 照抄 { task } / 裸 Page{items} / { cancelled:true } / { signalled:true }）。
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ENV = { WATT_BASE_URL: 'https://x', WATT_TOKEN: 'tok-test' };

function scriptedFetch(responses: unknown[]): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; body: { tool: string; arguments: Record<string, unknown> } }>;
} {
  const calls: Array<{ url: string; body: { tool: string; arguments: Record<string, unknown> } }> =
    [];
  let i = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return jsonResponse(body);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const TASK = (over: Record<string, unknown> = {}) => ({
  taskId: 't1',
  definition: 'deep-research',
  state: 'pending',
  createdBy: 'user:alice',
  createdAt: '2026-07-03T00:00:00.000Z',
  updatedAt: '2026-07-03T00:00:00.000Z',
  ...over,
});

describe('watt task run', () => {
  it('run maps to Write with { request } and prints started (--json → TaskInfo)', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([{ task: TASK({ taskId: 'rt-1' }) }]);
    const code = await run(
      ['--json', 'task', 'run', 'deep-research', '--input', '{"topic":"x"}', '--task-id', 'rt-1'],
      { env: ENV, fetch, stdout: (l) => out.push(l) },
    );
    expect(code).toBe(0);
    expect(calls[0]?.url).toContain('/htbp/platform/task');
    expect(calls[0]?.body.tool).toBe('Write');
    const req = calls[0]?.body.arguments.request as {
      definition: string;
      input: unknown;
      taskId: string;
    };
    expect(req.definition).toBe('deep-research');
    expect(req.input).toEqual({ topic: 'x' });
    expect(req.taskId).toBe('rt-1');
    expect(JSON.parse(out[0]!).taskId).toBe('rt-1');
  });
});

describe('watt task list / get', () => {
  it('list maps to List with filter and parses bare Page{items}', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([{ items: [TASK(), TASK({ taskId: 't2' })] }]);
    const code = await run(['--json', 'task', 'list', '--state', 'running'], {
      env: ENV,
      fetch,
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('List');
    const opts = calls[0]?.body.arguments.opts as { filter: Record<string, string> };
    expect(opts.filter.state).toBe('running');
    expect(JSON.parse(out[0]!)).toHaveLength(2);
  });

  it('get maps to Get and parses { task } TaskDetail', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([{ task: { ...TASK(), steps: [], artifacts: [] } }]);
    const code = await run(['--json', 'task', 'get', 't1'], {
      env: ENV,
      fetch,
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('Get');
    expect(calls[0]?.body.arguments.taskId).toBe('t1');
    expect(JSON.parse(out[0]!).taskId).toBe('t1');
  });
});

describe('watt task signal / cancel', () => {
  it('signal maps to Signal with {taskId, signal:{checkpoint,decision,payload?}}', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([{ signalled: true }]);
    const code = await run(
      ['task', 'signal', 't1', '--checkpoint', 'confirm-plan', '--decision', 'approve'],
      { env: ENV, fetch, stdout: (l) => out.push(l) },
    );
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('Signal');
    expect(calls[0]?.body.arguments.taskId).toBe('t1');
    const sig = calls[0]?.body.arguments.signal as { checkpoint: string; decision: string };
    expect(sig.checkpoint).toBe('confirm-plan');
    expect(sig.decision).toBe('approve');
  });

  it('cancel maps to Cancel with {taskId, reason?}', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([{ cancelled: true }]);
    const code = await run(['task', 'cancel', 't1', '--reason', 'stop'], {
      env: ENV,
      fetch,
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('Cancel');
    expect(calls[0]?.body.arguments.taskId).toBe('t1');
    expect(calls[0]?.body.arguments.reason).toBe('stop');
  });
});

describe('watt task defs', () => {
  it('defs maps to ListDefinitions and parses bare Page{items}', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([
      {
        items: [
          {
            name: 'deep-research',
            kind: 'deployed',
            description: 'd',
            checkpoints: ['confirm-plan'],
          },
        ],
      },
    ]);
    const code = await run(['--json', 'task', 'defs'], {
      env: ENV,
      fetch,
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('ListDefinitions');
    expect(JSON.parse(out[0]!)[0].name).toBe('deep-research');
  });
});
