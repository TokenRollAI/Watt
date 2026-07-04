import { type ReactNode, useState } from 'react';
import { api, formatError, type ModelProviderPublic, type SecretMeta } from '../api.ts';
import { Msg, Panel, useLoad } from '../ui.tsx';

/**
 * ProvidersView（P6 / Proto §9 ModelProviderRegistry）——模型 provider CRUD。
 *
 *  - List（platform/provider List）→ 脱敏投影**不含 secretRef**（永不回显），故列表不显示 secretRef 值。
 *  - Write（新增/覆写）：id/vendor/models/priority/secretRef/default/enabled 全字段。
 *  - Update：每行 enabled 开关（patch:{enabled}）。
 *  - SetDefault：每行 "Set default"（全局唯一 default 由后端保证）。
 *  - secretRef 用 datalist 下拉：选项 = SecretStore List 的名字 + 允许手输 env 名（datalist 既下拉又自由输入）。
 *    列表读取失败（如非 admin 无 platform://secret read）时 datalist 空，仍可手输——不阻塞。
 */
export function ProvidersView(): ReactNode {
  const providers = useLoad<{ items: ModelProviderPublic[] }>(() => api.listProviders(), []);
  // secretRef 候选名（读失败静默：datalist 空，允许手输）。
  const secrets = useLoad<{ items: SecretMeta[] }>(() => api.listSecrets(), []);
  const secretNames = (secrets.data?.items ?? []).map((s) => s.name);

  const [id, setId] = useState('');
  const [vendor, setVendor] = useState('anthropic');
  const [models, setModels] = useState('');
  const [priority, setPriority] = useState('10');
  const [secretRef, setSecretRef] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const create = async () => {
    setBusy('writing');
    setErr('');
    try {
      await api.writeProvider({
        id: id.trim(),
        vendor: vendor.trim(),
        models: models
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean),
        priority: Number(priority) || 0,
        default: isDefault,
        secretRef: secretRef.trim(),
        enabled,
      });
      setId('');
      setModels('');
      providers.reload();
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setBusy('');
    }
  };

  const toggle = async (p: ModelProviderPublic) => {
    setBusy(p.id);
    setErr('');
    try {
      await api.updateProvider(p.id, { enabled: !p.enabled });
      providers.reload();
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setBusy('');
    }
  };

  const makeDefault = async (p: ModelProviderPublic) => {
    setBusy(`default:${p.id}`);
    setErr('');
    try {
      await api.setDefaultProvider(p.id);
      providers.reload();
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <Panel title="Add / overwrite model provider">
        <p className="muted">
          <code>secretRef</code> 引用 SecretStore 名字或环境变量名（存放 API key）——provider
          本身永不回显密钥。
        </p>
        {err && <p className="error">{err}</p>}
        <div className="form-row">
          <input placeholder="id" value={id} onChange={(e) => setId(e.target.value)} />
          <input
            placeholder="vendor (e.g. anthropic)"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
          />
          <input
            placeholder="models (comma separated)"
            value={models}
            onChange={(e) => setModels(e.target.value)}
          />
          <input
            type="number"
            placeholder="priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
          <input
            list="secret-names"
            placeholder="secretRef"
            value={secretRef}
            onChange={(e) => setSecretRef(e.target.value)}
          />
          <datalist id="secret-names">
            {secretNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <label className="muted">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />{' '}
            enabled
          </label>
          <label className="muted">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
            />{' '}
            default
          </label>
          <button
            type="button"
            disabled={!id.trim() || !vendor.trim() || !secretRef.trim() || busy === 'writing'}
            onClick={create}
          >
            {busy === 'writing' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </Panel>
      <Panel title="Model providers" onReload={providers.reload}>
        <Msg error={providers.error} loading={providers.loading} />
        {providers.data && providers.data.items.length === 0 && <p className="muted">(none)</p>}
        {providers.data && providers.data.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>id</th>
                <th>vendor</th>
                <th>models</th>
                <th>priority</th>
                <th>default</th>
                <th>enabled</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {providers.data.items.map((p) => (
                <tr key={p.id}>
                  <td>{p.id}</td>
                  <td>{p.vendor}</td>
                  <td>{p.models.join(', ')}</td>
                  <td>{p.priority}</td>
                  <td>{p.default ? '★' : ''}</td>
                  <td>{p.enabled ? 'yes' : 'no'}</td>
                  <td>
                    <button type="button" disabled={busy === p.id} onClick={() => toggle(p)}>
                      {busy === p.id ? '…' : p.enabled ? 'Disable' : 'Enable'}
                    </button>{' '}
                    <button
                      type="button"
                      disabled={p.default || busy === `default:${p.id}`}
                      onClick={() => makeDefault(p)}
                    >
                      {busy === `default:${p.id}` ? '…' : 'Set default'}
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
