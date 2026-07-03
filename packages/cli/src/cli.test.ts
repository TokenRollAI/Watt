import { describe, expect, it, vi } from 'vitest';
import { run } from './cli.ts';
import { CliError, readEnv } from './env.ts';
import { fetchStatus } from './status.ts';

function mockFetchOk(body: unknown): typeof globalThis.fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof globalThis.fetch;
}

/** 按脚本序列返回的 mock fetch（device flow 多步）。 */
function scriptedFetch(responses: (() => Response)[]): typeof globalThis.fetch {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)] ?? responses[responses.length - 1];
    i++;
    if (!r) throw new Error('no scripted response');
    return r();
  }) as unknown as typeof globalThis.fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const LOGIN_AUTHORIZE = () =>
  jsonResponse({
    device_code: 'dc-1',
    user_code: 'ABCD2345',
    verification_uri: 'https://x/device',
    expires_in: 600,
    interval: 5,
  });

describe('readEnv', () => {
  it('reads and trims WATT_BASE_URL / WATT_TOKEN', () => {
    expect(readEnv({ WATT_BASE_URL: ' https://x ', WATT_TOKEN: 't ' })).toEqual({
      baseUrl: 'https://x',
      token: 't',
    });
  });
  it('returns undefined for missing/empty vars', () => {
    expect(readEnv({ WATT_BASE_URL: '' })).toEqual({ baseUrl: undefined, token: undefined });
  });
});

