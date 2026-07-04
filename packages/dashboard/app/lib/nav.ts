import {
  Activity,
  Bot,
  Boxes,
  Cpu,
  Database,
  FolderTree,
  Gauge,
  KeyRound,
  ListChecks,
  MessageSquareText,
  Radio,
  ScrollText,
  Settings,
  ShieldCheck,
  Timer,
  Wrench,
} from 'lucide-react';

export interface NavItem {
  title: string;
  url: string;
  icon: typeof Gauge;
}
export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** 侧边导航全集——条目≈CLI 命令族（M10 三对等入口之一），骨架期一次性预置。 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Observe',
    items: [
      { title: 'Overview', url: '/', icon: Gauge },
      { title: 'Metrics', url: '/metrics', icon: Activity },
      { title: 'Events', url: '/events', icon: Radio },
      { title: 'Audit', url: '/audit', icon: ScrollText },
    ],
  },
  {
    label: 'Runtime',
    items: [
      { title: 'Agents', url: '/agents', icon: Bot },
      { title: 'Manage Chat', url: '/manage', icon: MessageSquareText },
      { title: 'Tasks', url: '/tasks', icon: ListChecks },
      { title: 'Cron', url: '/cron', icon: Timer },
    ],
  },
  {
    label: 'Resources',
    items: [
      { title: 'Context', url: '/context', icon: FolderTree },
      { title: 'Tools', url: '/tools', icon: Wrench },
    ],
  },
  {
    label: 'Governance',
    items: [{ title: 'Policies', url: '/policies', icon: ShieldCheck }],
  },
  {
    label: 'Platform',
    items: [
      { title: 'Providers', url: '/providers', icon: Cpu },
      { title: 'Channels', url: '/channels', icon: Database },
      { title: 'Plugins', url: '/plugins', icon: Boxes },
      { title: 'Secrets', url: '/secrets', icon: KeyRound },
      { title: 'Settings', url: '/settings', icon: Settings },
    ],
  },
];
