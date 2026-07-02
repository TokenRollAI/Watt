/**
 * `watt channel list|set`：POST /htbp/platform/channel `{tool,arguments}`（Architecture M10）。
 *
 *  - list → ChannelRegistry.List，arguments:{opts:{}}。返回 §0.2 Page `{items}`。
 *  - set  → ChannelRegistry.Write（upsert 幂等），arguments:{channel:{id,adapter,enabled,settings,defaultAgent?}}。
 *           M10「channel set」= Write/Update；这里用 Write 幂等 upsert（相同 id 覆盖）。
 */

import { type HttpDeps, htbpCall } from './client.ts';

export interface ChannelView {
  id: string;
  adapter: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  defaultAgent?: string;
}

export async function channelList(
  base: string,
  token: string,
  deps: HttpDeps = {},
): Promise<ChannelView[]> {
  const body = (await htbpCall(base, token, 'channel', 'List', { opts: {} }, deps)) as {
    items: ChannelView[];
  };
  return body.items;
}

export interface SetChannelInput {
  id: string;
  adapter: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  defaultAgent?: string;
}

export async function channelSet(
  base: string,
  token: string,
  input: SetChannelInput,
  deps: HttpDeps = {},
): Promise<ChannelView> {
  const channel: Record<string, unknown> = {
    id: input.id,
    adapter: input.adapter,
    enabled: input.enabled,
    settings: input.settings,
  };
  if (input.defaultAgent !== undefined) channel.defaultAgent = input.defaultAgent;
  const body = (await htbpCall(base, token, 'channel', 'Write', { channel }, deps)) as {
    channel: ChannelView;
  };
  return body.channel;
}

export function formatChannelListHuman(channels: ChannelView[]): string {
  if (!channels.length) return '(no channels)';
  return channels
    .map(
      (c) =>
        `${c.id}\t${c.adapter}\t${c.enabled ? 'enabled' : 'disabled'}\t${c.defaultAgent ?? '-'}`,
    )
    .join('\n');
}
