import { type ReactNode, useEffect, useState } from 'react';
import {
  type AgentDefinition,
  type AgentInstance,
  type AuditRecord,
  api,
  type CronJob,
  formatError,
  getBase,
  getToken,
  healthz,
  setBase,
  setToken,
  type TaskInfo,
} from './api.ts';
import { Msg, Panel, Table, useLoad } from './ui.tsx';
import { ChannelsView } from './views/channels.tsx';
import { ProvidersView } from './views/providers.tsx';
import { SecretsView } from './views/secrets.tsx';

/**
 * Watt Dashboard（M10 + P6 配置面）——三对等管理入口之一（Dashboard/ManageAgent/CLI），纯 Platform API 客户端。
 * 视图：Overview / Agents / Tasks / Cron / Audit / Secrets / Channels / Providers（含写操作）/ Settings。
 * token 手填持久化 localStorage（最小面）；所有数据经 HTBP /htbp/platform/*（同 CLI 调用面 → AuditLog 对等）。
 */

type Tab =
  | 'overview'
  | 'agents'
  | 'tasks'
  | 'cron'
  | 'audit'
  | 'secrets'
  | 'channels'
  | 'providers'
  | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'agents', label: 'Agents' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'cron', label: 'Cron' },
  { id: 'audit', label: 'Audit' },
  { id: 'secrets', label: 'Secrets' },
  { id: 'channels', label: 'Channels' },
  { id: 'providers', label: 'Providers' },
  { id: 'settings', label: 'Settings' },
];

export function App(): ReactNode {
  const [tab, setTab] = useState<Tab>('overview');
  const [principal, setPrincipal] = useState<string>('');

  useEffect(() => {
    if (!getToken()) {
      setTab('settings');
      return;
    }
    api
      .whoami()
      .then((w) => setPrincipal(w.principal))
      .catch(() => setPrincipal(''));
  }, []);

  return (
    <div className="app">
      <header>
        <h1>Watt</h1>
        <nav>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <span className="principal">{principal ? `● ${principal}` : '○ no token'}</span>
      </header>
      <main>
        {tab === 'overview' && <Overview />}
        {tab === 'agents' && <Agents />}
        {tab === 'tasks' && <Tasks />}
        {tab === 'cron' && <Cron />}
        {tab === 'audit' && <Audit />}
        {tab === 'secrets' && <SecretsView />}
        {tab === 'channels' && <ChannelsView />}
        {tab === 'providers' && <ProvidersView />}
        {tab === 'settings' && <Settings onSaved={() => setTab('overview')} />}
      </main>
    </div>
  );
}

// ─── Overview（status 汇总 + metrics tokens）─────────────────────────────
function Overview(): ReactNode {
  const health = useLoad(() => healthz(), []);
  const instances = useLoad(() => api.listAgentInstances(), []);
  const tasks = useLoad(() => api.listTasks(), []);
  const tokens = useLoad(() => {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 86400000);
    return api.queryMetric('tokens', from.toISOString(), to.toISOString());
  }, []);

  const tokenTotal = (tokens.data?.series ?? []).reduce(
    (a, s) => a + s.points.reduce((b, p) => b + p.v, 0),
    0,
  );

  return (
    <Panel title="Overview">
      <Msg error={health.error || instances.error || tasks.error || tokens.error} loading={false} />
      <div className="cards">
        <div className="card">
          <div className="card-num">{health.data?.ok ? 'OK' : '—'}</div>
          <div className="card-label">
            Gateway {health.data?.version ? `v${health.data.version}` : ''}
          </div>
        </div>
        <div className="card">
          <div className="card-num">{instances.data?.items.length ?? '—'}</div>
          <div className="card-label">Agent instances</div>
        </div>
        <div className="card">
          <div className="card-num">{tasks.data?.items.length ?? '—'}</div>
          <div className="card-label">Tasks</div>
        </div>
        <div className="card">
          <div className="card-num">{tokens.data ? tokenTotal : '—'}</div>
          <div className="card-label">Tokens (7d)</div>
        </div>
      </div>
    </Panel>
  );
}

// ─── Agents（definitions + instances）────────────────────────────────────
function Agents(): ReactNode {
  const defs = useLoad(() => api.listAgentDefs(), []);
  const insts = useLoad(() => api.listAgentInstances(), []);
  return (
    <>
      <Panel title="Agent definitions" onReload={defs.reload}>
        <Msg error={defs.error} loading={defs.loading} />
        <Table
          head={['name', 'runtime', 'description']}
          rows={(defs.data?.items ?? []).map((d: AgentDefinition) => [
            d.name,
            d.runtime,
            d.description,
          ])}
        />
      </Panel>
      <Panel title="Agent instances" onReload={insts.reload}>
        <Msg error={insts.error} loading={insts.loading} />
        <Table
          head={['instanceId', 'definition', 'state', 'parent']}
          rows={(insts.data?.items ?? []).map((i: AgentInstance) => [
            i.instanceId,
            i.definition,
            i.state,
            i.parent ?? '',
          ])}
        />
      </Panel>
    </>
  );
}

