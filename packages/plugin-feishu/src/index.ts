/**
 * watt-plugin-feishu Worker 入口（wrangler main）——生产 wiring：createFeishuWorker(env) 单例。
 * 默认导出 ExportedHandler.fetch。所有渠道逻辑/凭据在本 Worker 侧闭环（Plugin.md 能力边界）。
 */

import { createFeishuWorker, type FeishuWorkerEnv } from './worker.ts';

let worker: ReturnType<typeof createFeishuWorker> | null = null;

export default {
  async fetch(request: Request, env: FeishuWorkerEnv): Promise<Response> {
    if (worker === null) worker = createFeishuWorker({ env });
    return worker.fetch(request);
  },
};
