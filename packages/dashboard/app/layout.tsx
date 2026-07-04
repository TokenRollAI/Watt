import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Outlet, redirect, useLocation, useNavigate } from 'react-router';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '~/components/ui/sidebar';
import { clearToken, getBase, getToken, whoami } from '~/lib/api';
import { NAV_GROUPS } from '~/lib/nav';

/** 认证门卫：无 token 一律去 /login（SPA clientLoader，每次导航校验）。 */
export function clientLoader() {
  if (!getToken()) throw redirect('/login');
  return null;
}

function ThemeToggle() {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
  }, []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('watt.theme', next ? 'dark' : 'light');
  };
  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label="切换主题">
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

function PrincipalMenu() {
  const navigate = useNavigate();
  const [principal, setPrincipal] = useState<string | null>(null);
  useEffect(() => {
    whoami()
      .then((w) => setPrincipal(w.principal))
      .catch(() => setPrincipal(null));
  }, []);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="font-mono text-xs">
          <span className="led text-success mr-1" />
          {principal ?? 'unauthenticated'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="font-mono text-xs">
          {getBase() || '同源 gateway'}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/settings')}>连接设置</DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            clearToken();
            navigate('/login');
          }}
        >
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function AppLayout() {
  const location = useLocation();
  return (
    <SidebarProvider>
      <Sidebar variant="inset">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1.5">
            {/* 透明底线条 logo，随应用主题切黑/白线（.dark class）。 */}
            <span className="flex size-7 items-center justify-center">
              <img src="/logo-dark-on-light.png" alt="Watt" className="size-6 dark:hidden" />
              <img src="/logo-light-on-dark.png" alt="Watt" className="hidden size-6 dark:block" />
            </span>
            <div className="leading-none">
              <p className="font-mono text-sm font-semibold tracking-tight">WATT</p>
              <p className="text-sidebar-foreground/60 text-[10px] uppercase tracking-[0.18em]">
                console
              </p>
            </div>
          </div>
        </SidebarHeader>
        <SidebarContent>
          {NAV_GROUPS.map((group) => (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel className="uppercase tracking-[0.14em]">
                {group.label}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.url}>
                      <SidebarMenuButton asChild isActive={location.pathname === item.url}>
                        <Link to={item.url}>
                          <item.icon />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter>
          <Badge variant="outline" className="text-muted-foreground w-fit font-mono text-[10px]">
            M10 · platform console
          </Badge>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b px-4">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <PrincipalMenu />
          </div>
        </header>
        <main className="bg-grid min-h-0 flex-1 overflow-auto">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
            <Outlet />
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
