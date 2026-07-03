/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { isAllowedDashboardOrigin } from '../src/index.ts';

/**
 * CORS 中间件测试（M10 Dashboard）——浏览器 SPA 跨源调 /htbp/* 的放行 + 预检。
 * isAllowedDashboardOrigin 纯判定单测 + OPTIONS 预检真实穿透（SELF.fetch）。
 * 安全边界：带 Authorization 的凭据请求不能 `*`——只回显白名单命中的精确 origin。
 */

describe('isAllowedDashboardOrigin', () => {
  it('allows *.pages.dev by default', () => {
    expect(isAllowedDashboardOrigin('https://watt-dashboard.pages.dev')).toBe(true);
    expect(isAllowedDashboardOrigin('https://x.pages.dev')).toBe(true);
  });
  it('allows localhost / 127.0.0.1 (dev)', () => {
    expect(isAllowedDashboardOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedDashboardOrigin('http://127.0.0.1:8080')).toBe(true);
  });
  it('allows configured explicit origins', () => {
    expect(
      isAllowedDashboardOrigin(
        'https://dash.example.com',
        'https://a.com, https://dash.example.com',
      ),
    ).toBe(true);
  });
  it('rejects unknown origins', () => {
    expect(isAllowedDashboardOrigin('https://evil.example.com')).toBe(false);
    expect(isAllowedDashboardOrigin('https://pages.dev.evil.com')).toBe(false);
  });
  it('rejects malformed origin', () => {
    expect(isAllowedDashboardOrigin('not-a-url')).toBe(false);
  });
});

describe('CORS preflight on /htbp/*', () => {
  it('OPTIONS from *.pages.dev → 2xx/204 with allow headers', async () => {
    const res = await SELF.fetch('https://gateway.test/htbp/platform/plugin', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://watt-dashboard.pages.dev',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization,Content-Type',
      },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://watt-dashboard.pages.dev');
  });

  it('OPTIONS from disallowed origin → no allow-origin echo', async () => {
    const res = await SELF.fetch('https://gateway.test/htbp/platform/plugin', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example.com',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.example.com');
  });
});
