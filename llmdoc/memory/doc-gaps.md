# 文档缺口

记录已知缺口及关闭条件。由 `recorder` 在非平凡更新时核对。

## 1. guides/ 为空 —— 已关闭（2026-06-14）

- 原缺口：项目尚无已固化的可重复工作流。
- 关闭：`guides/next-phase-handoff.md` 落地（M1–M4 里程碑路线与分工规约），已收录入 index.md。后续新增工作流型 guide 时按需补充。

## 2. docs/ 与代码的权威同步机制未定

- 缺口：docs/ 当前是设计权威，但实现展开后"docs 先行还是代码先行"未定，可能出现静默偏离。
- 关闭条件：确立同步规则（如"协议变更必须先改 docs/protocol-v1.md 再改代码"或反向），记入 decisions/ 并更新 must/project-basics.md。

## 3. 无 CI / lint

- 缺口：质量门只有本地 `pnpm test` / `pnpm typecheck`，无 CI 强制，无 lint 配置。
- 关闭条件：CI 接入（或显式决策不做）后更新 must/project-basics.md 的质量门描述。

## 4. plan-script / runtime-core / storage 落地后需补 architecture 文档

- 缺口：M1 五包已落地（plan-script = QuickJS 封装 + 静态校验 + journal 重放；runtime-core = turn loop + finish/give_up；model-deepseek = 薄模型层；storage = 五窄接口 + 内存实现），但 architecture/ 仍只有 execution-model.md 一篇，各包的实现边界尚无专门检索文档。plan-script 的公共 API（`validatePlanScript` / `replayPlanScript` / `executeInSandbox` / `setQuickJSVariant` + 类型）目前只散落在 execution-model.md 与代码，尚无专门 reference；其中 `setQuickJSVariant`（Workers 预编译 WASM 注入点，2026-06 由 research-team 落地驱动新增）应在 plan-script reference 中正式收录。
- 关闭条件：分别补 architecture 文档（解释器边界与重放实现、turn loop 与 finish/give_up 实现、storage 接口边界），并补 plan-script 公共 API 的 reference，同步 index.md。

## 5. apps/ 两个 Worker 的端点契约尚无 reference 文档

- 缺口：已部署两个 Worker——`apps/agent-gateway`（`POST /v1/chat`）与 `apps/research-team`（`POST /v1/research`，多 subagent 调研团队），其请求/响应契约只散落在代码与 execution-model.md，无稳定 reference。
- 关闭条件：端点契约稳定后补 reference/ 文档（端点、body/响应 schema、配置项、所需 secret），并同步 index.md。
