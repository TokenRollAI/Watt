import { defineConfig } from 'vitest/config';

// @watt/plugin-feishu — 飞书 channel-adapter plugin。纯逻辑（adapter/verify·crypto·decode·encode·send）
// 与 worker 宿主分层。纯逻辑无 Cloudflare 绑定，用 Web Crypto（Node 20+ globalThis.crypto.subtle）；
// worker 宿主经 createFeishuWorker(deps) 工厂注入 verifyPlatformToken/fetch/now，测试用 fake 断言。
// 在默认 Node pool 跑（非 workerd）：快、无需 wrangler/pool-workers 接线。
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
