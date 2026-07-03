import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Watt Dashboard（M10）：静态 React SPA，构建产物 dist/ 部署到 Cloudflare Pages（watt-dashboard）。
// base '/' 同源部署；API base URL 运行时可配（默认同源 /htbp，见 src/api.ts）。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    // 单页 SPA，无需 legacy chunking 调优（最小面）。
    target: 'es2022',
  },
});
