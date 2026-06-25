# 执行模型与调度架构

源：`docs/architecture.md`（完整权威）与 `docs/flue-reference.md`（选型依据）。本文压缩保留因果链。核心原则一句话：**模型负责计划，确定性代码负责调度。**

## 五 fabric 总览

```text
User Intent -> Mission Control -> Agent Fabric -> Context Fabric
            -> Delivery Fabric -> Infrastructure Adapter
```

- Mission Control：意图 → 任务 / 目标 / 运行图。
- Agent Fabric：Agent 的定义、生成（Agent Factory）、版本化、部署、运行。
- Context Fabric：ContextPackage / ContextRef / Memory 的表示、裁剪、传递、沉淀。
- Delivery Fabric：报告、artifact、机械验证、通知、外部写入。
- Infrastructure Adapter：同一抽象映射到 Cloudflare（第一实现）/ Kubernetes 等。

## 执行模型 5 决策

回答的核心问题：动态生成的 Agent 组织，如何在不允许运行时部署代码的平台上可靠执行。

### 决策 1：计划与调度分离

- Planner（模型，Manager 的一部分）：输入 Task / Context / 可用 Agent 与工具，输出 AgentSpec 集合 + PlanScript。只产数据，不执行动作。
- Scheduler（确定性代码）：执行 PlanScript，派发 AgentRun，构造 ContextPackage，做超时 / 预算 / 权限检查，写事件与 checkpoint。不调用模型做调度决策。
- 重新计划仅白名单硬事件触发（重试耗尽、用户追加修改、审批被拒）；计划修订是带版本的数据变更，受每 Run 修订次数上限约束。

### 决策 2：计划是受限脚本（PlanScript），不是代码部署

理由：Cloudflare Workflows 是部署时静态代码，运行时只能创建实例，动态计划只能是数据资产，由静态部署的解释器执行。选脚本而非声明式 JSON 图：模型生成代码比生成深层嵌套 JSON 可靠；循环 / 条件 / fan-out / 流水线用代码表达自然；Temporal、Workflows 已验证"确定性脚本 + 重放日志"形态。

边界：

- 只能调用 Host API 8 函数（见 [../reference/protocol-contracts.md](../reference/protocol-contracts.md)），沙箱内无网络、文件、原生时间与随机数。
- 跑在 QuickJS WASM 解释器中，指令级 gas 计量 + wall-clock 超时。选 QuickJS 弃 Dynamic Worker Loaders 的理由：确定性完全可控、可计量、平台无关；Dynamic Workers 截至 2026-06 仍 open beta 且每个 PlanScript 算一个计费 Worker。重放只耗毫秒级 CPU，执行慢可接受。
- 必须确定性：相同 Host 返回序列产生相同执行流（journal 重放恢复的前提）。
- 静态校验（语法白名单、禁 import/eval）+ 策略检查后存为不可变 PlanVersion。
- 禁止嵌套生成计划；改计划唯一路径是交回 Planner 出新 PlanVersion。
- 并发由 Host 配额调度而非语言限制：脚本可一次发起数百调用，超出排队，瓶颈设计在调度器。

### 决策 3：AgentVersion 是纯数据

运行时不能部署 Agent 代码。AgentVersion 只含 prompt、模型设置、工具授权、输出 schema 等配置，由通用 Agent Runtime 解释执行。需要新代码的能力（新工具 / 集成）走常规发布，再以工具授权形式提供。

### 决策 4：DO 持久化状态，绝不 await 模型调用

全项目最高约束，成本动机与规则见 [../must/core-invariants.md](../must/core-invariants.md)。它决定了整个执行形状：模型调用必须外置到 Queue consumer / Workflow step / 无状态 Worker。

### 决策 5：长期任务是周期性实例，不是永生实例

Workflows 单实例有步数与状态上限。跨天 / 月目标表达为每周期一个实例，由调度触发，周期间靠 checkpoint 与 memory 衔接。

## 调度器三件套

### Run Coordinator：per-Run Durable Object

每个顶层 Run 一个 DO 实例，是该 Run 的状态权威。持有：PlanVersion 引用与各 Host 调用状态、运行事件日志（DO SQLite）、hot context / checkpoint 草稿、预算计数器（模型花费、Agent 数、并发额度、修订次数）。Run 结束后事件日志归档 R2，查询索引异步写 D1（D1 是查询投影，不是权威）。

