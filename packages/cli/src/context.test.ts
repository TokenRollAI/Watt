import { describe, expect, it, vi } from 'vitest';
import { run } from './cli.ts';

/**
 * `watt context ls|cat|put|patch|mount|unmount` 命令测试（fetch 注入）。
 * 断言精确到请求形状（URL 子树 / tool / arguments 各字段），吸取 Phase 2 教训——
 * mock 不掩盖形状错配。覆盖：六命令请求形状、put 三路 content、metadata k=v 解析、
 * mount 参数组装（ttl 数字化 / readOnly / provider-config）、错误路径（401→exit 1，无 token→exit 2）。
 *
 * mock 响应形状真源：以 gateway packages/gateway/test/context-routes.test.ts 锁定的服务端响应为准
 * （消费面 Get→{entry}、Write/Update→{meta}、List→{items}；管理面 context Write→{mount}）。
 * 两侧漂移曾两次造成线上 bug——此处 mock 必须与服务端契约一致，勿凭想当然造形状。
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ENV = { WATT_BASE_URL: 'https://x', WATT_TOKEN: 'tok-test' };

/** 记录每次请求（url + headers + HTBP {tool,arguments}），按顺序返回预设响应（含状态码）。 */
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

const META = (over: Record<string, unknown> = {}) => ({
  uri: 'context://feedback/bugs/1235',
  contentType: 'text/markdown',
  version: 'v1',
  updatedAt: '2026-07-03T00:00:00.000Z',
  size: 42,
  metadata: { status: 'open' },
  ...over,
});

describe('watt context ls', () => {
  it('lists entries at /htbp/context/<ns> with List + path + opts (json)', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([{ body: { items: [META()] } }]);
    const code = await run(['--json', 'context', 'ls', 'feedback/bugs', 'sub/'], {
      env: ENV,
      fetch,
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(calls[0]?.url).toBe('https://x/htbp/context/feedback/bugs');
    expect(calls[0]?.body.tool).toBe('List');
    expect(calls[0]?.body.arguments.path).toBe('sub/');
    expect(calls[0]?.body.arguments.opts).toEqual({});
    expect(JSON.parse(out.join('\n'))[0].uri).toBe('context://feedback/bugs/1235');
  });

  it('defaults path to empty string when omitted (human output)', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([{ body: { items: [META()] } }]);
    const code = await run(['context', 'ls', 'feedback/bugs'], {
      env: ENV,
      fetch,
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(calls[0]?.body.arguments.path).toBe('');
    expect(out.join('\n')).toContain('context://feedback/bugs/1235');
  });
});

describe('watt context cat', () => {
  it('gets one entry and prints content (human)', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([
      { body: { entry: { ...META(), content: '## report body' } } },
    ]);
    const code = await run(['context', 'cat', 'feedback/bugs', '1235'], {
      env: ENV,
      fetch,
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(calls[0]?.url).toBe('https://x/htbp/context/feedback/bugs');
    expect(calls[0]?.body.tool).toBe('Get');
    expect(calls[0]?.body.arguments.path).toBe('1235');
    expect(out.join('\n')).toBe('## report body');
  });

  it('--json prints the whole entry', async () => {
    const out: string[] = [];
    const { fetch } = scriptedFetch([{ body: { entry: { ...META(), content: 'x' } } }]);
    const code = await run(['--json', 'context', 'cat', 'feedback/bugs', '1235'], {
      env: ENV,
      fetch,
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join('\n')).content).toBe('x');
  });
});

describe('watt context put', () => {
  it('writes from --content with content-type and repeatable metadata', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([{ body: { meta: META() } }]);
    const code = await run(
      [
        'context',
        'put',
        'feedback/bugs',
        '1235',
        '--content',
        'hello',
        '--content-type',
        'text/markdown',
        '--metadata',
        'status=open',
        '--metadata',
        'severity=P1',
      ],
      { env: ENV, fetch, stdout: (l) => out.push(l) },
    );
    expect(code).toBe(0);
    expect(calls[0]?.url).toBe('https://x/htbp/context/feedback/bugs');
    // 请求头契约：Bearer token + JSON content-type（HTBP 调用固定形状）。
    expect(calls[0]?.headers.authorization).toBe('Bearer tok-test');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.body.tool).toBe('Write');
    expect(calls[0]?.body.arguments.path).toBe('1235');
    const entry = calls[0]?.body.arguments.entry as Record<string, unknown>;
    expect(entry.content).toBe('hello');
    expect(entry.contentType).toBe('text/markdown');
    expect(entry.metadata).toEqual({ status: 'open', severity: 'P1' });
    expect(out.join('\n')).toContain('Wrote');
  });

  it('reads content from stdin when no --content/--file', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([{ body: { meta: META() } }]);
    const code = await run(['context', 'put', 'feedback/bugs', '1235'], {
      env: ENV,
      fetch,
      stdout: (l) => out.push(l),
      readStdin: async () => 'from-stdin',
    });
    expect(code).toBe(0);
    const entry = calls[0]?.body.arguments.entry as Record<string, unknown>;
    expect(entry.content).toBe('from-stdin');
    // contentType 必填（Proto §4.1 ContextEntryInput）：无 --content-type 时 CLI 缺省 text/plain。
    expect(entry.contentType).toBe('text/plain');
    expect('metadata' in entry).toBe(false);
  });

  it('reads content from --file', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { meta: META() } }]);
    const code = await run(['context', 'put', 'feedback/bugs', '1235', '--file', '/tmp/x.md'], {
      env: ENV,
      fetch,
      stdout: () => {},
      readFile: (p) => (p === '/tmp/x.md' ? 'file-body' : ''),
    });
    expect(code).toBe(0);
    expect((calls[0]?.body.arguments.entry as Record<string, unknown>).content).toBe('file-body');
  });

  it('carries --if-version', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { meta: META() } }]);
    await run(['context', 'put', 'feedback/bugs', '1235', '--content', 'x', '--if-version', 'v9'], {
      env: ENV,
      fetch,
      stdout: () => {},
    });
    expect((calls[0]?.body.arguments.entry as Record<string, unknown>).ifVersion).toBe('v9');
  });

  it('rejects malformed --metadata (exit 2)', async () => {
    const errs: string[] = [];
    const { fetch } = scriptedFetch([{ body: {} }]);
    const code = await run(
      ['context', 'put', 'feedback/bugs', '1235', '--content', 'x', '--metadata', 'bogus'],
      { env: ENV, fetch, stderr: (l) => errs.push(l) },
    );
    expect(code).toBe(2);
    expect(errs.join('\n')).toContain('key=value');
  });
});

