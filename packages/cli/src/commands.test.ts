import { describe, expect, it, vi } from 'vitest';
import { run } from './cli.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 单一响应 mock（所有请求都返回同一个）。 */
function fixedFetch(body: unknown, status = 200): typeof globalThis.fetch {
  return vi.fn(async () => jsonResponse(body, status)) as unknown as typeof globalThis.fetch;
}

const ENV = { WATT_BASE_URL: 'https://x', WATT_TOKEN: 'tok-test' };

describe('watt whoami', () => {
  it('prints principal/roles (human)', async () => {
    const out: string[] = [];
    const code = await run(['whoami'], {
      env: ENV,
      fetch: fixedFetch({ principal: 'user:djj', roles: ['admin'], traceId: 't', agent: null }),
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('user:djj');
    expect(out.join('\n')).toContain('admin');
  });

  it('--json emits parseable output', async () => {
    const out: string[] = [];
    const code = await run(['--json', 'whoami'], {
      env: ENV,
      fetch: fixedFetch({ principal: 'user:djj', roles: ['admin'], traceId: 't', agent: null }),
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join('\n')).principal).toBe('user:djj');
  });

  it('exits 1 on 401', async () => {
    const errs: string[] = [];
    const code = await run(['whoami'], {
      env: ENV,
      fetch: fixedFetch(
        { code: 'permission_denied', message: 'missing token', retryable: false },
        401,
      ),
      stderr: (l) => errs.push(l),
    });
    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('401');
  });

  it('exits 2 when no token available', async () => {
    const errs: string[] = [];
    const code = await run(['whoami'], {
      env: { WATT_BASE_URL: 'https://x' },
      credentialsPath: '/nonexistent/credentials.json',
      fetch: fixedFetch({}),
      stderr: (l) => errs.push(l),
    });
    expect(code).toBe(2);
    expect(errs.join('\n')).toContain('Not authenticated');
  });
});

describe('watt policy', () => {
  it('list prints seed policy (human)', async () => {
    const out: string[] = [];
    const code = await run(['policy', 'list'], {
      env: ENV,
      fetch: fixedFetch({
        items: [
          { id: 'seed', subject: 'role:admin', resource: '*', actions: ['*'], effect: 'allow' },
        ],
      }),
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('role:admin');
  });

  it('list --json emits array', async () => {
    const out: string[] = [];
    const code = await run(['--json', 'policy', 'list'], {
      env: ENV,
      fetch: fixedFetch({ items: [] }),
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual([]);
  });

  it('list with --subject sends opts.filter.subject (Proto ListOptions)', async () => {
    const calls: { body: unknown }[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ body: JSON.parse(init.body as string) });
      return jsonResponse({ items: [] });
    }) as unknown as typeof globalThis.fetch;
    const code = await run(['policy', 'list', '--subject', 'role:admin'], {
      env: ENV,
      fetch,
      stdout: () => {},
    });
    expect(code).toBe(0);
    const body = calls[0]?.body as {
      tool: string;
      arguments: { opts: { filter: { subject: string } } };
    };
    expect(body.tool).toBe('List');
    expect(body.arguments.opts.filter.subject).toBe('role:admin');
  });

  it('add sends Write and reports id', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return jsonResponse({
        policy: {
          id: 'pol-x',
          subject: 'user:a',
          resource: 'r',
          actions: ['read'],
          effect: 'allow',
        },
      });
    }) as unknown as typeof globalThis.fetch;
    const out: string[] = [];
    const code = await run(
      ['policy', 'add', '--subject', 'user:a', '--resource', 'r', '--actions', 'read,write'],
      { env: ENV, fetch, stdout: (l) => out.push(l) },
    );
    expect(code).toBe(0);
    const body = calls[0]?.body as { tool: string; arguments: { policy: { actions: string[] } } };
    expect(body.tool).toBe('Write');
    expect(body.arguments.policy.actions).toEqual(['read', 'write']);
  });

  it('add rejects invalid --effect with exit 2', async () => {
    const errs: string[] = [];
    const code = await run(
      [
        'policy',
        'add',
        '--subject',
        's',
        '--resource',
        'r',
        '--actions',
        'read',
        '--effect',
        'maybe',
      ],
      { env: ENV, fetch: fixedFetch({}), stderr: (l) => errs.push(l) },
    );
    expect(code).toBe(2);
  });

  it('rm sends Delete', async () => {
    const calls: unknown[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string));
      return jsonResponse({ deleted: true });
    }) as unknown as typeof globalThis.fetch;
    const code = await run(['policy', 'rm', 'pol-x'], { env: ENV, fetch, stdout: () => {} });
    expect(code).toBe(0);
    expect((calls[0] as { tool: string }).tool).toBe('Delete');
  });
});

describe('watt audit list', () => {
  it('prints empty structure (human)', async () => {
    const out: string[] = [];
    const code = await run(['audit', 'list'], {
      env: ENV,
      fetch: fixedFetch({ items: [] }),
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('no audit records');
  });

  it('--json emits the Page shape (items)', async () => {
    const out: string[] = [];
    const code = await run(['--json', 'audit', 'list'], {
      env: ENV,
      fetch: fixedFetch({ items: [] }),
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual({ items: [] });
  });
});

describe('watt login --approve', () => {
  it('calls approve endpoint with admin token', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return jsonResponse({ approved: true, principal: 'user:djj' });
    }) as unknown as typeof globalThis.fetch;
    const out: string[] = [];
    const code = await run(['login', '--approve', 'ABCD2345'], {
      env: ENV,
      fetch,
      stdout: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(calls[0]?.url).toContain('/oauth/device/approve');
    expect((calls[0]?.body as { user_code: string }).user_code).toBe('ABCD2345');
    expect(out.join('\n')).toContain('Approved');
  });

  it('exits 1 on 403 (non-admin)', async () => {
    const errs: string[] = [];
    const code = await run(['login', '--approve', 'ABCD2345'], {
      env: ENV,
      fetch: fixedFetch({ code: 'permission_denied' }, 403),
      stderr: (l) => errs.push(l),
    });
    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('403');
  });
});

describe('token resolution order', () => {
  it('prefers WATT_TOKEN over credentials file', async () => {
    const seen: string[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(String((init.headers as Record<string, string>).authorization));
      return jsonResponse({ principal: 'user:djj', roles: [], traceId: 't', agent: null });
    }) as unknown as typeof globalThis.fetch;
    await run(['whoami'], {
      env: { WATT_BASE_URL: 'https://x', WATT_TOKEN: 'env-token' },
      credentialsPath: '/tmp/creds.json',
      fs: { readFile: () => JSON.stringify({ access_token: 'file-token' }) },
      fetch,
      stdout: () => {},
    });
    expect(seen[0]).toBe('Bearer env-token');
  });

  it('falls back to credentials file when WATT_TOKEN absent', async () => {
    const seen: string[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(String((init.headers as Record<string, string>).authorization));
      return jsonResponse({ principal: 'user:djj', roles: [], traceId: 't', agent: null });
    }) as unknown as typeof globalThis.fetch;
    await run(['whoami'], {
      env: { WATT_BASE_URL: 'https://x' },
      credentialsPath: '/tmp/creds.json',
      fs: { readFile: () => JSON.stringify({ access_token: 'file-token' }) },
      fetch,
      stdout: () => {},
    });
    expect(seen[0]).toBe('Bearer file-token');
  });
});
