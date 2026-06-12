# 项目总览

## 身份

Watt 是面向个人自动化的 Agent 控制平面：先定义稳定的 Agent 资源模型、运行协议与对外 REST API，再实现运行时。Agent 被当作可管理的资源——可版本化、可回滚、可部署、可观察、可持久化上下文，而不是一次聊天或常驻进程。

## 五个承诺（`docs/vision.md`）

1. 7x24 在线：Agent 长期可寻址、可唤醒、可恢复（"能力永不消失"，不是"进程永不退出"）。
2. 海量创建：Agent 像函数一样便宜，可被大量临时生成、回收或持久化。
3. 廉价且可靠：低成本 runtime / 模型（DeepSeek）/ 存储，可靠性来自协议与状态机而非常驻进程。
4. 编排交付：以 Run / Checkpoint / Artifact 交付可验证结果，不靠自然语言聊天。
5. 基础设施接入：GitHub、搜索、沙箱等以 Integration 协议化接入，凭证与副作用可审计。

## V1 范围内

- Web UI + CLI + 统一公开 REST API（进度查询用分页轮询）。
- 版本化 Agent 资源模型（Agent / AgentVersion / AgentDeployment）。
- Manager 动态生成计划（PlanScript）与临时 Agent（Agent Factory）。
- Checkpoint 回溯与 memory 候选沉淀。
- 仅 DeepSeek 官方 API；GitHub 为第一参考集成。
- 用户与 Agent 直连对话（Session 一等资源）。

## V1 明确不做

- Mission 资源：长期目标先表达为带调度配置的 Task。
- Workflow 资源：PlanVersion 不可变即已版本化，可复用流程先做 PlanScript 模板。
- SSE / WebSocket：轮询足够；标准 WebSocket 还会阻止 DO 休眠。
- 多模型 parity：不兼容 Anthropic / OpenAI，Model Gateway 预留 adapter。
- 企业多租户权限系统：单用户优先，但所有资源带 workspace 边界。
- 完整 GitHub Issue / PR / webhook 接入、编排外部 Agent（Codex 等）。

## 主要区域

- `docs/`：设计权威四篇，全部定稿。定位见 [../must/project-basics.md](../must/project-basics.md)。
- `packages/protocol`：唯一代码包，协议契约 schema。检索地图见 [../reference/protocol-contracts.md](../reference/protocol-contracts.md)。
- 未来包路线（`docs/architecture.md` Monorepo 建议）：下一步是 `packages/plan-script`（QuickJS 封装 + 静态校验 + journal 重放）与 `packages/runtime-core`（turn loop + DeepSeek 薄模型层），其后才是 orchestrator / context / integrations-github / apps 等。

架构细节见 [../architecture/execution-model.md](../architecture/execution-model.md)。
