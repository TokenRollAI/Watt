import { describe, expect, it, vi } from 'vitest';
import { run } from './cli.ts';

/**
 * `watt tool ls|mount` 命令测试（fetch 注入）。
 * 断言精确到请求形状（URL 子树 / tool / arguments 各字段），吸取 Phase 2/3 教训——
 * mock 不掩盖形状错配。覆盖：ls/mount 请求形状、mount --config JSON 解析与校验、
 * --disabled 翻转 enabled、错误路径（401→exit 1，无 token→exit 2）。
 *
 * mock 响应形状真源：以 gateway packages/gateway/test/platform-tool.test.ts 锁定的服务端响应为准
 * （管理面 Write → { mount }；List → 裸 Page{items}）。禁双形态兜底（toolchain §34）。
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
  calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: { tool: string; arguments: Record<string, unknown> };
  }>;
} {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: { tool: string; arguments: Record<string, unknown> };
  }> = [];
  let i = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return jsonResponse(r.body, r.status ?? 200);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const MOUNT = (over: Record<string, unknown> = {}) => ({
  path: 'observability/logs',
  provider: 'http',
  enabled: true,
  ...over,
});

describe('watt tool ls', () => {
  it('lists mounts via ToolRegistry.List on platform subtree (bare Page{items})', async () => {
    const { fetch, calls } = scriptedFetch([
      { body: { items: [MOUNT(), MOUNT({ path: 'finance/reports', provider: 'mcp' })] } },
    ]);
    const out: string[] = [];
    const code = await run(['tool', 'ls'], { env: ENV, fetch, stdout: (l) => out.push(l) });
    expect(code).toBe(0);
    expect(calls[0]?.url).toBe('https://x/htbp/platform/tool');
    expect(calls[0]?.body.tool).toBe('List');
    expect(calls[0]?.body.arguments).toEqual({ opts: {} });
    expect(out.join('\n')).toContain('observability/logs');
    expect(out.join('\n')).toContain('finance/reports');
  });

  it('--json emits the raw mount array', async () => {
    const { fetch } = scriptedFetch([{ body: { items: [MOUNT()] } }]);
    const out: string[] = [];
    const code = await run(['--json', 'tool', 'ls'], {
      env: ENV,
      fetch,
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out[0]!) as { path: string }[];
    expect(parsed[0]?.path).toBe('observability/logs');
  });

  it('prints a placeholder when there are no mounts', async () => {
    const { fetch } = scriptedFetch([{ body: { items: [] } }]);
    const out: string[] = [];
    await run(['tool', 'ls'], { env: ENV, fetch, stdout: (l) => out.push(l) });
    expect(out.join('\n')).toContain('(no tool mounts)');
  });
});

describe('watt tool mount', () => {
  it('mounts via ToolRegistry.Write on platform subtree, enabled by default', async () => {
    const { fetch, calls } = scriptedFetch([
      { body: { mount: MOUNT({ path: 'finance/reports', provider: 'mcp' }) } },
    ]);
    const out: string[] = [];
    const code = await run(
      [
        'tool',
        'mount',
        'finance/reports',
        '--provider',
        'mcp',
        '--config',
        '{"endpoint":"https://m","secretRef":"T"}',
      ],
      { env: ENV, fetch, stdout: (l) => out.push(l) },
    );
    expect(code).toBe(0);
    expect(calls[0]?.url).toBe('https://x/htbp/platform/tool');
    expect(calls[0]?.body.tool).toBe('Write');
    const mount = calls[0]?.body.arguments.mount as Record<string, unknown>;
    expect(mount.path).toBe('finance/reports');
    expect(mount.provider).toBe('mcp');
    expect(mount.enabled).toBe(true);
    expect(mount.providerConfig).toEqual({ endpoint: 'https://m', secretRef: 'T' });
    expect(out.join('\n')).toContain('Mounted finance/reports');
  });

  it('omits providerConfig when --config is not given', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { mount: MOUNT() } }]);
    await run(['tool', 'mount', 'observability/logs', '--provider', 'http'], {
      env: ENV,
      fetch,
      stdout: () => {},
    });
    const mount = calls[0]?.body.arguments.mount as Record<string, unknown>;
    expect(mount).toEqual({ path: 'observability/logs', provider: 'http', enabled: true });
  });

  it('--disabled sets enabled:false', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { mount: MOUNT({ enabled: false }) } }]);
    await run(['tool', 'mount', 'obs', '--provider', 'builtin', '--disabled'], {
      env: ENV,
      fetch,
      stdout: () => {},
    });
    const mount = calls[0]?.body.arguments.mount as Record<string, unknown>;
    expect(mount.enabled).toBe(false);
  });

  it('rejects a non-object --config with exit 2 (local arg error)', async () => {
    const { fetch } = scriptedFetch([{ body: { mount: MOUNT() } }]);
    const err: string[] = [];
    const code = await run(['tool', 'mount', 'x', '--provider', 'http', '--config', '[1,2]'], {
      env: ENV,
      fetch,
      stderr: (l) => err.push(l),
    });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('--config must be a JSON object');
  });

  it('rejects malformed --config JSON with exit 2', async () => {
    const { fetch } = scriptedFetch([{ body: { mount: MOUNT() } }]);
    const code = await run(['tool', 'mount', 'x', '--provider', 'http', '--config', '{bad'], {
      env: ENV,
      fetch,
      stderr: () => {},
    });
    expect(code).toBe(2);
  });

  it('throws exit 1 when server Write response is missing mount', async () => {
    const { fetch } = scriptedFetch([{ body: {} }]);
    const code = await run(['tool', 'mount', 'x', '--provider', 'http'], {
      env: ENV,
      fetch,
      stderr: () => {},
    });
    expect(code).toBe(1);
  });
});

describe('watt tool — error paths', () => {
  it('exit 1 on server 401 (Unauthorized)', async () => {
    const { fetch } = scriptedFetch([
      { body: { code: 'permission_denied', message: 'no', retryable: false }, status: 401 },
    ]);
    const code = await run(['tool', 'ls'], { env: ENV, fetch, stderr: () => {} });
    expect(code).toBe(1);
  });

  it('exit 2 when not authenticated (no token)', async () => {
    const { fetch } = scriptedFetch([{ body: { items: [] } }]);
    const code = await run(['tool', 'ls'], {
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
});
