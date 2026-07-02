# 工具链安装与测试配置的坑

> 适用场景：在本机安装依赖、配置 vitest-pool-workers 测试、调整 TS 工程、跑 wrangler provision/deploy 时。§1~5 为 Round 1（Phase 0 骨架）、§6~11 为 Round 2（资源 provision + 部署）、§12~14 为 Round 3（Phase 0 关门）、§15~20 为 Round 4~6（Phase 1 Auth）、§21~25 为 Round 7（Phase 1 关门）实测踩坑与已验证解法。

## 1. 大二进制下载超时（npm registry）

- 现象：`@cloudflare/workerd-darwin-arm64`（约 32MB）经默认 npm registry 在本机反复 `UND_ERR_SOCKET` 超时。
- 解法：`pnpm install --registry https://registry.npmmirror.com`。

## 2. pnpm 11.9 的 build 门禁

- workerd / esbuild / sharp 的 postinstall 需在 `pnpm-workspace.yaml` **同时**配置 `onlyBuiltDependencies` + `allowBuilds`。
- 缺一则报 `ERR_PNPM_IGNORED_BUILDS`，workerd 二进制不落地（症状：wrangler/测试起不来）。

## 3. vitest-pool-workers 0.18（Vitest 4 时代）的新 API

- 旧写法已移除：`defineWorkersConfig`（from `@cloudflare/vitest-pool-workers/config`）。
- 新写法：

  ```ts
  import { defineConfig } from 'vitest/config';
  import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

  export default defineConfig({
    plugins: [cloudflareTest({ wrangler: { configPath } })],
  });
  ```

- 类型引用：`/// <reference types="@cloudflare/vitest-pool-workers/types" />`。
- 版本锚点：wrangler 锁 4.107.0 devDependency，对齐 vitest-pool-workers 0.18 捆绑版本（见 [../must/current-state.md](../must/current-state.md)）。

## 4. TS 工程决策：noEmit + `.ts` 扩展名导入

- **不用** `tsc -b` / composite——与 `.ts` 扩展名导入冲突。
- 采用：全局 `noEmit` + `allowImportingTsExtensions`；每包类型检查跑 `tsc --noEmit`；Node 26 原生 strip types 直接执行 `.ts`。
- 坑：残留的 `dist/*.test.js` 会被 vitest 误抓——`dist/` 必须 gitignore 且不留旧产物。

## 5. Cloudflare 凭据验证

- 只用 `wrangler whoami`；`/user/tokens/verify` 对 Account-scoped token 必然误报。详见 [../must/current-state.md](../must/current-state.md) 凭据一节（此处仅交叉引用，不重复）。

## 6. wrangler 配 `routes` 后 workers.dev 默认关闭

- 现象：wrangler.jsonc 加了 `routes`（custom domain）后再 deploy，workers.dev 子域返回 404。
- 原因：配置 `routes` 时 wrangler 默认把 workers.dev 子域关掉。
- 解法：显式加 `"workers_dev": true` 保双 URL（custom domain + workers.dev 并存）。

## 7. wrangler env-token 模式的 stdout 污染与 `--json` 支持不齐

- env-token 模式（`CLOUDFLARE_API_TOKEN` 环境变量）下，**每条命令的 stdout 都会先打一段 whoami banner**，直接污染 `--json` 输出——不能天真 `JSON.parse(stdout)`。
- 且 `--json` 支持不齐：`d1 list` / `kv namespace list` / `vectorize list` 支持；**`queues list` / `r2 bucket list` 不支持**。
- 脚本判断资源是否存在的稳妥做法：对 list 输出做**资源名 substring 匹配**（`scripts/provision.mjs` 即此方案）。

## 8. JSONC 注入陷阱（wrangler.jsonc 回填）

- 现象：向末尾带行注释的 wrangler.jsonc 追加属性后，wrangler 的 JSONC parser 报 `CommaExpected`。
- 原因：逗号被补在了注释之后。逗号必须补在**最后一个真实 JSON token 后**（注释之前/之外），不能跟在行注释后面。
- 隐蔽点：**爆点在 test 阶段而非 typecheck**（vitest-pool-workers 加载 wrangler 配置时才解析），typecheck 全绿也可能带着坏配置。

## 9. 新部署 Worker 的边缘传播窗口

- 现象：`wrangler deploy` 成功后立即 curl，首击可能 500 `error code: 1104`。
- Round 7 补充：deploy 后**首批 curl 还可能命中旧 isolate**（观测到 404 纯文本 / 旧版本 body）——验证新行为前等几秒或重测一次，勿凭首击结果下结论。
- 解法：验证脚本必须带重试（`scripts/smoke.ts` 已内置 5 次重试）。

## 10. Vectorize 绑定在本地测试环境

- vitest-pool-workers / miniflare 对 Vectorize 绑定只打 WARNING，不报错。
- 本地测试**无需**从 wrangler.jsonc 注释掉 Vectorize 绑定。

## 11. 本机网络：ISP DNS 污染 `watt.pdjjq.org`

- 现象：本机解析 `watt.pdjjq.org` 得到假 IP → TLS reset；CF 边缘本身正常（非平台问题）。
- workaround：本机验证/E2E 用 workers.dev URL（`watt-gateway.shuaiqijianhao.workers.dev`），或 curl 加 `--doh-url https://1.1.1.1/dns-query`。

## 12. Biome 强制单行 import

- Biome formatter 会把 import 语句压成单行；手工拆成多行会在 `pnpm verify`（lint 阶段）fail。
- 写代码时直接保持单行 import，或改完跑一次 `biome format --write` 再 verify。

