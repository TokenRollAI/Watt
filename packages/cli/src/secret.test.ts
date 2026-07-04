import { describe, expect, it, vi } from 'vitest';
import { run } from './cli.ts';

/**
 * `watt secret set|list|rm` 命令测试（fetch + readStdin 注入）。
 * mock 响应形状真源：gateway packages/gateway/test/platform-secret.test.ts
 *   （Write → { secret:{name,updatedAt} }；List → { items }；Delete → { deleted:true }）。禁双形态兜底（§34）。
 * 关键断言：set 的 value 只从 stdin 读、**绝不出现在 argv**。
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

describe('watt secret set', () => {
  it('set → Write {name,value}，value 从 stdin 读（不在 argv）', async () => {
    const { fetch, calls } = scriptedFetch([
      { body: { secret: { name: 'API_KEY', updatedAt: '2026-07-04T00:00:00.000Z' } } },
    ]);
    const argv = ['secret', 'set', 'API_KEY'];
    const lines: string[] = [];
    const code = await run(argv, {
      env: ENV,
      fetch,
      stdout: (l) => lines.push(l),
      readStdin: async () => 'the-secret-value\n',
    });
    expect(code).toBe(0);
    expect(calls[0]?.url).toBe('https://x/htbp/platform/secret');
    expect(calls[0]?.body.tool).toBe('Write');
    expect(calls[0]?.body.arguments).toEqual({ name: 'API_KEY', value: 'the-secret-value' });
    // value 绝不出现在 argv。
    expect(argv).not.toContain('the-secret-value');
    expect(lines.join('\n')).toContain('Set secret API_KEY');
  });

  it('空 stdin → 退出码 2，不发请求', async () => {
    const { fetch, calls } = scriptedFetch([{ body: {} }]);
    const code = await run(['secret', 'set', 'API_KEY'], {
      env: ENV,
      fetch,
      stdout: () => {},
      stderr: () => {},
      readStdin: async () => '\n',
    });
    expect(code).toBe(2);
    expect(calls.length).toBe(0);
  });

  it('--json 输出原始响应', async () => {
    const { fetch } = scriptedFetch([
      { body: { secret: { name: 'API_KEY', updatedAt: '2026-07-04T00:00:00.000Z' } } },
    ]);
    const lines: string[] = [];
    const code = await run(['--json', 'secret', 'set', 'API_KEY'], {
      env: ENV,
      fetch,
      stdout: (l) => lines.push(l),
      readStdin: async () => 'v',
    });
    expect(code).toBe(0);
    expect(JSON.parse(lines[0]!)).toEqual({
      name: 'API_KEY',
      updatedAt: '2026-07-04T00:00:00.000Z',
    });
  });
});

describe('watt secret list', () => {
  it('list → List；渲染 shadowedByEnv', async () => {
    const { fetch, calls } = scriptedFetch([
      {
        body: {
          items: [
            { name: 'API_KEY', updatedAt: '2026-07-04T00:00:00.000Z', shadowedByEnv: false },
            { name: 'SHADOW', updatedAt: '2026-07-04T00:00:00.000Z', shadowedByEnv: true },
          ],
        },
      },
    ]);
    const lines: string[] = [];
    const code = await run(['secret', 'list'], { env: ENV, fetch, stdout: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('List');
    const out = lines.join('\n');
    expect(out).toContain('API_KEY');
    expect(out).toContain('SHADOW');
    expect(out).toContain('[shadowed-by-env]');
  });
});

describe('watt secret rm', () => {
  it('rm → Delete {name}', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { deleted: true } }]);
    const lines: string[] = [];
    const code = await run(['secret', 'rm', 'API_KEY'], {
      env: ENV,
      fetch,
      stdout: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('Delete');
    expect(calls[0]?.body.arguments).toEqual({ name: 'API_KEY' });
    expect(lines.join('\n')).toContain('Removed secret API_KEY');
  });
});
