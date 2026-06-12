# 核心硬不变量

任何设计或实现都不得违反以下不变量。详细因果见 [../architecture/execution-model.md](../architecture/execution-model.md)。

## 1. DO 绝不 await 模型调用（决策 4，全项目最高约束）

Durable Object 在 await 外部 fetch 期间不可休眠、按 wall-clock 计费；模型调用可达分钟级，海量 Agent 下成本承诺会被击穿。规则：

- DO 只做身份、状态、事件日志、路由，单次操作毫秒级返回。
- 模型调用与长 I/O 永远发生在 Workflow step 或 Queue consumer（或无状态 Worker 请求上下文），结果回调写回 DO。

凡是把模型 await 放进 DO 的方案（如 Flue / Cloudflare Agents SDK 的运行路径）一律被此约束淘汰。

## 2. 会话不是 Run（Session XOR Run）

直连会话与 Run 是两条互斥路径，靠三道结构防线强制，不靠约定：

1. ID 语法：`sess_<agent_ulid>_<ulid>` 无 run 成分，`run_<task_ulid>_<ulid>` 无 session 成分，互不可通过对方校验（`packages/protocol/src/ids.ts`）。
2. 事件 scope：`RunEvent` 与 `SessionEvent` 是 scope 判别联合，`runId` 与 `sessionId` 互斥（`packages/protocol/src/events.ts`）。
3. 存储隔离：会话历史住 per-Agent DO，不进 Run Store、无 PlanScript、不出现在 Run 列表。

## 3. Planner 产数据，Scheduler 产动作

模型（Planner）只产出 PlanScript / AgentSpec 数据资产；确定性代码（Scheduler）执行全部动作。重新计划只能由白名单硬事件触发：重试耗尽、用户追加或修改要求、审批被拒。"结果不符合预期"只能经失败传播（如 schema 校验不过）进入失败路径。

## 4. PlanScript 确定性边界

PlanScript 跑在 QuickJS WASM 沙箱中：无原生时间、随机数、网络、文件；时间与随机只能来自 journaled Host 函数。相同 Host 返回序列必须产生相同执行流，以支持 journal 重放恢复。计划禁止嵌套生成计划。

## 5. Host API 8 函数只加不改

`run / invoke / spawn / checkpoint / approval / sleep / waitFor / artifact`（`packages/protocol/src/host.ts` 的 `HOST_FUNCTIONS`）。后续版本只能新增函数，不能修改既有函数语义或签名。

## 6. 成本是一等公民字段

每次模型调用与工具调用记录 `costUsd`，逐级汇总到 AgentRun、Run、Task、Session、workspace。任何新的执行路径都必须接入成本记账，预算检查由确定性代码在派发前执行（超限抛不可捕获的 `BUDGET_EXCEEDED`）。
