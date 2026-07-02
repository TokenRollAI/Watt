/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

/**
 * 测试前建表：把 migrations/ 的 SQL（config 读入 → TEST_MIGRATIONS 绑定）应用到 DB_POLICIES。
 * applyD1Migrations 幂等（跟踪 d1_migrations 表），可安全在每个测试文件 setup 重复调用。
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB_POLICIES, env.TEST_MIGRATIONS);
});
