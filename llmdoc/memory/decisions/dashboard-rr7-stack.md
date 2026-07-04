# 决策：Dashboard 技术栈 = RR7 framework mode SPA + Tailwind v4 + shadcn/ui；manage 对话走轮询 event List

- 日期：2026-07-04（Round 36）
- 状态：已实现上线（packages/dashboard 原地重建，旧 src/ 已删）

## 决定

1. **技术栈**：React Router 7 framework mode（`ssr: false` 纯 SPA）+ Tailwind v4 + shadcn/ui（23 组件 vendored 进 `app/components/ui`，不 lint）。16 视图全 CRUD + manage 对话，与 CLI 十六命令族对齐。
2. **manage 对话链路**：Spawn 建会话 → 每轮 `Send{expect}` → 前端 1.5s 轮询 `EventStore.List{correlationId}` 取 `agent.result`/`agent.failed` → 渲染 `payload.output`（70s 兜底超时，sessionStorage 会话恢复）。
3. **Spawn 建会话不带 expect**：expect 只在每轮 Send 时带。

## 理由

1. **RR7 + SPA 产物**：Cloudflare 对 React Router 7 有官方一等支持；`ssr:false` 产物是纯静态 `build/client`，落 dist/ 后**完全兼容既有 gateway assets 同域托管分发管道**（R35 单域化 + build:deploy 模板改写逻辑零调整）。shadcn 是代码进仓而非依赖，可随「电力控制台」主题任意定制。
2. **轮询 event List 而非新增同步端点**：investigator 三方案对比（A=EventStore List 增 `correlationId` filter、B=gateway 新增同步等待端点、C=WebSocket/SSE 推送）。选 A——manage 对话「零后端改动可跑通但前端筛 payload 会漏」，把 correlationId 收口为一等查询路径只需 **EventStore.List filter 十行改动**（json_extract payload，Proto §2.4 先行增补 + 2 测试），B/C 都要新协议面与连接管理，投资回报不成比例。
3. **Spawn 不带 expect**：view-b worker 实测发现 Spawn 带 expect 会触发 harness 对空输入**空跑一次 LLM**（gateway `src/agent/agent-runtime.ts:182-186`：spawn 时 expect 存在即投递一次 OnEvent）——建会话改为不带 expect 规避。

## 遗留

- agent waiter 无 `'none'` 类：manage 对话每轮 Send 的 self-waiter 回投会**多跑一次 LLM**（成本冗余，投资回报低暂不做）。
- `/oauth/root/token` 不在 CORS 白名单：同域托管无碍；跨源 vite dev 时 Root Key 登录被拦，开发期用 token 粘贴路径。

## 关联

- [../../guides/toolchain-pitfalls.md] §66~68（gitignore `lib/` 吞 app/lib、RR7 SPA 构建依赖、biome Tailwind 指令与产物排除）。
- [root-key-bootstrap.md](root-key-bootstrap.md)——dashboard 登录页的 Root Key 换发路径即 R35 该决策的 WEB 消费面。
