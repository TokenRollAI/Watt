import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// vitest-pool-workers 0.18.0 (vitest 4)：Vite 插件形式，在真实 workerd 里跑测试（DOD §1）。
// 复用 wrangler.jsonc 的 Worker 配置；额外注入：
//  - 测试用 WATT_JWT_PRIVATE_JWK / WATT_ADMIN_PRINCIPAL（专用测试密钥，不与生产共用）；
//  - D1 migrations（读 migrations/ 目录，setup 里 applyD1Migrations 建表）。

const here = dirname(fileURLToPath(import.meta.url));

// 测试私钥 fixture（与 test/fixtures/test-key.ts 同源；此处读文件避免 config↔worker 双份维护）。
const testKeyPath = resolve(here, 'test/fixtures/test-key.json');
const testKey = JSON.parse(readFileSync(testKeyPath, 'utf8')) as {
  privateJwk: unknown;
  adminPrincipal: string;
};

const migrations = await readD1Migrations(resolve(here, 'migrations'));
const migrationsEvents = await readD1Migrations(resolve(here, 'migrations-events'));
const migrationsContext = await readD1Migrations(resolve(here, 'migrations-context'));
const migrationsProviders = await readD1Migrations(resolve(here, 'migrations-providers'));

export default defineConfig({
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
  plugins: [
    cloudflareTest({
      // remoteBindings:false —— 禁用 vitest-pool-workers 的远程代理会话。默认 true 会为无本地
      // 模拟器的绑定（Workers AI）起远程代理，触发多账户非交互选择失败。vector provider 走依赖
      // 注入 fake（测试从不读 env.AI），故本地测试无需远程 AI；Vectorize 仅 WARNING（toolchain §10）。
      remoteBindings: false,
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // DB_CONTEXT（M3 structured provider）本地 D1：wrangler.jsonc 的 D1 marker 段由
        // provision 生成、尚未含 DB_CONTEXT（避免占位 database_id 破坏部署）。测试侧用
        // miniflare.d1Databases 直接注入本地 SQLite（id 任意值，本地不连远端）——本库测试
        // 因此不依赖 wrangler.jsonc D1 绑定。部署前 team-lead 跑 provision 回填真实绑定。
        d1Databases: { DB_CONTEXT: 'watt-context-local' },
        bindings: {
          WATT_JWT_PRIVATE_JWK: JSON.stringify(testKey.privateJwk),
          WATT_ADMIN_PRINCIPAL: testKey.adminPrincipal,
          TEST_MIGRATIONS: migrations,
          TEST_MIGRATIONS_EVENTS: migrationsEvents,
          TEST_MIGRATIONS_CONTEXT: migrationsContext,
          TEST_MIGRATIONS_PROVIDERS: migrationsProviders,
          // webhook adapter 验签 secret（inbound 集成测试；channel settings.verifySecretRef 指向此名）。
          WEBHOOK_SECRET_TEST: 'integration-webhook-secret',
        },
      },
    }),
  ],
});
