# watt-toolbridge

Phase 4 Tool Gateway 的部署单元（Cloudflare Worker `watt-toolbridge`）。它是整棵 HTBP 工具树的宿主：
Watt gateway 经 **service binding** `TOOLBRIDGE` 把 `/htbp/tools/*` 代理到这里（认证 + Check PEP +
错误形状转换 + 可见性裁剪都在 gateway 代理层 `packages/gateway/src/http/tools-proxy.ts`，本 Worker 只做
树解析 / `~help` / 调用 / 虚拟化 / 租户隔离）。

## 接入方式

`watt-toolbridge` 通过 npm 包 `@tokenroll/tool-bridge` 接入上游能力，不再依赖私有 git 仓库或 vendored
源码。当前使用的入口：

- `@tokenroll/tool-bridge/worker`：本 Worker 的嵌入入口，`src/index.ts` 调用 `createBridge()` 暴露 Tool
  Bridge 服务。
- `@tokenroll/tool-bridge/host`：gateway 消费面调用 Host SDK，同步 mount 树并执行 `~help` / tool call。
- `@tokenroll/tool-bridge/admin`：gateway 管理面调用 Admin SDK，覆盖 provider、host、endpoint、audit、
  legacy MCP server 等管理 API。

这样 CI 只需要访问 npm registry，不需要 GitHub 私库读取 token。升级 Tool Bridge 时，更新
`@tokenroll/tool-bridge` 版本并重新生成 `pnpm-lock.yaml` 即可。

## 树配置的运行时同步

Tool Bridge 从 `TENANTS` KV 读取租户树。本 Worker 开 `TENANT_MODE=true`：gateway 在调用前通过 Host SDK
把调用者可见的 `ToolMount` 集合同步到 Tool Bridge，再以对应 S2S key 通过 service binding 转发。
KV 是运行时可写的树源，故无需重部署即可反映 mount 变更（详见 `packages/gateway/src/tools/tool-invoker.ts`）。
