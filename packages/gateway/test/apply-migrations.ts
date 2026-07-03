/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

/**
 * 测试前建表：把 migrations 的 SQL（config 读入 → TEST_MIGRATIONS* 绑定）应用到对应 D1 库。
 * applyD1Migrations 幂等（跟踪 d1_migrations 表），可安全在每个测试文件 setup 重复调用。
 *  - DB_POLICIES ← migrations/（Auth 内核，Proto §6.2/§6.3）
 *  - DB_EVENTS   ← migrations-events/（Event Gateway，Proto §2.4/§2.2）
 *  - DB_CONTEXT  ← migrations-context/（Context Layer structured provider，Proto §4.1）
 *  - DB_PROVIDERS ← migrations-providers/（Tool Layer ToolRegistry，Proto §5.2）
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB_POLICIES, env.TEST_MIGRATIONS);
  await applyD1Migrations(env.DB_EVENTS, env.TEST_MIGRATIONS_EVENTS);
  await applyD1Migrations(env.DB_CONTEXT, env.TEST_MIGRATIONS_CONTEXT);
  await applyD1Migrations(env.DB_PROVIDERS, env.TEST_MIGRATIONS_PROVIDERS);
});
