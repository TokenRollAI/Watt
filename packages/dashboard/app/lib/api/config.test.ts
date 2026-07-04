import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 视图族E config wrapper 契约测试——锁定 registerPlugin 发出的请求形状（plugin Write {manifest}）
 * 与响应解包（{registration} → registration，缺则抛错，不双形态兜底）。
 * 沿用 api.p6.test.ts 的 node-env + stub 风格。形状真源 = gateway routes.ts plugin Write。
 */

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { setBase, setToken } = await import('./core.ts');
const { registerPlugin } = await import('./config.ts');

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function reqBody(): { tool: string; arguments: Record<string, unknown> } {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string) as { tool: string; arguments: Record<string, unknown> };
}

beforeEach(() => {
  store.clear();
  setToken('tok-1');
  setBase('https://gw.test');
  fetchMock.mockReset();
});

describe('registerPlugin (§11.1/§11.2)', () => {
  const manifest = {
    id: 'my-tool',
    kind: 'tool-provider',
    interfaceVersion: 'tool-provider/v1',
    endpoint: 'https://plugin.example.com',
    auth: { kind: 'platform-token' },
    requiredGrants: [],
    healthPath: '/health',
    enabled: true,
  };

  it('POST plugin Write {manifest} to the plugin module endpoint', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        registration: {
          ...manifest,
          platformBaseUrl: 'https://gw.test',
          jwksUrl: 'https://gw.test/.well-known/jwks.json',
          pluginToken: 'ptok',
        },
      }),
    );
    await registerPlugin(manifest);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://gw.test/htbp/platform/plugin');
    expect(reqBody()).toEqual({ tool: 'Write', arguments: { manifest } });
  });

  it('unwraps registration (incl. pluginToken回传一次)', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        registration: {
          ...manifest,
          platformBaseUrl: 'https://gw.test',
          jwksUrl: 'https://gw.test/.well-known/jwks.json',
          pluginToken: 'ptok-once',
        },
      }),
    );
    const reg = await registerPlugin(manifest);
    expect(reg.pluginToken).toBe('ptok-once');
    expect(reg.jwksUrl).toBe('https://gw.test/.well-known/jwks.json');
  });

  it('throws on missing registration (契约漂移不兜底)', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ plugin: manifest }));
    await expect(registerPlugin(manifest)).rejects.toThrow(/registration/);
  });
});
