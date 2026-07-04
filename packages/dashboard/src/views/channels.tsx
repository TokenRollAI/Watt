import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  api,
  type ChannelConfig,
  formatError,
  type PluginHealth,
  type PluginManifest,
} from '../api.ts';
import { Msg, Panel, useLoad } from '../ui.tsx';

const FEISHU_PLUGIN_ID = 'channel-feishu';

/**
 * ChannelsView（P6 / Proto §2.2 ChannelRegistry + §11 Plugin）——渠道列表 + feishu 专用卡片。
 *
 *  - channel 列表（platform/channel List）+ 每行 enabled 开关（Update {channelId,patch:{enabled}}）。
 *  - feishu 卡片：plugin 注册状态 + health（platform/plugin Get/Health `channel-feishu`）。
 *    · 已注册：显示 endpoint。若 endpoint 为 HTTPS base 显示 `<endpoint>/webhook/event`（入站 webhook）；
 *      若为平台内 `binding:*`（当前 push 型 WS adapter 现状）显示平台内绑定说明。
 *    · 未注册（Get 404）：显示引导文案 `watt setup feishu`。
 *  - 飞书密钥随 plugin 自持，不经 SecretStore；卡片只做状态检查。
 *
 * 说明：webhook 契约以 gateway plugin-registry.ts / routes.ts plugin 端点现状为准（P1 plugin-feishu
 *   若未合入，feishu endpoint 仍为种子 `binding:feishu`——卡片按现状渲染，不臆测公网 webhook URL）。
 */
export function ChannelsView(): ReactNode {
  const channels = useLoad<{ items: ChannelConfig[] }>(() => api.listChannels(), []);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const toggle = async (ch: ChannelConfig) => {
    setBusy(ch.id);
    setErr('');
    try {
      await api.updateChannel(ch.id, { enabled: !ch.enabled });
      channels.reload();
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <FeishuCard />
      <Panel title="Channels" onReload={channels.reload}>
        <Msg error={channels.error} loading={channels.loading} />
        {err && <p className="error">{err}</p>}
        {channels.data && channels.data.items.length === 0 && <p className="muted">(none)</p>}
        {channels.data && channels.data.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>id</th>
                <th>adapter</th>
                <th>defaultAgent</th>
                <th>enabled</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {channels.data.items.map((ch) => (
                <tr key={ch.id}>
                  <td>{ch.id}</td>
                  <td>{ch.adapter}</td>
                  <td>{ch.defaultAgent ?? ''}</td>
                  <td>{ch.enabled ? 'yes' : 'no'}</td>
                  <td>
                    <button type="button" disabled={busy === ch.id} onClick={() => toggle(ch)}>
                      {busy === ch.id ? '…' : ch.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

type FeishuState =
  | { status: 'loading' }
  | { status: 'not-registered' }
  | { status: 'error'; message: string }
  | { status: 'ok'; plugin: PluginManifest; health: PluginHealth | null; healthErr: string };

/** feishu plugin 注册/health 状态卡片。Get 404 → 未注册引导；其余错误如实显示。 */
function FeishuCard(): ReactNode {
  const [state, setState] = useState<FeishuState>({ status: 'loading' });

  const load = useCallback(() => {
    setState({ status: 'loading' });
    api
      .getPlugin(FEISHU_PLUGIN_ID)
      .then(async ({ plugin }) => {
        // 注册存在 → 再取 health（health 失败不阻塞卡片，单列错误）。
        let health: PluginHealth | null = null;
        let healthErr = '';
        try {
          health = (await api.pluginHealth(FEISHU_PLUGIN_ID)).health;
        } catch (e) {
          healthErr = formatError(e);
        }
        setState({ status: 'ok', plugin, health, healthErr });
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) {
          setState({ status: 'not-registered' });
        } else {
          setState({ status: 'error', message: formatError(e) });
        }
      });
  }, []);

  useEffect(load, [load]);

  return (
    <Panel title="Feishu channel" onReload={load}>
      {state.status === 'loading' && <p className="muted">Loading…</p>}
      {state.status === 'error' && <p className="error">{state.message}</p>}
      {state.status === 'not-registered' && (
        <div>
          <p className="muted">
            Feishu plugin (<code>{FEISHU_PLUGIN_ID}</code>) 未注册。
          </p>
          <p className="muted">
            引导：运行 <code>watt setup feishu</code> 完成注册与连接。
          </p>
        </div>
      )}
      {state.status === 'ok' && (
        <FeishuDetails plugin={state.plugin} health={state.health} healthErr={state.healthErr} />
      )}
    </Panel>
  );
}

function FeishuDetails({
  plugin,
  health,
  healthErr,
}: {
  plugin: PluginManifest;
  health: PluginHealth | null;
  healthErr: string;
}): ReactNode {
  const isHttps = plugin.endpoint.startsWith('https://');
  const webhookUrl = isHttps ? `${plugin.endpoint.replace(/\/+$/, '')}/webhook/event` : null;
  return (
    <div className="form-col">
      <div>
        <span className="muted">Registration: </span>
        <strong>{plugin.enabled ? 'enabled' : 'disabled'}</strong>{' '}
        <span className="muted">
          (kind {plugin.kind}, {plugin.interfaceVersion})
        </span>
      </div>
      <div>
        <span className="muted">Health: </span>
        {healthErr ? (
          <span className="error">{healthErr}</span>
        ) : health ? (
          <strong className={health.healthy ? '' : 'error'}>
            {health.healthy ? 'healthy' : 'unhealthy'}
          </strong>
        ) : (
          <span className="muted">—</span>
        )}
        {health?.detail && <span className="muted"> · {health.detail}</span>}
      </div>
      <div>
        <span className="muted">Endpoint: </span>
        <code>{plugin.endpoint}</code>
      </div>
      {webhookUrl ? (
        <div>
          <span className="muted">Webhook URL（入站事件）: </span>
          <code>{webhookUrl}</code>
        </div>
      ) : (
        <p className="muted">
          Endpoint 为平台内绑定（<code>{plugin.endpoint}</code>），飞书为 WS push 型渠道——由{' '}
          <code>watt connect feishu</code> 承载长连接，无对外 webhook URL。
        </p>
      )}
    </div>
  );
}
