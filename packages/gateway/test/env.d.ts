/// <reference types="@cloudflare/vitest-pool-workers/types" />
// 测试环境的绑定类型（Cloudflare.Env）——vitest-pool-workers 的 `env`。
// 运行时资源绑定见 src/env.ts 的 Bindings；TEST_* 经 miniflare.bindings 注入（vitest.config.ts）。

import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { Bindings } from '../src/env.ts';

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      WATT_JWT_PRIVATE_JWK: string;
      WATT_ADMIN_PRINCIPAL: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