describe('fetchStatus', () => {
  it('resolves raw healthz JSON on success', async () => {
    const fetch = mockFetchOk({ ok: true, version: '0.1.0', service: 'watt-gateway' });
    const result = await fetchStatus({ baseUrl: 'https://x/' }, { fetch });
    expect(result.raw.service).toBe('watt-gateway');
    expect(fetch).toHaveBeenCalledWith('https://x/healthz', expect.anything());
  });

  it('adds Authorization header when token present', async () => {
    const fetch = mockFetchOk({ ok: true, version: '1', service: 'watt-gateway' });
    await fetchStatus({ baseUrl: 'https://x', token: 'abc' }, { fetch });
    const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    const init = call?.[1] as { headers: Record<string, string> };
    expect(init.headers.authorization).toBe('Bearer abc');
  });

  it('throws CliError(2) when baseUrl missing', async () => {
    await expect(fetchStatus({}, {})).rejects.toMatchObject({ exitCode: 2 });
  });

  it('throws CliError(1) on non-2xx', async () => {
    const fetch = vi.fn(async () => new Response('nope', { status: 503 }));
    await expect(
      fetchStatus({ baseUrl: 'https://x' }, { fetch: fetch as unknown as typeof globalThis.fetch }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it('throws CliError(1) on network failure', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      fetchStatus({ baseUrl: 'https://x' }, { fetch: fetch as unknown as typeof globalThis.fetch }),
    ).rejects.toMatchObject({ exitCode: 1 });
  });
});

describe('run() — watt status', () => {
  it('prints human-readable summary by default', async () => {
    const lines: string[] = [];
    const fetch = mockFetchOk({ ok: true, version: '0.1.0', service: 'watt-gateway' });
    process.env.WATT_BASE_URL = 'https://x';
    const code = await run(['status'], { stdout: (l) => lines.push(l), fetch });
    delete process.env.WATT_BASE_URL;
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('watt-gateway');
    expect(lines.join('\n')).toContain('healthy');
  });

  it('prints JSON.parse-able output with --json', async () => {
    const lines: string[] = [];
    const fetch = mockFetchOk({ ok: true, version: '0.1.0', service: 'watt-gateway' });
    process.env.WATT_BASE_URL = 'https://x';
    const code = await run(['--json', 'status'], { stdout: (l) => lines.push(l), fetch });
    delete process.env.WATT_BASE_URL;
    expect(code).toBe(0);
    // R23：status --json 输出完整 StatusResult（含 raw + 可选 metrics）；无 token 时无 metrics 段。
    const parsed = JSON.parse(lines.join('\n'));
    expect(parsed.raw).toEqual({ ok: true, version: '0.1.0', service: 'watt-gateway' });
  });

  it('exits non-zero when WATT_BASE_URL missing', async () => {
    const errs: string[] = [];
    delete process.env.WATT_BASE_URL;
    const code = await run(['status'], { stderr: (l) => errs.push(l) });
    expect(code).toBe(2);
    expect(errs.join('\n')).toContain('WATT_BASE_URL');
  });

  it('with token: appends live metrics summary (instances/tasks/tokens)', async () => {
    const lines: string[] = [];
    // healthz + 3 metrics queries（agent_instances/tasks/tokens）——按调用序返回。
    let n = 0;
    const fetch = vi.fn(async (url: string) => {
      n++;
      if (String(url).endsWith('/healthz')) {
        return jsonResponse({ ok: true, version: '0.1.0', service: 'watt-gateway' });
      }
      // metrics Query 返回单点 series（每个 metric 给不同值）。
      const v = n === 2 ? 3 : n === 3 ? 5 : 42;
      return jsonResponse({ series: [{ labels: {}, points: [{ t: 'x', v }] }] });
    }) as unknown as typeof globalThis.fetch;
    process.env.WATT_BASE_URL = 'https://x';
    process.env.WATT_TOKEN = 'tok';
    const code = await run(['status'], { stdout: (l) => lines.push(l), fetch });
    delete process.env.WATT_BASE_URL;
    delete process.env.WATT_TOKEN;
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('agent instances');
    expect(text).toContain('tasks');
    expect(text).toContain('tokens today');
  });
});

describe('run() — watt login', () => {
  it('emits a parseable user_code JSON line then a final result JSON line (NDJSON) with --json', async () => {
    const lines: string[] = [];
    const fetch = scriptedFetch([
      LOGIN_AUTHORIZE,
      () => jsonResponse({ access_token: 'tok-abcdef123', token_type: 'Bearer', expires_in: 3600 }),
    ]);
    process.env.WATT_BASE_URL = 'https://x';
    const code = await run(['--json', 'login'], {
      stdout: (l) => lines.push(l),
      fetch,
      sleep: async () => {},
      now: () => 0,
      credentialsPath: '/tmp/.watt/credentials.json',
      fs: { mkdir: () => {}, writeFile: () => {}, chmod: () => {} },
    });
    delete process.env.WATT_BASE_URL;
    expect(code).toBe(0);
    // NDJSON：每行独立可解析；无人类可读进度提示混入。
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    const authLine = lines.map((l) => JSON.parse(l)).find((p) => typeof p.user_code === 'string');
    expect(authLine?.user_code).toBe('ABCD2345');
    expect(authLine?.verification_uri).toBe('https://x/device');
    expect(authLine?.expires_in).toBe(600);
    // 最终结果 JSON 仍在最后一行，未被破坏。
    const finalLine = JSON.parse(lines[lines.length - 1] ?? '{}');
    expect(finalLine.token_type).toBe('Bearer');
    expect(finalLine.access_token_prefix).toBe('tok-abcd...');
  });

  it('non-json mode prints human-readable progress unchanged', async () => {
    const lines: string[] = [];
    const fetch = scriptedFetch([
      LOGIN_AUTHORIZE,
      () => jsonResponse({ access_token: 'tok-abcdef123', token_type: 'Bearer', expires_in: 3600 }),
    ]);
    process.env.WATT_BASE_URL = 'https://x';
    const code = await run(['login'], {
      stdout: (l) => lines.push(l),
      fetch,
      sleep: async () => {},
      now: () => 0,
      credentialsPath: '/tmp/.watt/credentials.json',
      fs: { mkdir: () => {}, writeFile: () => {}, chmod: () => {} },
    });
    delete process.env.WATT_BASE_URL;
    expect(code).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('ABCD2345');
    expect(out).toContain('Logged in.');
    // 无中途授权码 JSON 混入。
    expect(out).not.toContain('"user_code"');
  });
});