// ─── Tasks（TaskManager.List）────────────────────────────────────────────
function Tasks(): ReactNode {
  const tasks = useLoad(() => api.listTasks(), []);
  return (
    <Panel title="Tasks" onReload={tasks.reload}>
      <Msg error={tasks.error} loading={tasks.loading} />
      <Table
        head={['taskId', 'definition', 'state', 'createdBy']}
        rows={(tasks.data?.items ?? []).map((t: TaskInfo) => [
          t.taskId,
          t.definition,
          t.state,
          t.createdBy ?? '',
        ])}
      />
    </Panel>
  );
}

// ─── Cron（list + 创建/删除写操作，DoD ⑤ 对等的写入口）─────────────────────
function Cron(): ReactNode {
  const cron = useLoad(() => api.listCron(), []);
  const [id, setId] = useState('');
  const [schedule, setSchedule] = useState('0 9 * * *');
  const [eventType, setEventType] = useState('report.daily.tokens');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const create = async () => {
    setBusy('creating');
    setErr('');
    try {
      // publish action（最小写面）：schedule + event.type。createdBy 由平台注入。
      await api.createCron({
        id,
        description: 'created from dashboard',
        schedule,
        enabled: true,
        action: { kind: 'publish', event: { type: eventType } },
      });
      setId('');
      cron.reload();
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setBusy('');
    }
  };

  const remove = async (jobId: string) => {
    setBusy(jobId);
    setErr('');
    try {
      await api.deleteCron(jobId);
      cron.reload();
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <Panel title="Create cron job (publish)">
        {err && <p className="error">{err}</p>}
        <div className="form-row">
          <input placeholder="id" value={id} onChange={(e) => setId(e.target.value)} />
          <input
            placeholder="schedule (cron / ISO)"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
          />
          <input
            placeholder="event type"
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
          />
          <button type="button" disabled={!id || busy === 'creating'} onClick={create}>
            {busy === 'creating' ? 'Creating…' : 'Create'}
          </button>
        </div>
      </Panel>
      <Panel title="Cron jobs" onReload={cron.reload}>
        <Msg error={cron.error} loading={cron.loading} />
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>schedule</th>
              <th>action</th>
              <th>enabled</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(cron.data?.items ?? []).map((j: CronJob) => (
              <tr key={j.id}>
                <td>{j.id}</td>
                <td>{j.schedule}</td>
                <td>{j.action.kind}</td>
                <td>{j.enabled ? 'yes' : 'no'}</td>
                <td>
                  <button type="button" disabled={busy === j.id} onClick={() => remove(j.id)}>
                    {busy === j.id ? '…' : 'Delete'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

// ─── Audit（list + filter）───────────────────────────────────────────────
function Audit(): ReactNode {
  const [principal, setPrincipal] = useState('');
  const [decision, setDecision] = useState('');
  const audit = useLoad(() => {
    const filter: Record<string, string> = {};
    if (principal) filter.principal = principal;
    if (decision) filter.decision = decision;
    return api.listAudit(filter);
  }, [principal, decision]);

  return (
    <Panel title="Audit log" onReload={audit.reload}>
      <div className="form-row">
        <input
          placeholder="filter principal"
          value={principal}
          onChange={(e) => setPrincipal(e.target.value)}
        />
        <select value={decision} onChange={(e) => setDecision(e.target.value)}>
          <option value="">any decision</option>
          <option value="allow">allow</option>
          <option value="deny">deny</option>
        </select>
      </div>
      <Msg error={audit.error} loading={audit.loading} />
      <table>
        <thead>
          <tr>
            <th>at</th>
            <th>decision</th>
            <th>principal</th>
            <th>action</th>
            <th>resource</th>
          </tr>
        </thead>
        <tbody>
          {(audit.data?.items ?? []).map((r: AuditRecord) => (
            <tr key={r.id} className={r.decision === 'deny' ? 'deny' : ''}>
              <td>{r.at}</td>
              <td>{r.decision}</td>
              <td>{r.context.principal}</td>
              <td>{r.action}</td>
              <td>{r.resource}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

// ─── Settings（token + base url 手填持久化）───────────────────────────────
function Settings({ onSaved }: { onSaved: () => void }): ReactNode {
  const [token, setTok] = useState(getToken());
  const [base, setB] = useState(getBase());
  const [saved, setSaved] = useState('');

  const save = () => {
    setToken(token.trim());
    setBase(base.trim());
    setSaved('Saved.');
    onSaved();
  };

  return (
    <Panel title="Settings">
      <p className="muted">
        Paste a Watt user token (from <code>watt login</code> or <code>watt --json login</code>).
        Base URL empty = same origin.
      </p>
      <div className="form-col">
        <label>
          API base URL
          <input placeholder="(same origin)" value={base} onChange={(e) => setB(e.target.value)} />
        </label>
        <label>
          Token
          <textarea
            placeholder="Bearer token"
            value={token}
            onChange={(e) => setTok(e.target.value)}
            rows={3}
          />
        </label>
        <button type="button" onClick={save}>
          Save
        </button>
        {saved && <span className="muted">{saved}</span>}
      </div>
    </Panel>
  );
}
