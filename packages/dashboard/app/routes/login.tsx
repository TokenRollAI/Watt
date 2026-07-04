import { Zap } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs';
import { getBase, rootExchange, setBase, setToken, whoami } from '~/lib/api';

/**
 * 登录页：两种凭据路径（与旧 dashboard Settings 等价）——
 * ① Root Key 换发 7d admin token（POST /oauth/root/token，§6.5e）；
 * ② 直接粘贴 `watt login` 得到的 user token。
 * base URL 可选（默认同源；开发期可指向 workers.dev）。
 */
export default function Login() {
  const navigate = useNavigate();
  const [base, setBaseInput] = useState(getBase());
  const [rootKey, setRootKey] = useState('');
  const [token, setTokenInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finishLogin(tok: string) {
    setToken(tok);
    // whoami 验证 token 可用后才放行进控制台（无效 token 立即暴露而非首屏各卡片齐红）。
    await whoami();
    navigate('/');
  }

  async function submitRoot() {
    setBusy(true);
    setError(null);
    try {
      setBase(base);
      const tok = await rootExchange(rootKey.trim(), 7 * 24 * 3600);
      setRootKey('');
      await finishLogin(tok);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitToken() {
    setBusy(true);
    setError(null);
    try {
      setBase(base);
      await finishLogin(token.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="bg-grid flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3">
          <span className="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-lg shadow-[0_0_24px_-4px_var(--primary)]">
            <Zap className="size-6" />
          </span>
          <div className="text-center leading-tight">
            <h1 className="font-mono text-2xl font-semibold tracking-tight">WATT</h1>
            <p className="section-label">platform console</p>
          </div>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">接入 Gateway</CardTitle>
            <CardDescription>
              Root Key 换发 7 天 admin token，或直接粘贴已有 token。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="base">Gateway Base URL（留空=同源）</Label>
              <Input
                id="base"
                className="font-mono"
                placeholder="https://watt-gateway.example.workers.dev"
                value={base}
                onChange={(e) => setBaseInput(e.target.value)}
              />
            </div>
            <Tabs defaultValue="root">
              <TabsList className="w-full">
                <TabsTrigger value="root" className="flex-1">
                  Root Key
                </TabsTrigger>
                <TabsTrigger value="token" className="flex-1">
                  Token
                </TabsTrigger>
              </TabsList>
              <TabsContent value="root" className="space-y-3 pt-2">
                <div className="space-y-2">
                  <Label htmlFor="rootKey">Root Key</Label>
                  <Input
                    id="rootKey"
                    type="password"
                    className="font-mono"
                    autoComplete="off"
                    value={rootKey}
                    onChange={(e) => setRootKey(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && rootKey && void submitRoot()}
                  />
                </div>
                <Button className="w-full" disabled={busy || !rootKey.trim()} onClick={submitRoot}>
                  {busy ? '换发中…' : '换发并登录'}
                </Button>
              </TabsContent>
              <TabsContent value="token" className="space-y-3 pt-2">
                <div className="space-y-2">
                  <Label htmlFor="token">Watt Token</Label>
                  <Input
                    id="token"
                    type="password"
                    className="font-mono"
                    autoComplete="off"
                    placeholder="watt login 输出的 token"
                    value={token}
                    onChange={(e) => setTokenInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && token && void submitToken()}
                  />
                </div>
                <Button className="w-full" disabled={busy || !token.trim()} onClick={submitToken}>
                  {busy ? '验证中…' : '登录'}
                </Button>
              </TabsContent>
            </Tabs>
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
          </CardContent>
        </Card>
        <p className="text-muted-foreground text-center text-xs">
          token 仅存于浏览器 localStorage，请求直达你的 gateway。
        </p>
      </div>
    </main>
  );
}
