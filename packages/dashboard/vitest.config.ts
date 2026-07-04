import { defineConfig } from 'vitest/config';

// 测试不加载 reactRouter() 插件（其 dev/build 钩子与 vitest 冲突）；api 契约测试为纯 node 环境
// mock fetch，无需 DOM。vitest 优先读本文件而非 vite.config.ts。
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: 'node',
    include: ['app/**/*.test.ts'],
  },
});
