import { defineConfig } from 'vitest/config';

// @watt/core = 平台核心纯逻辑（判定算法 + Event 信封），无 Cloudflare 绑定。
// 在默认 Node pool 跑（非 workerd）：快、可开覆盖率门禁。
// DOD §1 要求纯逻辑 100% 分支覆盖——对判定/信封模块设 100% branch/function/line/statement 阈值。
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // 只统计被测的纯逻辑源文件；类型/schema/桶文件按需纳入。
      include: [
        'src/authz/**/*.ts',
        'src/context/**/*.ts',
        'src/event/**/*.ts',
        'src/eventbus/**/*.ts',
        'src/auth/**/*.ts',
        'src/agent/**/*.ts',
      ],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
  },
});
