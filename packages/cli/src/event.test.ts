import { describe, expect, it, vi } from 'vitest';
import { run } from './cli.ts';

/**
 * `watt event tail|get|subs` + `watt channel list|set` 命令测试（fetch 注入）。
 * 断言：HTBP 请求体（tool/arguments）、tail 轮询游标推进 + NDJSON、set 的 JSON settings 校验。
 * 对齐 commands.test.ts / login.test.ts 的注入模式（fetch/sleep）。
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ENV = { WATT_BASE_URL: 'https://x', WATT_TOKEN: 'tok-test' };

/** 记录每次请求的 body（HTBP {tool,arguments}），按顺序返回预设响应。 */
function scriptedFetch(responses: unknown[]): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; body: { tool: string; arguments: Record<string, unknown> } }>;
} {
  const calls: Array<{ url: string; body: { tool: string; arguments: Record<string, unknown> } }> =
    [];
  let i = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return jsonResponse(body);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const EVENT = (over: Record<string, unknown> = {}) => ({
  id: 'ev-1',
  type: 'webhook.received',
  session: 's1',
  occurredAt: '2026-07-03T00:00:00.000Z',
  source: { kind: 'webhook', channel: 'hook' },
  payload: { x: 1 },
  ...over,
});

describe('watt event tail', () => {
  it('--once fetches one round and emits NDJSON per event (--json)', async () => {
    const out: string[] = [];
    // 服务端 List 返回倒序（最新在前）：ev-b(01) 先于 ev-a(00)。
    const { fetch, calls } = scriptedFetch([
      {
        items: [
          EVENT({ id: 'ev-b', occurredAt: '2026-07-03T00:00:01.000Z' }),
          EVENT({ id: 'ev-a' }),
        ],
      },
    ]);
    const code = await run(['--json', 'event', 'tail', '--once', '--channel', 'hook'], {
      env: ENV,
      fetch,
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    // 一轮 List，POST /htbp/platform/event tool=List，filter 含 channel。
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/htbp/platform/event');
    expect(calls[0]?.body.tool).toBe('List');
    expect(
      (calls[0]?.body.arguments.opts as { filter: Record<string, string> }).filter.channel,
    ).toBe('hook');
    // NDJSON：两行，按 occurredAt 升序（服务端倒序 → tail 升序发出）。
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0]!).id).toBe('ev-a');
    expect(JSON.parse(out[1]!).id).toBe('ev-b');
  });

  it('advances the since cursor between polls (sleep injected)', async () => {
    const out: string[] = [];
    let rounds = 0;
    // 第一轮返回一个事件，之后返回空；sleep 注入即时返回，第 2 轮后手动停止。
    const { fetch, calls } = scriptedFetch([{ items: [EVENT({ id: 'ev-a' })] }, { items: [] }]);
    const sleep = vi.fn(async () => {
      rounds++;
      if (rounds >= 1) throw new Error('__stop__'); // 第一次 sleep 后中断循环（非 --once 路径）。
    });
    const code = await run(['event', 'tail', '--interval', '1'], {
      env: ENV,
      fetch,
      sleep,
      stdout: (l) => out.push(l),
      stderr: () => {},
    });
    // 循环被注入的 sleep 抛错中断 → CliError 之外的错误 exit 1（可接受，测试聚焦游标）。
    expect(code).toBe(1);
    // 至少拉了两轮（sleep 前一轮 + sleep 后第二轮直到抛错前）。
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // 第二轮的 since 游标推进到第一轮最大 occurredAt + 1ms。
    if (calls.length >= 2) {
      const since = (calls[1]?.body.arguments.opts as { filter: Record<string, string> }).filter
        .since;
      expect(since).toBe('2026-07-03T00:00:00.001Z');
    }
  });
});

describe('watt event get', () => {
  it('fetches a single event by id', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([{ event: EVENT({ id: 'ev-x' }) }]);
    const code = await run(['--json', 'event', 'get', 'ev-x'], {
      env: ENV,
      fetch,
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('Get');
    expect(calls[0]?.body.arguments.eventId).toBe('ev-x');
    expect(JSON.parse(out.join('\n')).id).toBe('ev-x');
  });
});

describe('watt event subs', () => {
  it('lists subscriptions', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([
      {
        items: [{ id: 'sub-1', match: { type: 'webhook.*' }, sink: { kind: 'webhook', url: 'u' } }],
      },
    ]);
    const code = await run(['--json', 'event', 'subs'], {
      env: ENV,
      fetch,
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('ListSubscriptions');
    expect(JSON.parse(out.join('\n'))[0].id).toBe('sub-1');
  });
});

describe('watt channel list / set', () => {
  it('lists channels (human)', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([
      { items: [{ id: 'hook', adapter: 'webhook', enabled: true, settings: {} }] },
    ]);
    const code = await run(['channel', 'list'], {
      env: ENV,
      fetch,
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(calls[0]?.url).toContain('/htbp/platform/channel');
    expect(calls[0]?.body.tool).toBe('List');
    expect(out.join('\n')).toContain('hook');
    expect(out.join('\n')).toContain('webhook');
  });

  it('set upserts a webhook channel with JSON settings', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([
      {
        channel: {
          id: 'hook',
          adapter: 'webhook',
          enabled: true,
          settings: { verifySecretRef: 'S' },
        },
      },
    ]);
    const code = await run(
      ['channel', 'set', 'hook', '--adapter', 'webhook', '--settings', '{"verifySecretRef":"S"}'],
      { env: ENV, fetch, stdout: (l) => out.push(l) },
    );
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('Write');
    const channel = calls[0]?.body.arguments.channel as Record<string, unknown>;
    expect(channel.id).toBe('hook');
    expect(channel.adapter).toBe('webhook');
    expect(channel.enabled).toBe(true);
    expect((channel.settings as Record<string, unknown>).verifySecretRef).toBe('S');
    expect(out.join('\n')).toContain('Set channel hook');
  });

  it('set --no-enabled disables the channel', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([
      { channel: { id: 'hook', adapter: 'webhook', enabled: false, settings: {} } },
    ]);
    const code = await run(['channel', 'set', 'hook', '--adapter', 'webhook', '--no-enabled'], {
      env: ENV,
      fetch,
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect((calls[0]?.body.arguments.channel as Record<string, unknown>).enabled).toBe(false);
  });

  it('set rejects non-object --settings (exit 2)', async () => {
    const errs: string[] = [];
    const { fetch } = scriptedFetch([{}]);
    const code = await run(
      ['channel', 'set', 'hook', '--adapter', 'webhook', '--settings', '[1,2]'],
      { env: ENV, fetch, stderr: (l) => errs.push(l) },
    );
    expect(code).toBe(2);
    expect(errs.join('\n')).toContain('JSON object');
  });
});