describe('watt context patch', () => {
  it('updates metadata only (no content, no stdin touched)', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([{ body: { meta: META() } }]);
    const stdin = vi.fn(async () => 'should-not-be-read');
    const code = await run(
      ['context', 'patch', 'feedback/bugs', '1235', '--metadata', 'status=fixed'],
      { env: ENV, fetch, stdout: (l) => out.push(l), readStdin: stdin },
    );
    expect(code).toBe(0);
    expect(calls[0]?.body.tool).toBe('Update');
    expect(calls[0]?.body.arguments.path).toBe('1235');
    const patch = calls[0]?.body.arguments.patch as Record<string, unknown>;
    expect(patch.metadata).toEqual({ status: 'fixed' });
    expect('content' in patch).toBe(false);
    // patch 只改 metadata 时不读 stdin。
    expect(stdin).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('Patched');
  });

  it('updates content via --content and carries --if-version', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { meta: META() } }]);
    await run(
      ['context', 'patch', 'feedback/bugs', '1235', '--content', 'new body', '--if-version', 'v1'],
      { env: ENV, fetch, stdout: () => {} },
    );
    const patch = calls[0]?.body.arguments.patch as Record<string, unknown>;
    expect(patch.content).toBe('new body');
    expect(patch.ifVersion).toBe('v1');
  });

  it('rejects empty patch (exit 2)', async () => {
    const errs: string[] = [];
    const { fetch } = scriptedFetch([{ body: {} }]);
    const code = await run(['context', 'patch', 'feedback/bugs', '1235'], {
      env: ENV,
      fetch,
      stderr: (l) => errs.push(l),
    });
    expect(code).toBe(2);
    expect(errs.join('\n')).toContain('Nothing to patch');
  });
});

