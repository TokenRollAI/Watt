import { describe, expect, it, vi } from 'vitest';
import { run } from './cli.ts';

/**
 * `watt agent list|get|spawn|send|terminate|tree` 命令测试（fetch 注入）。
 * 断言精确到请求形状（POST /htbp/platform/agent, tool, arguments）——mock 不掩盖形状错配（§34）。
 *
 * mock 响应形状真源：gateway packages/gateway/test/platform-agent.test.ts
 *   （Get/Write/Update → { definition }；List → 裸 Page{items}；Spawn → { instance, correlationId? }；
 *    Send → { accepted, correlationId? }；ListInstances → 裸 { items }；Terminate → { terminated:true }）。
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ENV = { WATT_BASE_URL: 'https://x', WATT_TOKEN: 'tok-test' };

function scriptedFetch(responses: Array<{ body: unknown; status?: number }>): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; body: { tool: string; arguments: Record<string, unknown> } }>;
} {
  const calls: Array<{ url: string; body: { tool: string; arguments: Record<string, unknown> } }> =
    [];
  let i = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return jsonResponse(r.body, r.status ?? 200);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const DEF = (over: Record<string, unknown> = {}) => ({
  name: 'triage',
  description: 'a triage agent',
  runtime: 'light',
  ...over,
});
const INST = (over: Record<string, unknown> = {}) => ({
  instanceId: 'inst-1',
  definition: 'triage',
  state: 'idle',
  children: [],
  createdAt: '2026-07-03',
  lastActiveAt: '2026-07-03',
  ...over,
});

describe('watt agent list / get', () => {
  it('list → List (bare Page{items})', async () => {
    const { fetch, calls } = scriptedFetch([
      { body: { items: [DEF(), DEF({ name: 'finance' })] } },
    ]);
    const lines: string[] = [];
    const code = await run(['agent', 'list'], { env: ENV, fetch, stdout: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(calls[0]?.url).toBe('https://x/htbp/platform/agent');
    expect(calls[0]?.body.tool).toBe('List');
    expect(lines.join('\n')).toContain('triage');
  });

  it('get → Get {name} → { definition }', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { definition: DEF() } }]);
    const code = await run(['agent', 'get', 'triage'], { env: ENV, fetch, stdout: () => {} });
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('Get');
    expect(calls[0]?.body.arguments).toEqual({ name: 'triage' });
  });
});

describe('watt agent spawn', () => {
  it('spawn → Spawn {request} with instanceKey/input; prints instanceId', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { instance: INST() } }]);
    const lines: string[] = [];
    const code = await run(
      ['agent', 'spawn', 'triage', '--instance-key', 'k1', '--input', '{"task":"x"}'],
      { env: ENV, fetch, stdout: (l) => lines.push(l) },
    );
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('Spawn');
    expect(calls[0]?.body.arguments).toEqual({
      request: { definition: 'triage', instanceKey: 'k1', input: { task: 'x' } },
    });
    expect(lines.join('\n')).toContain('inst-1');
  });

  it('spawn --expect-schema builds request.expect and prints correlationId', async () => {
    const { fetch, calls } = scriptedFetch([
      { body: { instance: INST(), correlationId: 'cid-1' } },
    ]);
    const lines: string[] = [];
    const code = await run(
      [
        'agent',
        'spawn',
        'triage',
        '--expect-schema',
        '{"type":"object"}',
        '--correlation-id',
        'cid-1',
        '--timeout-ms',
        '5000',
      ],
      { env: ENV, fetch, stdout: (l) => lines.push(l) },
    );
    expect(code).toBe(0);
    const req = calls[0]?.body.arguments.request as { expect?: Record<string, unknown> };
    expect(req.expect).toEqual({
      correlationId: 'cid-1',
      timeoutMs: 5000,
      schema: { type: 'object' },
    });
    expect(lines.join('\n')).toContain('cid-1');
  });

  it('spawn --input invalid JSON → exit 2', async () => {
    const { fetch } = scriptedFetch([{ body: {} }]);
    const errs: string[] = [];
    const code = await run(['agent', 'spawn', 'triage', '--input', 'not json'], {
      env: ENV,
      fetch,
      stderr: (l) => errs.push(l),
    });
    expect(code).toBe(2);
  });
});

describe('watt agent send', () => {
  it('send → Send {instanceId,event,expect?}', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { accepted: true, correlationId: 'cid-s' } }]);
    const code = await run(
      [
        'agent',
        'send',
        'inst-1',
        '--type',
        'agent.message',
        '--payload',
        '{"ping":1}',
        '--expect-schema',
        '{"type":"object"}',
      ],
      { env: ENV, fetch, stdout: () => {} },
    );
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('Send');
    const args = calls[0]?.body.arguments as {
      instanceId: string;
      event: { type: string; payload: unknown };
      expect: unknown;
    };
    expect(args.instanceId).toBe('inst-1');
    expect(args.event.type).toBe('agent.message');
    expect(args.event.payload).toEqual({ ping: 1 });
    expect(args.expect).toEqual({ schema: { type: 'object' } });
  });
});

describe('watt agent terminate / tree', () => {
  it('terminate --cascade → Terminate {instanceId,cascade:true}', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { terminated: true } }]);
    const code = await run(['agent', 'terminate', 'inst-1', '--cascade'], {
      env: ENV,
      fetch,
      stdout: () => {},
    });
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('Terminate');
    expect(calls[0]?.body.arguments).toEqual({ instanceId: 'inst-1', cascade: true });
  });

  it('tree <root> → ListInstances {opts:{tree}} and renders parent/child', async () => {
    const { fetch, calls } = scriptedFetch([
      {
        body: {
          items: [INST({ instanceId: 'root' }), INST({ instanceId: 'child', parent: 'root' })],
        },
      },
    ]);
    const lines: string[] = [];
    const code = await run(['agent', 'tree', 'root'], {
      env: ENV,
      fetch,
      stdout: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('ListInstances');
    expect(calls[0]?.body.arguments).toEqual({ opts: { tree: 'root' } });
    // child 缩进在 root 之下（tree 渲染父子）。
    const text = lines.join('\n');
    expect(text).toContain('root');
    expect(text).toMatch(/ {2}child/);
  });
});

describe('watt agent auth errors', () => {
  it('no token → exit 2', async () => {
    const { fetch } = scriptedFetch([{ body: {} }]);
    const code = await run(['agent', 'list'], {
      env: { WATT_BASE_URL: 'https://x' },
      fetch,
      stderr: () => {},
      fs: {
        readFile: () => {
          throw new Error('no creds');
        },
      },
      credentialsPath: '/nonexistent/creds.json',
    });
    expect(code).toBe(2);
  });

  it('server 401 → exit 1', async () => {
    const { fetch } = scriptedFetch([
      { body: { code: 'permission_denied', message: 'no', retryable: false }, status: 401 },
    ]);
    const code = await run(['agent', 'list'], { env: ENV, fetch, stderr: () => {} });
    expect(code).toBe(1);
  });
});
