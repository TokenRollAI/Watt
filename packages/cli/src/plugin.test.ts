import { describe, expect, it, vi } from 'vitest';
import { run } from './cli.ts';

/**
 * `watt plugin register|list|health` 命令测试（fetch 注入）。
 * mock 响应形状真源：gateway packages/gateway/test/platform-plugin.test.ts
 *   （Write → { registration }；List → { items }；Health → { health }）。禁双形态兜底（§34）。
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

const MANIFEST = {
  id: 'feishu-main',
  kind: 'channel-adapter',
  interfaceVersion: 'channel-adapter/v1',
  endpoint: 'binding:feishu',
  auth: { kind: 'platform-token' },
  requiredGrants: [{ resources: ['event://'], actions: ['write'] }],
  healthPath: '/healthz',
  enabled: true,
};

describe('watt plugin register', () => {
  it('register → Write {manifest}; returns registration', async () => {
    const { fetch, calls } = scriptedFetch([
      {
        body: {
          registration: {
            ...MANIFEST,
            platformBaseUrl: 'https://x',
            jwksUrl: 'https://x/.well-known/jwks.json',
            pluginToken: 'tok-plugin-abc',
          },
        },
      },
    ]);
    const lines: string[] = [];
    const code = await run(
      [
        'plugin',
        'register',
        'feishu-main',
        '--kind',
        'channel-adapter',
        '--interface-version',
        'channel-adapter/v1',
        '--endpoint',
        'binding:feishu',
        '--health-path',
        '/healthz',
        '--grants',
        '[{"resources":["event://"],"actions":["write"]}]',
      ],
      { env: ENV, fetch, stdout: (l) => lines.push(l) },
    );
    expect(code).toBe(0);
    expect(calls[0]?.url).toBe('https://x/htbp/platform/plugin');
    expect(calls[0]?.body.tool).toBe('Write');
    const m = calls[0]?.body.arguments.manifest as Record<string, unknown>;
    expect(m.id).toBe('feishu-main');
    expect(m.auth).toEqual({ kind: 'platform-token' });
    expect(m.requiredGrants).toEqual([{ resources: ['event://'], actions: ['write'] }]);
    expect(lines.join('\n')).toContain('jwks.json');
  });

  it('register --secret-ref → bearer auth', async () => {
    const { fetch, calls } = scriptedFetch([
      {
        body: {
          registration: { ...MANIFEST, platformBaseUrl: 'x', jwksUrl: 'x', pluginToken: 't' },
        },
      },
    ]);
    await run(
      [
        'plugin',
        'register',
        'p',
        '--kind',
        'tool-provider',
        '--interface-version',
        'tool-provider/v1',
        '--endpoint',
        'https://p.example.com',
        '--secret-ref',
        'PLUGIN_KEY',
      ],
      { env: ENV, fetch, stdout: () => {} },
    );
    const m = calls[0]?.body.arguments.manifest as { auth: unknown };
    expect(m.auth).toEqual({ kind: 'bearer', secretRef: 'PLUGIN_KEY' });
  });

  it('register --json emits pluginToken', async () => {
    const { fetch } = scriptedFetch([
      {
        body: {
          registration: { ...MANIFEST, platformBaseUrl: 'x', jwksUrl: 'x', pluginToken: 'tok-xyz' },
        },
      },
    ]);
    const lines: string[] = [];
    const code = await run(
      [
        '--json',
        'plugin',
        'register',
        'p',
        '--kind',
        'channel-adapter',
        '--interface-version',
        'v1',
        '--endpoint',
        'binding:x',
      ],
      { env: ENV, fetch, stdout: (l) => lines.push(l) },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(lines[0]!) as { pluginToken: string };
    expect(parsed.pluginToken).toBe('tok-xyz');
  });

  it('register --grants non-array → exit 2', async () => {
    const { fetch } = scriptedFetch([{ body: {} }]);
    const code = await run(
      [
        'plugin',
        'register',
        'p',
        '--kind',
        'tool-provider',
        '--interface-version',
        'v1',
        '--endpoint',
        'https://p',
        '--grants',
        '{"not":"array"}',
      ],
      { env: ENV, fetch, stdout: () => {}, stderr: () => {} },
    );
    expect(code).toBe(2);
  });
});

describe('watt plugin list', () => {
  it('list → List; prints ids', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { items: [MANIFEST] } }]);
    const lines: string[] = [];
    const code = await run(['plugin', 'list'], { env: ENV, fetch, stdout: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('List');
    expect(lines.join('\n')).toContain('feishu-main');
  });

  it('list --kind adds filter', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { items: [] } }]);
    await run(['plugin', 'list', '--kind', 'channel-adapter'], {
      env: ENV,
      fetch,
      stdout: () => {},
    });
    expect(calls[0]?.body.arguments.opts).toEqual({ filter: { kind: 'channel-adapter' } });
  });

  it('list --json emits array', async () => {
    const { fetch } = scriptedFetch([{ body: { items: [MANIFEST] } }]);
    const lines: string[] = [];
    await run(['--json', 'plugin', 'list'], { env: ENV, fetch, stdout: (l) => lines.push(l) });
    const parsed = JSON.parse(lines[0]!) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
  });
});

describe('watt plugin health', () => {
  it('health → Health {pluginId}; prints healthy', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { health: { healthy: true, detail: 'ok' } } }]);
    const lines: string[] = [];
    const code = await run(['plugin', 'health', 'channel-feishu'], {
      env: ENV,
      fetch,
      stdout: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('Health');
    expect(calls[0]?.body.arguments).toEqual({ pluginId: 'channel-feishu' });
    expect(lines.join('\n')).toContain('healthy');
  });

  it('health unhealthy prints UNHEALTHY', async () => {
    const { fetch } = scriptedFetch([{ body: { health: { healthy: false, detail: 'HTTP 503' } } }]);
    const lines: string[] = [];
    await run(['plugin', 'health', 'ext'], { env: ENV, fetch, stdout: (l) => lines.push(l) });
    expect(lines.join('\n')).toContain('UNHEALTHY');
  });
});
