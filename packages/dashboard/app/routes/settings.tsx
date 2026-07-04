import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ErrorState, PageHeader, StatusDot } from '~/components/page';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs';
import { Textarea } from '~/components/ui/textarea';
import {
  formatError,
  getBase,
  rootExchange,
  setBase,
  setToken,
  whoami as whoamiApi,
} from '~/lib/api';

/**
 * Settings——连接信息 + whoami + token 更换（粘贴新 token / Root Key 换发）+ 主题偏好说明。
 * 旧 dashboard Settings 的等价功能全保留（base URL 展示修改 / Root Key 登录 / token 手填）。
 * 登出在 layout PrincipalMenu 已有，此处不重复。
 */
export default function SettingsView() {
  return (
    <>
      <PageHeader title="Settings" description="连接凭据与偏好。token 仅存浏览器 localStorage。" />
      <div className="grid gap-6 lg:grid-cols-2">
        <ConnectionCard />
        <IdentityCard />
      </div>
      <CredentialCard />
      <ThemeCard />
    </>
  );
}

/** Gateway Base URL 展示与修改。 */
function ConnectionCard() {
  const [base, setBaseInput] = useState(getBase());
  const [busy, setBusy] = useState(false);

  function save() {
    setBusy(true);
    setBase(base.trim());
    setBaseInput(getBase());
    toast.success('Base URL 已保存');
    setBusy(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">连接</CardTitle>
        <CardDescription>
          Gateway Base URL（留空 = 同源）。修改后立即作用于后续请求。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="set-base">Base URL</Label>
          <Input
            id="set-base"
            className="font-mono"
            placeholder="https://watt-gateway.example.workers.dev"
            value={base}
            onChange={(e) => setBaseInput(e.target.value)}
          />
        </div>
        <Button size="sm" onClick={save} disabled={busy}>
          保存 Base URL
        </Button>
      </CardContent>
    </Card>
  );
}

/** whoami——当前 principal + roles。 */
function IdentityCard() {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ok'; principal: string; roles: string[] }
    | { status: 'error'; message: string }
  >({ status: 'loading' });

  function load() {
    setState({ status: 'loading' });
    whoamiApi()
      .then((w) => setState({ status: 'ok', principal: w.principal, roles: w.roles }))
      .catch((e: unknown) => setState({ status: 'error', message: formatError(e) }));
  }

  useEffect(load, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">身份</CardTitle>
        <CardDescription>当前 token 解析出的 principal 与 roles（whoami）。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {state.status === 'loading' ? (
          <p className="text-muted-foreground">加载中…</p>
        ) : state.status === 'error' ? (
          <ErrorState error={state.message} onRetry={load} />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="section-label">principal</span>
              <StatusDot tone="success" label={state.principal} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="section-label">roles</span>
              {state.roles.length === 0 ? (
                <span className="text-muted-foreground">（无）</span>
              ) : (
                state.roles.map((r) => (
                  <Badge key={r} variant="outline" className="font-mono text-xs">
                    {r}
                  </Badge>
                ))
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** token 更换：Root Key 换发 7d admin token / 直接粘贴 token。 */
function CredentialCard() {
  const [rootKey, setRootKey] = useState('');
  const [token, setTokenInput] = useState('');
  const [busy, setBusy] = useState(false);

  async function submitRoot() {
    setBusy(true);
    try {
      const tok = await rootExchange(rootKey.trim(), 7 * 24 * 3600);
      setToken(tok);
      setRootKey('');
      // whoami 验证换发的 token 可用（无效立即暴露）。
      await whoamiApi();
      toast.success('已换发 7 天 admin token 并生效');
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitToken() {
    setBusy(true);
    try {
      setToken(token.trim());
      setTokenInput('');
      await whoamiApi();
      toast.success('token 已更换并生效');
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">凭据</CardTitle>
        <CardDescription>
          用 Root Key 换发 7 天 admin token，或直接粘贴 <code>watt login</code> 得到的
          token。明文不落存储。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="root">
          <TabsList>
            <TabsTrigger value="root">Root Key</TabsTrigger>
            <TabsTrigger value="token">Token</TabsTrigger>
          </TabsList>
          <TabsContent value="root" className="space-y-3 pt-3">
            <div className="space-y-2">
              <Label htmlFor="set-rootkey">Root Key（换发 7 天 admin token）</Label>
              <Input
                id="set-rootkey"
                type="password"
                className="font-mono"
                autoComplete="off"
                placeholder="wrk_..."
                value={rootKey}
                onChange={(e) => setRootKey(e.target.value)}
              />
            </div>
            <Button size="sm" onClick={submitRoot} disabled={busy || !rootKey.trim()}>
              {busy ? '换发中…' : '换发并生效'}
            </Button>
          </TabsContent>
          <TabsContent value="token" className="space-y-3 pt-3">
            <div className="space-y-2">
              <Label htmlFor="set-token">Watt Token</Label>
              <Textarea
                id="set-token"
                className="font-mono text-xs"
                rows={3}
                autoComplete="off"
                placeholder="Bearer token（watt login 输出）"
                value={token}
                onChange={(e) => setTokenInput(e.target.value)}
              />
            </div>
            <Button size="sm" onClick={submitToken} disabled={busy || !token.trim()}>
              {busy ? '验证中…' : '更换 token'}
            </Button>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

/** 主题偏好说明（主题切换在顶栏，偏好持久化到 localStorage `watt.theme`）。 */
function ThemeCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">偏好</CardTitle>
        <CardDescription>主题</CardDescription>
      </CardHeader>
      <CardContent className="text-muted-foreground text-sm">
        明暗主题由顶栏右上角的切换按钮控制，偏好保存在浏览器 localStorage（<code>watt.theme</code>
        ），默认暗色（电力控制台风格）。
      </CardContent>
    </Card>
  );
}
