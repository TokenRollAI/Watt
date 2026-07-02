import { describe, expect, it, vi } from 'vitest';
import { login } from './login.ts';

/** 制造一个按脚本序列返回的 mock fetch。 */
function scriptedFetch(responses: (() => Response)[]): typeof globalThis.fetch {
  let i = 0;
  return vi.fn(async () => {
    const idx = Math.min(i, responses.length - 1);
    const r = responses[idx] ?? responses[responses.length - 1];
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

const AUTHORIZE = () =>
  jsonResponse({
    device_code: 'dc-1',
    user_code: 'ABCD2345',
    verification_uri: 'https://x/device',
    expires_in: 600,
    interval: 5,
  });

describe('login() polling', () => {
  it('polls through authorization_pending then succeeds and writes credentials 0600', async () => {
    const fetch = scriptedFetch([
      AUTHORIZE,
      () => jsonResponse({ error: 'authorization_pending' }, 400),
      () => jsonResponse({ error: 'authorization_pending' }, 400),
      () => jsonResponse({ access_token: 'tok-abc', token_type: 'Bearer', expires_in: 3600 }),
    ]);
    const writes: { path: string; data: string }[] = [];
    let chmodMode = 0;
    const lines: string[] = [];
    const result = await login('https://x', (l) => lines.push(l), {
      fetch,
      sleep: async () => {},
      now: () => 0,
      credentialsPath: '/tmp/.watt/credentials.json',
      fs: {
        mkdir: () => {},
        writeFile: (p, d) => writes.push({ path: p, data: d }),
        chmod: (_p, m) => {
          chmodMode = m;
        },
      },
    });
    expect(result.access_token).toBe('tok-abc');
    // 凭据写入并 chmod 0600
    expect(writes).toHaveLength(1);
    expect(chmodMode).toBe(0o600);
    const saved = JSON.parse(writes[0]?.data ?? '{}');
    expect(saved.access_token).toBe('tok-abc');
    // 打印了 user_code 提示
    expect(lines.join('\n')).toContain('ABCD2345');
  });

  it('invokes onDeviceAuthorized with the structured authorize response', async () => {
    const fetch = scriptedFetch([
      AUTHORIZE,
      () => jsonResponse({ access_token: 'tok-abc', token_type: 'Bearer', expires_in: 3600 }),
    ]);
    const authorized: { user_code: string; verification_uri: string; expires_in: number }[] = [];
    await login('https://x', () => {}, {
      fetch,
      sleep: async () => {},
      now: () => 0,
      credentialsPath: '/tmp/.watt/credentials.json',
      fs: { mkdir: () => {}, writeFile: () => {}, chmod: () => {} },
      onDeviceAuthorized: (auth) => authorized.push(auth),
    });
    expect(authorized).toHaveLength(1);
    expect(authorized[0]?.user_code).toBe('ABCD2345');
    expect(authorized[0]?.verification_uri).toBe('https://x/device');
    expect(authorized[0]?.expires_in).toBe(600);
  });

  it('fails on expired_token', async () => {
    const fetch = scriptedFetch([AUTHORIZE, () => jsonResponse({ error: 'expired_token' }, 400)]);
    await expect(
      login('https://x', () => {}, {
        fetch,
        sleep: async () => {},
        now: () => 0,
        fs: { mkdir: () => {}, writeFile: () => {}, chmod: () => {} },
      }),
    ).rejects.toMatchObject({ exitCode: 1 });
  });

  it('times out when now() passes the deadline', async () => {
    let t = 0;
    const fetch = scriptedFetch([
      AUTHORIZE,
      () => jsonResponse({ error: 'authorization_pending' }, 400),
    ]);
    await expect(
      login('https://x', () => {}, {
        fetch,
        sleep: async () => {},
        now: () => {
          t += 1_000_000;
          return t;
        },
        fs: { mkdir: () => {}, writeFile: () => {}, chmod: () => {} },
      }),
    ).rejects.toMatchObject({ exitCode: 1 });
  });

  it('propagates an unexpected OAuth error', async () => {
    const fetch = scriptedFetch([AUTHORIZE, () => jsonResponse({ error: 'invalid_grant' }, 400)]);
    await expect(
      login('https://x', () => {}, {
        fetch,
        sleep: async () => {},
        now: () => 0,
        fs: { mkdir: () => {}, writeFile: () => {}, chmod: () => {} },
      }),
    ).rejects.toMatchObject({ exitCode: 1 });
  });
});
