import { describe, expect, it, vi } from 'vitest';
import { run } from './cli.ts';

/**
 * `watt provider list|add|set-default` 命令测试（fetch 注入）。
 * mock 响应形状真源：gateway packages/gateway/test/platform-provider.test.ts
 *   （Write/SetDefault → { provider }；List → 裸 Page{items}；投影无 secretRef）。禁双形态兜底（§34）。
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

const PROV = (over: Record<string, unknown> = {}) => ({
  id: 'openrouter-main',
  vendor: 'openrouter',
  models: ['glm-5.2'],
  priority: 10,
  default: false,
  enabled: true,
  ...over,
});

describe('watt provider list', () => {
  it('list → List (bare Page{items}); default marker in output', async () => {
    const { fetch, calls } = scriptedFetch([
      { body: { items: [PROV({ default: true }), PROV({ id: 'anthropic-main' })] } },
    ]);
    const lines: string[] = [];
    const code = await run(['provider', 'list'], { env: ENV, fetch, stdout: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(calls[0]?.url).toBe('https://x/htbp/platform/provider');
    expect(calls[0]?.body.tool).toBe('List');
    expect(lines.join('\n')).toContain('openrouter-main');
  });
});

describe('watt provider add', () => {
  it('add → Write {provider} with models split + secretRef', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { provider: PROV() } }]);
    const code = await run(
      [
        'provider',
        'add',
        'openrouter-main',
        '--vendor',
        'openrouter',
        '--models',
        'glm-5.2, minimax-m3',
        '--secret-ref',
        'OPENROUTER_KEY',
        '--priority',
        '5',
        '--default',
      ],
      { env: ENV, fetch, stdout: () => {} },
    );
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('Write');
    const p = calls[0]?.body.arguments.provider as Record<string, unknown>;
    expect(p).toEqual({
      id: 'openrouter-main',
      vendor: 'openrouter',
      models: ['glm-5.2', 'minimax-m3'],
      priority: 5,
      default: true,
      secretRef: 'OPENROUTER_KEY',
      enabled: true,
    });
  });

  it('add --disabled flips enabled false', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { provider: PROV({ enabled: false }) } }]);
    await run(
      ['provider', 'add', 'p', '--vendor', 'v', '--models', 'm', '--secret-ref', 'r', '--disabled'],
      { env: ENV, fetch, stdout: () => {} },
    );
    const p = calls[0]?.body.arguments.provider as { enabled: boolean };
    expect(p.enabled).toBe(false);
  });
});

describe('watt provider set-default', () => {
  it('set-default → SetDefault {providerId}', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { provider: PROV({ default: true }) } }]);
    const code = await run(['provider', 'set-default', 'openrouter-main'], {
      env: ENV,
      fetch,
      stdout: () => {},
    });
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('SetDefault');
    expect(calls[0]?.body.arguments).toEqual({ providerId: 'openrouter-main' });
  });
});