describe('watt context mount / unmount', () => {
  it('mounts on platform subtree with ContextRegistry.Write, ttl numeric + readOnly', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([
      { body: { mount: { namespace: 'research/scratch', provider: 'vector' } } },
    ]);
    const code = await run(
      [
        'context',
        'mount',
        'research/scratch',
        '--provider',
        'vector',
        '--ttl',
        '3600',
        '--read-only',
      ],
      { env: ENV, fetch, stdout: (l) => out.push(l) },
    );
    expect(code).toBe(0);
    // 管理面打 platform 子树，不是 context 子树。
    expect(calls[0]?.url).toBe('https://x/htbp/platform/context');
    expect(calls[0]?.body.tool).toBe('Write');
    const mount = calls[0]?.body.arguments.mount as Record<string, unknown>;
    expect(mount.namespace).toBe('research/scratch');
    expect(mount.provider).toBe('vector');
    expect(mount.ttl).toBe(3600);
    expect(typeof mount.ttl).toBe('number');
    expect(mount.readOnly).toBe(true);
    expect(out.join('\n')).toContain('Mounted research/scratch');
  });

  it('omits ttl/readOnly/providerConfig when not given', async () => {
    const { fetch, calls } = scriptedFetch([
      { body: { mount: { namespace: 'feedback/bugs', provider: 'object' } } },
    ]);
    await run(['context', 'mount', 'feedback/bugs', '--provider', 'object'], {
      env: ENV,
      fetch,
      stdout: () => {},
    });
    const mount = calls[0]?.body.arguments.mount as Record<string, unknown>;
    expect(mount).toEqual({ namespace: 'feedback/bugs', provider: 'object' });
  });

  it('parses --provider-config JSON', async () => {
    const { fetch, calls } = scriptedFetch([
      { body: { mount: { namespace: 'ns', provider: 'structured' } } },
    ]);
    await run(
      ['context', 'mount', 'ns', '--provider', 'structured', '--provider-config', '{"table":"t"}'],
      { env: ENV, fetch, stdout: () => {} },
    );
    const mount = calls[0]?.body.arguments.mount as Record<string, unknown>;
    expect(mount.providerConfig).toEqual({ table: 't' });
  });

  it('rejects non-positive --ttl (exit 2)', async () => {
    const errs: string[] = [];
    const { fetch } = scriptedFetch([{ body: {} }]);
    const code = await run(['context', 'mount', 'ns', '--provider', 'object', '--ttl', 'abc'], {
      env: ENV,
      fetch,
      stderr: (l) => errs.push(l),
    });
    expect(code).toBe(2);
    expect(errs.join('\n')).toContain('--ttl');
  });

  it('unmounts via ContextRegistry.Delete on platform subtree', async () => {
    const out: string[] = [];
    const { fetch, calls } = scriptedFetch([{ body: { deleted: true } }]);
    const code = await run(['context', 'unmount', 'research/scratch'], {
      env: ENV,
      fetch,
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(calls[0]?.url).toBe('https://x/htbp/platform/context');
    expect(calls[0]?.body.tool).toBe('Delete');
    expect(calls[0]?.body.arguments.namespace).toBe('research/scratch');
    expect(out.join('\n')).toContain('Unmounted research/scratch');
  });
});

describe('watt context error paths', () => {
  it('401 from server → exit 1', async () => {
    const errs: string[] = [];
    const { fetch } = scriptedFetch([{ body: { message: 'no read scope' }, status: 401 }]);
    const code = await run(['context', 'ls', 'feedback/bugs'], {
      env: ENV,
      fetch,
      stderr: (l) => errs.push(l),
    });
    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('401');
  });

  it('conflict from server (put --if-version) surfaces WattError message, exit 1', async () => {
    const errs: string[] = [];
    const { fetch } = scriptedFetch([
      { body: { code: 'conflict', message: 'version mismatch' }, status: 409 },
    ]);
    const code = await run(
      ['context', 'put', 'feedback/bugs', '1235', '--content', 'x', '--if-version', 'stale'],
      { env: ENV, fetch, stderr: (l) => errs.push(l) },
    );
    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('version mismatch');
  });

  it('not_found from server (patch) surfaces message, exit 1', async () => {
    const errs: string[] = [];
    const { fetch } = scriptedFetch([
      { body: { code: 'not_found', message: 'no such entry' }, status: 404 },
    ]);
    const code = await run(['context', 'patch', 'feedback/bugs', 'missing', '--content', 'x'], {
      env: ENV,
      fetch,
      stderr: (l) => errs.push(l),
    });
    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('no such entry');
  });

  it('no token → exit 2 (before any fetch)', async () => {
    const errs: string[] = [];
    const { fetch, calls } = scriptedFetch([{ body: {} }]);
    const code = await run(['context', 'ls', 'feedback/bugs'], {
      env: { WATT_BASE_URL: 'https://x' },
      fetch,
      stderr: (l) => errs.push(l),
      // 空 fs：readCredentials 读不到文件 → token 缺失。
      fs: {
        readFile: () => {
          throw new Error('no file');
        },
      },
    });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(errs.join('\n')).toContain('Not authenticated');
  });
});
