# watt-toolbridge

Phase 4 Tool Gateway 的部署单元（Cloudflare Worker `watt-toolbridge`）。它是整棵 HTBP 工具树的宿主：
Watt gateway 经 **service binding** `TOOLBRIDGE` 把 `/htbp/tools/*` 代理到这里（认证 + Check PEP +
错误形状转换 + 可见性裁剪都在 gateway 代理层 `packages/gateway/src/http/tools-proxy.ts`，本 Worker 只做
树解析 / `~help` / 调用 / 虚拟化 / 租户隔离）。

## 为什么 vendored 而非依赖引用

`vendor/` 是 `TokenRollAI/tool-bridge`（私有仓库，分支 `feat/watt-builtin-and-tool-semantics`，
commit `56ab13b`）的 **worker 源码**（`src/worker/`）拷贝。选 vendoring 的原因（实现自由决策）：

- 上游 `package.json` 的运行时依赖含 React / TanStack / vite（整套 dashboard UI），且 `deploy` 需先
  `vite build` 产出 `dist/client` 供 `ASSETS` 绑定。作为纯代理目标，Watt 不需要 UI。以 `github:` pnpm
  依赖或 npm pack 引入会把整棵 UI 依赖树 + 构建步骤拖进 monorepo，且 workspace hoisting 与私有仓库
  认证（gh token）会让离线 typecheck / CI 不稳定。
- worker 路径（`src/worker/`）的外部依赖只有 `jose`（monorepo 已有），无 UI 依赖 → 干净可 vendor。
- vendored 后本包用**独立 tsconfig**（不 extends 仓库 `tsconfig.base.json`）保留上游宽松 module 语法
  （无 `verbatimModuleSyntax` / `noUnusedLocals` / `.ts` 扩展名导入要求），上游代码原样通过 typecheck，
  Watt 侧不改上游一行。biome 排除 `**/vendor` 不对上游代码做本仓库风格 lint。

## 对上游的唯一偏离

`vendor/index.ts` 与 `vendor/types.d.ts` 里各一处 `WATT VENDOR PATCH` 标注：headless 部署无 `ASSETS`
绑定，故非 `/api`·`/mcp`·`/htbp` 路径返回 404（上游此处 `env.ASSETS.fetch`）。除此之外 vendor/ 与上游
commit `56ab13b` 逐字节一致。

## 升级流程（上游有新改动时）

1. `gh repo clone TokenRollAI/tool-bridge`（gh 已有 repo scope）→ checkout 目标分支；
2. 在上游开分支实现 / 跑通其 vitest → push（LOOP §2.1 上游通道）；
3. `rm -rf vendor && cp -R <upstream>/src/worker/. vendor/ && find vendor -name '*.test.ts' -delete`；
4. 重新施加上述 `WATT VENDOR PATCH`（ASSETS 可选 + 404 兜底）；
5. `pnpm --filter watt-toolbridge typecheck` 验证 → 更新本文件的 commit 锚点。

## 树配置的运行时同步

上游从 `MCP_SERVERS_JSON` env var（全局树）或 `TENANTS` KV（`tenant:<id>` 键，`parseTreeFromJson`）
加载树。本 Worker 开 `TENANT_MODE=true`：gateway 代理层在每次转发前，把调用者可见的 `ToolMount` 集合
转成上游树 JSON 写入共享 KV，并以对应 Secret Key 作 Bearer 转发。KV 是运行时可写的树源，故无需重部署即可
反映 mount 变更（详见 `tools-proxy.ts`）。