### Script Runner：静态部署的通用 Workflow

执行模型是重放 + journal：脚本每次从头在 QuickJS 中执行，已完成的 Host 调用从 journal 立即返回缓存结果，快进到第一个未完成调用，发起后挂起。Host 调用映射到 Workflow 原语（step.do / waitForEvent / sleep），Workflows 的 step 缓存即 journal，durable retry 由平台承担。Host 调用按发起顺序分配确定性 seq，并发完成顺序不影响重放一致性。返回值一律 ContextRef 或小结构，大结果落 R2。未捕获脚本错误使 Run 失败，journal 即完整执行记录。

### Dispatcher：Queues + 通用 Agent Runtime

AgentRun 命令带 idempotency key 进队列，由 Agent Runtime worker 消费：装载 AgentVersion、解析 ContextPackage、执行模型与工具调用、写回 Run Coordinator、向 Script Runner 回发完成事件。并发配额在这一层放行，超出排队，对脚本透明。

## Agent Runtime：全自研定案与执行形状

决策（`docs/flue-reference.md` 已定案）：自写 turn loop + 薄模型层直连 DeepSeek（OpenAI 兼容），不依赖 Flue / pi-agent-core / Vercel AI SDK。理由：决策 4 强制的执行形状（模型调用在 Queue consumer、结果回写 Run Coordinator）市面框架都不提供，外购只覆盖约四分之一工作量；现成框架的 Cloudflare 落地层把模型 await 放在 DO 内，与决策 4 正面冲突。

执行形状（降低自研成本的关键窍门）：

- 一次 AgentRun 的完整 in-process loop 在**单个 Queue consumer 调用内跑完**（consumer wall-time 上限 15 分钟，对轻量 Agent 足够）。
- turn 边界写 checkpoint **仅用于故障恢复**，不做跨 step 可重入的 turn 状态机（那是改造 Flue 最贵的部分，绕开它）。
- 超长 AgentRun 用 re-enqueue 续跑。
- 输出靠注入式 finish / give_up 工具：outputSchema 校验在工具执行内进行，通过才终止循环，失败有显式投降路径（机械验证的 schema 层）。

## 预算四层防护

递归结构（Factory + spawn）必须硬配额兜底，全部由确定性代码执行：

1. 脚本层：QuickJS 指令级 gas + 单次重放 wall-clock 超时；沙箱无原生时间 / 随机 / 网络。
2. Host 调用层：每次 run / invoke / spawn 前检查 Run Coordinator 预算计数器（花费、Agent 数、并发、单调用超时与重试上限）。
3. 计划层：每 Run 的 PlanVersion 修订次数上限；禁止嵌套生成计划。
4. 平台层：Workflow 步数、CPU 时间等平台上限；workspace 级并发 Run 上限与月度预算。

原则：并发上限尽可能大，真正的约束是预算（花费）而不是并发数。per-Run 预算由 Watt 自己的 Model Gateway 实现（AI Gateway spend limits 每网关仅 20 条规则，只做账户级兜底）。

## 直连会话路径

Task / Run 之外的第二条用户路径：用户在注册表选中 Agent 直接对话。

- Session 是一等资源，一个 Agent 任意多个 Session，各有独立历史与 hot context。
- 会话不是 Run：三道结构防线见 [../must/core-invariants.md](../must/core-invariants.md)。
- 不破坏决策 4 的执行办法：会话状态住 per-Agent actor（DO），模型调用发生在**无状态 Worker 的请求上下文**——Workers 按 CPU 计费，await 模型期间 wall-clock 等待近乎免费；DO 只做毫秒级状态读写。
- 同一 Session 单飞（并发消息 409，开新 Session）；V1 同步请求-响应不做流式；历史超阈值用廉价模型压缩（成本计入该 Session）。
- 工具与模型调用走同一套预算 / 成本 / 审计记账，按 session 维度汇总。

首个落地：`apps/agent-gateway`（无状态 Worker）组装 `runtime-core`（runAgent turn loop）+ `model-deepseek` + `protocol`，`POST /v1/chat` 在请求上下文内直连 DeepSeek 跑完一次 AgentRun，已完成 Cloudflare 部署与端到端验证（成本记账与 started→model.called→finished 事件流均工作）；模型调用不占用 DO，符合本路径变体。注意：薄模型层在 Workers 上必须用 `globalThis.fetch.bind(globalThis)`（未绑定的 fetch 在 Workers/浏览器会抛 "Illegal invocation"）。

