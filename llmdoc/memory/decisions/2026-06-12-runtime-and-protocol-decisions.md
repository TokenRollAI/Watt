# 决策记录：runtime 选型与协议定案（2026-06-12）

以下决策已全部拍板，出处为 `docs/architecture.md`「已有结论的问题」、`docs/protocol-v1.md`「已决问题」与 `docs/flue-reference.md`「结论（已定案）」。

## Agent Runtime 全自研

- 决策：自写 turn loop + 薄模型层直连 DeepSeek（OpenAI 兼容），不依赖任何现成 agent 框架。
- 理由：决策 4 强制的执行形状（模型调用在 Queue consumer、结果回写 Run Coordinator）市面框架都不提供，外购只覆盖约四分之一工作量。
- 弃用候选：
  - Flue / Cloudflare Agents SDK：模型 await 在 DO 内，违反决策 4 的成本结构。
  - pi-agent-core + pi-ai / Vercel AI SDK：只解决 loop 内核与模型客户端，且 0.x 快速演进追赶成本高（AI SDK 不给价格表）。
  - Mastra / LangGraph JS / OpenAI Agents SDK：自带编排观点，与 PlanScript + Scheduler 构成双重编排。
  - Claude Agent SDK / Codex / OpenCode 等进程级 harness：每 session 约 1 GiB RAM，与"Agent 像函数一样便宜"差三个数量级（正确位置是 Sandbox / External Runtime 住户）。

## PlanScript 解释器选 QuickJS WASM

- 决策：PlanScript 跑在 QuickJS WASM 解释器，弃 Dynamic Worker Loaders。
- 理由：确定性完全可控、指令级 gas 计量、平台无关；Dynamic Workers 截至 2026-06 仍 open beta 且每个 PlanScript 按独立 Worker 计费。

## Workflow 资源 V1 不引入

- 决策：不引入 Workflow 资源，不做其版本化。
- 理由：PlanVersion 不可变即已版本化，可复用流程先做 PlanScript 模板，真实复用需求出现再正式化（与 Mission 推迟逻辑一致）。

## Memory 提升走 Manager 评估 + 审计 + 回滚

- 决策：checkpoint 的 memory candidates 由 Manager（模型驱动）评估提升，每次提升写 Audit Store、可回滚，用户可手动干预。
- 理由：Manager 误判会污染后续任务上下文，提升必须可审计、可撤销。

## GitHub artifact 写专用 repo

- 决策：V1 artifact 写入 workspace 配置的专用 artifact repo，路径 `runs/<YYYY-MM-DD>-<task-slug>/<file>`。
- 理由：不与用户代码 repo 混写，副作用边界清晰。

## outputSchema 用完整 JSON Schema

- 决策：完整 draft 2020-12，不做受限子集；校验器选 Workers 兼容的解释型实现（如 `@cfworker/json-schema`，不能用 ajv eval 模式）。
- 理由：复杂度靠 Planner prompt 引导扁平 schema 约束，而非协议限制。

## eventKey 用分层字面键

- 决策：`waitFor` 的 eventKey 取 `<integration>/<event>/<correlation>` 字面匹配，不做结构化过滤器。
- 理由：Integration Service 投递与 waitFor 匹配同一语法，最简单且确定性。

## Session 历史 V1 就做模型压缩

- 决策：超阈值用廉价模型生成摘要、以压缩节点替换早期消息，摘要成本计入该 Session；溢出兜底仍是截断。
- 理由：参照 Flue 的 compaction entry 进历史树模式，成本聚合必须含压缩成本。

## invoke 幂等 key 由 Host 派生

- 决策：不暴露幂等 key 参数，Host 以 `run_id + seq` 自动派生（会话侧 `session_id + 消息序号`）。
- 理由：seq 的确定性分配天然保证重放一致性，脚本无感知即无误用。
