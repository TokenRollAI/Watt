import { type ReactNode, useState } from 'react';
import { api, formatError, type SecretMeta } from '../api.ts';
import { Msg, Panel, useLoad } from '../ui.tsx';

/**
 * SecretsView（P6 / Proto §6.6 SecretStore）——平台密钥管理面。
 *
 * 安全纪律（永不持久化/回显明文）：
 *  - value 输入 type=password；提交成功后立即清空本地 value/name state。
 *  - 任何 state、console、错误文案都不含明文（后端 List/Get/Write 响应本就只回元数据 + shadowedByEnv）。
 *  - 提交成功提示 "KV 传播约 1 分钟生效"（SecretStore 存 KV_TENANTS，边缘传播窗口）。
 *  - 删除二次确认（window.confirm）。
 */
export function SecretsView(): ReactNode {
  const secrets = useLoad<{ items: SecretMeta[] }>(() => api.listSecrets(), []);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  const submit = async () => {
    setBusy('writing');
    setErr('');
    setNotice('');
    try {
      await api.writeSecret(name.trim(), value);
      // 提交成功立即清空明文 state（value 绝不留存/回显）。
      setName('');
      setValue('');
      setNotice('已提交。KV 传播约 1 分钟生效。');
      secrets.reload();
    } catch (e) {
      // value 已在成功路径清空；失败路径也不回显 value，仅显示错误文案。
      setErr(formatError(e));
    } finally {
      setBusy('');
    }
  };

  const remove = async (secretName: string) => {
    if (!window.confirm(`删除密钥 ${secretName}？此操作不可撤销。`)) return;
    setBusy(secretName);
    setErr('');
    setNotice('');
    try {
      await api.deleteSecret(secretName);
      secrets.reload();
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <Panel title="Add / overwrite secret">
        <p className="muted">
          Secrets 存平台 SecretStore（KV），provider <code>secretRef</code> / plugin bearer 引用其
          name。名字规范：大写字母/数字/下划线（如 <code>ANTHROPIC_API_KEY</code>）。
        </p>
        {err && <p className="error">{err}</p>}
        {notice && <p className="muted">{notice}</p>}
        <div className="form-row">
          <input
            placeholder="name (e.g. ANTHROPIC_API_KEY)"
            value={name}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
          <input
            type="password"
            placeholder="value (write-only)"
            value={value}
            autoComplete="new-password"
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            type="button"
            disabled={!name.trim() || !value || busy === 'writing'}
            onClick={submit}
          >
            {busy === 'writing' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </Panel>
      <Panel title="Secrets" onReload={secrets.reload}>
        <Msg error={secrets.error} loading={secrets.loading} />
        {secrets.data && secrets.data.items.length === 0 && <p className="muted">(none)</p>}
        {secrets.data && secrets.data.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>name</th>
                <th>updatedAt</th>
                <th>shadowedByEnv</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {secrets.data.items.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td>{s.updatedAt ?? '(env only)'}</td>
                  <td>{s.shadowedByEnv ? 'yes ⚠︎' : 'no'}</td>
                  <td>
                    <button type="button" disabled={busy === s.name} onClick={() => remove(s.name)}>
                      {busy === s.name ? '…' : 'Delete'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">
          <code>shadowedByEnv: yes</code> 表示存在同名 env 变量，会先命中、KV 值不生效。
        </p>
      </Panel>
    </>
  );
}
