import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// 构建产物为纯静态 SPA（react-router.config.ts ssr:false），经 package.json build 落 dist/，
// 由 gateway assets 同域托管（run_worker_first 优先 API 路径）。测试配置独立见 vitest.config.ts。
export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
  build: {
    target: 'es2022',
  },
});
