import { describe, expect, it, vi } from 'vitest';
import { run } from './cli.ts';

/**
 * `watt cron list|create|trigger|rm|get` 命令测试（fetch 注入）。
 * 断言 HTBP 请求体（tool/arguments）与响应形状解析——形状真源 = gateway platform-scheduler.test.ts
 * （§34 禁双形态兜底：CLI 照抄 { job } / 裸 { items } / { eventId } / { deleted:true }）。
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

const JOB = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  description: 'nightly',
  schedule: '*/5 * * * *',
  enabled: true,
  action: { kind: 'publish', event: { type: 'nightly.tick' } },
  createdBy: 'user:alice',
  ...over,
});

describe('watt cron create', () => {
  it('publish action maps to Write with { job } (no createdBy in body)', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([{ job: JOB() }]);
    const code = await run(
      [
        '--json',
        'cron',
        'create',
        'c1',
        '--schedule',
        '*/5 * * * *',
        '--action-kind',
        'publish',
        '--event-type',
        'nightly.tick',
        '--payload',
        '{"n":1}',
      ],
      { env: ENV, fetch, stdout: (l) => out.push(l) },
    );
    expect(code).toBe(0);
    expect(calls[0]?.url).toContain('/htbp/platform/scheduler');
    expect(calls[0]?.body.tool).toBe('Write');
    const job = calls[0]?.body.arguments.job as {
      id: string;
      schedule: string;
      action: { kind: string; event: { type: string; payload: unknown } };
      createdBy?: string;
    };
    expect(job.id).toBe('c1');
    expect(job.action.kind).toBe('publish');
    expect(job.action.event.type).toBe('nightly.tick');
    expect(job.action.event.payload).toEqual({ n: 1 });
    expect(job.createdBy).toBeUndefined(); // createdBy 由 gateway 从 claims 注入。
    expect(JSON.parse(out[0]!).id).toBe('c1');
  });

  it('agent action carries definition/instanceBy', async () => {
    const { fetch, calls } = scriptedFetch([{ job: JOB({ action: { kind: 'agent' } }) }]);
    const code = await run(
      [
        'cron',
        'create',
        'c2',
        '--schedule',
        '0 * * * *',
        '--action-kind',
        'agent',
        '--definition',
        'reporter',
        '--instance-by',
        'event',
      ],
      { env: ENV, fetch, stdout: () => {} },
    );
    expect(code).toBe(0);
    const action = (calls[0]?.body.arguments.job as { action: Record<string, unknown> }).action;
    expect(action.kind).toBe('agent');
    expect(action.definition).toBe('reporter');
    expect(action.instanceBy).toBe('event');
  });

  it('script action carries scriptRef/grants', async () => {
    const { fetch, calls } = scriptedFetch([{ job: JOB({ action: { kind: 'script' } }) }]);
    const code = await run(
      [
        'cron',
        'create',
        'c3',
        '--schedule',
        '0 0 * * *',
        '--action-kind',
        'script',
        '--script-ref',
        'context://automations/s1',
        '--grants',
        '[{"resources":["platform://event"],"actions":["manage"]}]',
      ],
      { env: ENV, fetch, stdout: () => {} },
    );
    expect(code).toBe(0);
    const action = (calls[0]?.body.arguments.job as { action: Record<string, unknown> }).action;
    expect(action.kind).toBe('script');
    expect(action.scriptRef).toBe('context://automations/s1');
    expect(action.grants).toEqual([{ resources: ['platform://event'], actions: ['manage'] }]);
  });

  it('missing required action option → exit 2', async () => {
    const { fetch } = scriptedFetch([{}]);
    const code = await run(
      ['cron', 'create', 'c4', '--schedule', '* * * * *', '--action-kind', 'publish'],
      { env: ENV, fetch, stderr: () => {} },
    );
    expect(code).toBe(2); // publish 缺 --event-type。
  });
});

describe('watt cron list / get / trigger / rm', () => {
  it('list maps to List and parses bare { items }', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([{ items: [JOB(), JOB({ id: 'c2' })] }]);
    const code = await run(['--json', 'cron', 'list'], {
      env: ENV,
      fetch,
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('List');
    expect(JSON.parse(out[0]!)).toHaveLength(2);
  });

  it('trigger maps to Trigger and parses { eventId }', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([{ eventId: 'ev-9' }]);
    const code = await run(['--json', 'cron', 'trigger', 'c1'], {
      env: ENV,
      fetch,
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('Trigger');
    expect(calls[0]?.body.arguments.jobId).toBe('c1');
    expect(JSON.parse(out[0]!).eventId).toBe('ev-9');
  });

  it('rm maps to Delete', async () => {
    const { fetch, calls } = scriptedFetch([{ deleted: true }]);
    const code = await run(['cron', 'rm', 'c1'], { env: ENV, fetch, stdout: () => {} });
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('Delete');
    expect(calls[0]?.body.arguments.jobId).toBe('c1');
  });

  it('get maps to Get and parses { job }', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([{ job: JOB() }]);
    const code = await run(['--json', 'cron', 'get', 'c1'], {
      env: ENV,
      fetch,
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('Get');
    expect(JSON.parse(out[0]!).id).toBe('c1');
  });
});