## 13. `scripts/lib/*.mjs` 在 typecheck 范围外

- `scripts/tsconfig.json` 只 `include: ["smoke.ts"]`（且 `checkJs: false`），`scripts/lib/*.mjs` 不进 typecheck。
- 后果：`.mjs` 脚本库的类型错误 verify 抓不到。
- 约定：新脚本库保持 `.mjs`（接受无类型检查），或者写 `.ts` 时**必须**主动加进 `scripts/tsconfig.json` 的 include。

## 14. provision 幂等的金标准检查

- 金标准 = **重跑 `pnpm provision` 后 `wrangler.jsonc` 字节级一致**（跑前跑后 MD5 对比）。
- 仅看输出全 [exists] 不够——回填逻辑仍可能重写 marker 段造成 diff/绑定漂移；MD5 一致才证明真正幂等。
- 关联坑：给某类绑定加 per-binding 新字段（如 D1 的 `migrations_dir`）时，必须同步改 provision 的 bindingsBlock 生成逻辑，否则重跑会把新字段抹掉（MD5 检查即为此设）。

## 15. 块注释内的 `*/` 字面提前闭合（oxc PARSE_ERROR）

- 现象：在 `/* ... */` 块注释里写含 `*/` 的字面文本（如描述通配符 `agent_*/chain`），注释提前闭合 → oxc 报 PARSE_ERROR，**且报错行号定位到别处，极具误导性**。
- 解法：块注释内避免 `*/` 序列（改写为 `agent_* / chain` 或用行注释 `//`）。遇到定位不明的 PARSE_ERROR，先全文搜块注释里的 `*/`。

## 16. vitest-pool-workers 跑 D1 migrations 的接线三件套

缺一即测试里 D1 无表（`no such table`）：

1. vitest config 顶层 `await readD1Migrations(migrationsDir)` 读出 migrations；
2. 经 `miniflare.bindings`（如 `TEST_MIGRATIONS`）注入测试环境；
3. 测试 setup 里 `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`；
4. 另需 `declare global { interface Cloudflare { Env: ... } }`（或对应 Env 声明）让 `env.TEST_MIGRATIONS` 过 typecheck。

## 17. coverage 产物污染 lint

- `coverage/` 目录不 gitignore 且不在 biome 排除里，会被 lint 抓到爆上百错。
- 解法：`.gitignore` 加 `coverage/`，且 biome 配置 `files.ignore`（或等效排除）同步加。

## 18. `pnpm --filter X test -- --coverage` 不透传

- `--coverage` 经 pnpm `--` 透传到 vitest 会丢失，静默不生效。
- 解法：把 `--coverage`（及覆盖率门禁）直接写进该包 package.json 的 `test` 脚本，不靠命令行透传。

## 19. 脚本 stdout 纯净化模式（供 `$()` 捕获）

- 场景：脚本输出会被 shell `$()` 或管道捕获时（如 `sign-admin-token.mjs` 输出 token），任何子进程/日志混入 stdout 都会污染捕获值。
- 模式：脚本内所有子进程（`wrangler` 等）的 stdout 显式重定向到 stderr（`stdio: ['ignore','inherit'→2,'inherit']` 或 pipe 后写 `process.stderr`），日志一律 `console.error`；**只有最终目标值走 stdout**。

## 20. `wrangler secret put` 后的传播窗口

- secret put 成功返回后，边缘约有 ~15s 传播窗口，期间线上仍用旧值（或无值）。
- 验证脚本在 put 后 `sleep 15`（或重试探测）再断言，否则假失败。

## 21. pnpm `--filter` 以 package.json name 为准，且空匹配 exit 0

- 包名以各包 `package.json` 的 `name` 字段为准，不是目录名：CLI 包是 **`watt-cli`** 不是 `@watt/cli`。
- 更危险的是：**filter 匹配不到任何包时 exit 0**，命令"成功"但什么都没跑——测试假通过。
- 派任务 / 写脚本前先核对包名（`pnpm ls -r --depth -1`）。

## 22. 本机验证脚本的 base_url 缺省

- 本机 fetch 线上的验证脚本，base_url 缺省应取 workers.dev（`watt-gateway.shuaiqijianhao.workers.dev`），留环境变量覆盖（如 `WATT_JWKS_BASE_URL`）。
- **勿直接复用 `.env` 的 `WATT_BASE_URL`**——它指向被本机 DNS 污染的 `watt.pdjjq.org`（见 §11），脚本会假失败。

## 23. vitest-pool-workers 同一测试文件内共享 isolate

- 同一个 test 文件的所有用例跑在同一个 workerd isolate 里：**模块级单例（如 seed 的 once-guard Promise）跨用例存活**。
- 后果：凡是 beforeEach 里 clearDb 的测试文件，种子引导会被 once-guard 短路，后续用例的种子/授权失真。
- 解法：clearDb 的同时 reset 单例（gateway 导出 `resetSeedGuardForTests` 即为此设）。

## 24. Hono matcher 在首个请求后锁定

- Hono app 处理过第一个请求后 route matcher 即构建锁定，之后再 `app.get()` 追加路由会报 **"matcher already built"**。
- 测试里要动态挂路由的，必须在任何 fetch 之前于模块顶层注册。

## 25. 认证中间件先于 notFound 执行（501 占位的注册位置）

- notFound 兜底在中间件链末端：若规范树 501 占位靠 notFound 判前缀实现，请求会先被认证中间件拦成 401。
- §11.3a 语义要求 501 优先于 401——占位路由必须**显式注册在认证中间件之前**（gateway `index.ts` 即此做法）。