## 多 agent 编排 Worker（research-team）

第二个落地 Worker `apps/research-team`：把「模型负责计划、确定性代码负责调度」推广到多 agent 协作，仍住在无状态 Worker 的请求上下文里（同会话路径变体，模型调用不占用 DO，符合决策 4）。这是决策 1（计划与调度分离）/决策 2（计划是 PlanScript 而非代码部署）的首个真实落地——早期硬编码 TS 编排（`team.ts`）已删除。

编排形态（三段，分别对应 Planner / Script Runner / Dispatcher 的精神）：

- **Manager 产 PlanScript**（`apps/research-team/src/manager.ts` 的 `runManager`）：用 `runtime-core` 的 runAgent 跑一次模型，经注入的 finish 工具产出一段 **PlanScript**（JS 源码字符串）作为数据资产。脚本内用 `host.run('researcher_*', ctx)` / `host.run('synthesizer', ctx)` 编排，含 `Promise.all` 并行、条件过滤、`JSON.stringify` 拼汇总材料。开几路、依赖关系、如何汇总均由模型决定——编排逻辑由模型生成，不再硬编码 TS。Manager 产出后先本地 `validatePlanScript` 验一道。
- **Script Runner 确定性执行**（`apps/research-team/src/driver.ts` 的 `runPlanScript`）：用 `@watt/plan-script` 的 `replayPlanScript` 在 QuickJS 沙箱中重放脚本；每轮取 pending 的 host 调用 frontier，在沙箱外 `Promise.all` 并行执行，把 `AgentRunResult` 写回 `journal[seq]`，循环直到 completed/failed（重放 + journal 执行模型，见上文「Script Runner」）。预算由 driver 的 `budgetCheck`（发起新调用前查累计成本）+ roles 的 `floorBudget`（对子 Agent 预算取安全下限）双重兜底。
- **host.run 沙箱外派发**（`apps/research-team/src/roles.ts` 的 `runRoleAgent`）：按 agent 名前缀路由到 researcher（带 Tavily web_search/web_read 工具）/ synthesizer / generic，每个都是一次 `runtime-core` 的 runAgent，跑在沙箱外的 Worker 请求上下文（符合决策 4，模型调用不进沙箱、不占 DO）。

注意：本实现的 driver 是 **Worker 内的请求级重放循环**，已是 Script Runner 重放语义的最小可运行落地，但**尚未接 Cloudflare Workflows 的 step 持久化 / durable retry**（把 journal 落到 Workflows step 缓存、靠平台承担重试是后续工作）。

- 预算在多 agent 场景的兜底（决策 4「成本一等公民」的具体落地）：每个 subagent 的 `maxToolCalls` 留足余量，再由工具层软上限 + instructions 引导模型尽快 `finish`，避免勤奋的模型撞工具调用上限而丢弃已得成果。预算上限始终由确定性代码兜底（driver + roles），不靠 prompt 自律。

### 平台约束：Workers 出口需带 key 的搜索后端

Cloudflare Workers 的出口是数据中心 IP，调「无 key」公开数据源对 Workers 出口不可靠（抓取/直连易被 429、软封或限流，免费层也可能随时取消）。DeepSeek 的 `/chat/completions` 也不含内置 web search，需 function calling 自接搜索源。因此给 Agent 接联网搜索时，选靠 API key 鉴权、不看来源 IP 的后端（research-team 用 Tavily，key 走 secret）。

### 平台约束：QuickJS WASM 在 Workers 必须部署时预编译

Cloudflare Workers 只允许「部署时预编译」的 `WebAssembly.Module`，**禁止运行时 `instantiate(bytes)` / fetch wasm**——quickjs-emscripten 默认的 emscripten loader（`getQuickJS()`）走运行时加载，在 Workers 会失败。正确姿势：静态 `import` variant 的 `.wasm` 文件（wrangler 把它当预编译 Module 处理）+ quickjs-emscripten 的 `newVariant({ wasmModule })` 注入。为此 `packages/plan-script/src/sandbox.ts` 增设 `setQuickJSVariant()` 注入点——默认仍走 `getQuickJS()`（Node/测试无回归），Workers 侧在启动时注入预编译 variant（见 `apps/research-team/src/driver.ts` 顶部的 import 与注入）。
