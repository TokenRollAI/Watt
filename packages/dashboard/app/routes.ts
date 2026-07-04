import { index, layout, type RouteConfig, route } from '@react-router/dev/routes';

// 路由全集在骨架期一次性预置（各视图族 worker 只填充对应 routes/*.tsx，不改本文件）。
export default [
  route('login', 'routes/login.tsx'),
  layout('layout.tsx', [
    index('routes/overview.tsx'),
    route('metrics', 'routes/metrics.tsx'),
    route('agents', 'routes/agents.tsx'),
    route('manage', 'routes/manage.tsx'),
    route('tasks', 'routes/tasks.tsx'),
    route('cron', 'routes/cron.tsx'),
    route('events', 'routes/events.tsx'),
    route('context', 'routes/context.tsx'),
    route('tools', 'routes/tools.tsx'),
    route('policies', 'routes/policies.tsx'),
    route('audit', 'routes/audit.tsx'),
    route('providers', 'routes/providers.tsx'),
    route('channels', 'routes/channels.tsx'),
    route('plugins', 'routes/plugins.tsx'),
    route('secrets', 'routes/secrets.tsx'),
    route('settings', 'routes/settings.tsx'),
  ]),
] satisfies RouteConfig;
