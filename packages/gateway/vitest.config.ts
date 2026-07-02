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

export default defineConfig({
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          WATT_JWT_PRIVATE_JWK: JSON.stringify(testKey.privateJwk),
          WATT_ADMIN_PRINCIPAL: testKey.adminPrincipal,
          TEST_MIGRATIONS: migrations,
          TEST_MIGRATIONS_EVENTS: migrationsEvents,
        },
      },
    }),
  ],
});
