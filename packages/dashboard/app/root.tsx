import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './app.css';

import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from 'react-router';
import { Toaster } from '~/components/ui/sonner';

// 首帧前应用主题（默认 dark——控制台形态），避免 FOUC；切换见 layout 的 ThemeToggle。
const THEME_BOOT = `(function(){try{var t=localStorage.getItem('watt.theme');if(t==='light'){document.documentElement.classList.remove('dark')}else{document.documentElement.classList.add('dark')}}catch(e){document.documentElement.classList.add('dark')}})();`;

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Watt Console</title>
        <Meta />
        <Links />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: 主题引导脚本为本文件内静态常量。 */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        {children}
        <Toaster position="top-right" richColors />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/** SPA 首次加载 JS 期间的骨架屏（替代 RR7 默认 console 提示）。 */
export function HydrateFallback() {
  return (
    <main className="flex min-h-svh items-center justify-center">
      <p className="section-label animate-pulse">watt console loading…</p>
    </main>
  );
}

export function ErrorBoundary({ error }: { error: unknown }) {
  let title = 'Unexpected error';
  let detail = '页面渲染出错。';
  if (isRouteErrorResponse(error)) {
    title = `${error.status} ${error.statusText}`;
    detail = error.status === 404 ? '页面不存在。' : detail;
  } else if (error instanceof Error) {
    detail = error.message;
  }
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-2 p-8">
      <p className="section-label">watt console</p>
      <h1 className="font-mono text-2xl">{title}</h1>
      <p className="text-muted-foreground text-sm">{detail}</p>
    </main>
  );
}
