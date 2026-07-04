import { describe, expect, it } from 'vitest';
import { formatSetupGuidance, LURKER_SCRIBE_DEF, setupFeishu } from './setup.ts';

/**
 * `watt setup feishu` 编排单测（P1）——注入 fetch，断言五步 HTBP 调用序列与幂等载荷。
 * 响应形状真源：gateway 路由（plugin Write→{registration}、channel Write→{channel}、policy Write→{policy}）。
 */

interface Recorded {
  url: string;
  tool: string;
  args: Record<string, unknown>;
}

function fakeFetch(recorded: Recorded[]): typeof globalThis.fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body)) as {
      tool: string;
      arguments: Record<string, unknown>;
    };
    recorded.push({ url: u, tool: body.tool, args: body.arguments });
    if (u.endsWith('/plugin')) {
      return new Response(
        JSON.stringify({
          registration: {
            id: 'channel-feishu',
            pluginToken: 'ptoken-xyz',
            jwksUrl: 'https://watt.dev/.well-known/jwks.json',
            platformBaseUrl: 'https://watt.dev',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (u.endsWith('/channel')) {
      return new Response(JSON.stringify({ channel: { id: 'feishu', adapter: 'feishu' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.endsWith('/policy')) {
      return new Response(JSON.stringify({ policy: body.arguments.policy }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // agent Write
    return new Response(JSON.stringify({ definition: LURKER_SCRIBE_DEF }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
}

describe('setupFeishu — 幂等五步编排', () => {
  it('registers plugin, writes channel, writes lurker def, writes 2 policies (in order)', async () => {
    const recorded: Recorded[] = [];
    const result = await setupFeishu(
      'https://watt.dev',
      'admin-token',
      { endpoint: 'https://watt-plugin-feishu.example.workers.dev', encrypt: true },
      { fetch: fakeFetch(recorded) },
    );

    // 序列：plugin Write → channel Write → agent Write → policy Write ×2。
    expect(recorded.map((r) => `${r.url.split('/htbp/platform/')[1]}:${r.tool}`)).toEqual([
      'plugin:Write',
      'channel:Write',
      'agent:Write',
      'policy:Write',
      'policy:Write',
    ]);

    // plugin manifest 形状。
    const pluginArgs = recorded[0]?.args.manifest as { id: string; kind: string; endpoint: string };
    expect(pluginArgs.id).toBe('channel-feishu');
    expect(pluginArgs.kind).toBe('channel-adapter');
    expect(pluginArgs.endpoint).toBe('https://watt-plugin-feishu.example.workers.dev');

    // channel adapter=feishu。
    const chanArgs = recorded[1]?.args.channel as { id: string; adapter: string };
    expect(chanArgs).toMatchObject({ id: 'feishu', adapter: 'feishu' });

    // lurker def subscribes im.message。
    const defArgs = recorded[2]?.args.definition as { name: string; subscriptions: unknown[] };
    expect(defArgs.name).toBe('lurker/scribe');
    expect(defArgs.subscriptions).toHaveLength(1);

    // 两条策略：plugin Publish（platform://event manage）+ lurker outbound（event://* write）。
    const pol1 = recorded[3]?.args.policy as {
      subject: string;
      resource: string;
      actions: string[];
    };
    const pol2 = recorded[4]?.args.policy as {
      subject: string;
      resource: string;
      actions: string[];
    };
    expect(pol1).toMatchObject({
      subject: 'plugin:channel-feishu',
      resource: 'platform://event',
      actions: ['manage'],
    });
    expect(pol2).toMatchObject({
      subject: 'agent:lurker/scribe',
      resource: 'event://*',
      actions: ['write'],
    });

    // 结果携带 pluginToken（供操作者 secret put）。
    expect(result.pluginToken).toBe('ptoken-xyz');
    expect(result.channelId).toBe('feishu');
  });

  it('uses a custom channel id when provided', async () => {
    const recorded: Recorded[] = [];
    await setupFeishu(
      'https://watt.dev',
      't',
      { endpoint: 'https://p.example.dev', channelId: 'feishu-main' },
      { fetch: fakeFetch(recorded) },
    );
    const chanArgs = recorded[1]?.args.channel as { id: string };
    expect(chanArgs.id).toBe('feishu-main');
  });

  it('policy ids are fixed (idempotent re-run upserts, not duplicates)', async () => {
    const recorded: Recorded[] = [];
    await setupFeishu(
      'https://watt.dev',
      't',
      { endpoint: 'https://p.example.dev' },
      { fetch: fakeFetch(recorded) },
    );
    const ids = [recorded[3], recorded[4]].map((r) => (r?.args.policy as { id: string }).id);
    expect(ids).toEqual(['feishu-plugin-publish', 'feishu-lurker-outbound']);
  });

  it('formatSetupGuidance includes the webhook URL and the pluginToken', () => {
    const guidance = formatSetupGuidance({
      pluginId: 'channel-feishu',
      channelId: 'feishu',
      endpoint: 'https://p.example.dev',
      pluginToken: 'ptoken-abc',
      jwksUrl: 'https://watt.dev/.well-known/jwks.json',
      platformBaseUrl: 'https://watt.dev',
      encrypt: true,
    });
    expect(guidance).toContain('https://p.example.dev/webhook/event');
    expect(guidance).toContain('ptoken-abc');
    expect(guidance).toContain('FEISHU_ENCRYPT_KEY');
  });
});
