# Flue 架构参考笔记

本文记录对 Flue 框架的架构调研结论，回答两个问题：

1. Watt 的架构设计可以从 Flue 借鉴什么。
2. Flue 能否作为 Watt Agent Runtime 的底座。

调研对象：`@flue/runtime` 0.9.1（Apache-2.0），本地检出
`~/.superset/projects/flue`，核实于 2026-06。结论基于其 llmdoc 文档与
源码核查，关键事实均有代码证据。

## Flue 是什么

Flue 自述为 "The Agent Harness Framework"：TypeScript 编写、runtime
无关的 headless agent 框架。Agent 的主体逻辑放在 Markdown（SKILL.md、
AGENTS.md、context 文件），TypeScript 只做接线；CLI 把项目编译成两种
部署产物：Node 单文件 `.mjs`，或 Cloudflare Workers + Durable
Objects。底层模型循环是外部 npm 包 `@earendil-works/pi-agent-core`
（loop 内核）+ `@earendil-works/pi-ai`（模型与流式），锁定 0.75.4。

Flue 没有的东西恰好是 Watt 的差异化：Planner / PlanScript、Agent
Factory、预算防护、Memory Store、Delivery 与验证层。两者不重叠：
Flue 约等于 Watt 架构中 "Agent Runtime + 部分 Orchestration +
Infrastructure Adapter" 这一纵切片的已落地实现。

## 可借鉴的架构设计

### 1. 平台适配靠窄接口，不靠平台抽象层

Flue 的 "write once, deploy anywhere" 不是一个大而全的平台抽象层，
而是少量窄的结构化接口：

- `SessionEnv` 一个 seam 收口全部文件与 shell 访问，runtime 永不直接
  访问宿主文件系统。
- `SessionStore` / `RunStore` / `RunRegistry` 三个存储接口，Node 用
  in-memory 单例实现，Cloudflare 用 DO SQLite 实现，调用方无感知。

对 Watt 的启示：Infrastructure Adapter Layer 不必实现为一个"层"，
而是若干按存储语义切分的窄接口，正好对应 Watt 存储设计中 Registry /
Run / Hot Context / Artifact Store 的语义边界。

### 2. 不变量的多层结构化强制

Flue 最核心的不变量是 "runs belong to workflows only"（直连 agent
prompt 不是 run）。它不靠约定，而是多层结构性强制：

- ID 语法编码所有权：run id 形如 `workflow:<name>:<ulid>`，根本不存在
  agent-run 的 id 格式。
- run id 即 DO instance id：一个 run 一个 DO 实例。这正是 Watt
  "Run Coordinator: per-Run DO" 的设计，Flue 证明了可行。
- schema 用 literal 锁死 owner kind；事件字段 `runId` 与 `instanceId`
  互斥；非 run 交互在出口处主动剥离 run 框架事件。

Watt 的资源种类更多（Run / AgentRun / ToolRun / WorkflowRun），更需要
"ID 语法 + schema literal + 字段互斥"的多层防线。建议作为 `protocol`
包的设计原则。

### 3. Run 事件持久化与流式读取的成熟参数

Flue 的 RunStore 与 SSE 设计可直接作为 Watt Run Coordinator 的参考：

- 事件强制单调 `eventIndex`，断言 `event.runId === runId`，单事件上限
  1 MB。
- SSE：终态 run 只重放；活跃 run 先订阅后重放再 live tail，按
  eventIndex 去重；支持 `Last-Event-ID` 断点续传；15 秒心跳；
  `run_end` 关流。
- 跨 DO 的 run 索引用单例 Registry DO（`idFromName('default')`），
  而不是 D1 投影。

最后一点与 Watt 的决策（D1 Run index 是异步查询投影）构成一组备选：
单例 DO 索引写路径强一致，但受单对象吞吐上限（约 1,000 请求/秒）
约束；D1 投影最终一致但查询能力强。Watt 海量 Agent 场景下 D1 投影
方向合理，可考虑混合：热路径指针用 Registry DO，分析查询用 D1 投影。

另外 Watt 已拍板 V1 进度更新用轮询。Flue 证明 SSE 在 Cloudflare 上
可行且不贵（订阅是 in-process fan-out），该决策将来翻案成本不高。

### 4. 结构化结果：finish / give_up 注入工具

Watt 通信设计中 Orchestrator 传给 Agent 的 `ExpectedOutput` 如何落地，
Flue 给出了具体机制：

- 把输出 schema 编译成注入的 `finish` 工具，参数即 JSON Schema；
  校验在工具 execute 内执行，校验通过才终止循环。
- turn 结束仍未产出结果时用 follow-up prompt 催促，上限 32 次。
- `give_up` 工具显式投降，抛出带原因的类型化错误。

这是"机械验证"在 schema 层的实现样板：结果要么通过 schema 校验，
要么得到显式失败，不存在"模型自述完成"的模糊地带。

### 5. 会话历史是树，成本聚合含压缩成本

- Flue 的会话历史是树不是列表：entry 带 `id` / `parentId`，`leafId`
  标记活跃头，compaction 是一种 entry 类型，替换被压缩段。对 Watt 的
  Checkpoint / Hot Context 设计有直接参考价值：checkpoint 可建模为
  历史树上的压缩节点，天然支持分支与恢复。
- `aggregateUsageSince` 沿活跃路径汇总 token 与成本，把压缩摘要的
  模型成本也计入触发它的那次调用。Watt "成本是一等公民"要做对，
  必须有这个细节。

### 6. Cloudflare 实现层的已知坑

Flue 已踩过、Watt 一定会遇到的几个点：

- DO 内异步交错：DO 在 await 处会交错处理请求，Flue 用
  `AsyncLocalStorage` 按 fiber 隔离上下文，而不是模块全局变量。
  Watt 的 Run Coordinator 和 Agent actor 同样需要。
- dispatch 回执语义：受理即返回 receipt，不等处理完成；Cloudflare
  队列 at-least-once，副作用必须幂等。与 Watt 幂等设计一致。
- 本地 sandbox 的 env 白名单：默认只继承 `PATH / HOME / USER / LANG /
  TZ / TERM / TMPDIR` 等十余个无害变量，secrets 永不默认进入模型可见
  的 bash。与 Watt "Sandbox 内不落明文凭证"同源，清单可直接采用。
- 远程 sandbox 取消契约：`timeout`（秒）是主取消机制，映射到供应商
  原生超时；`signal` 只是 best-effort。Watt 的 ToolRun / Sandbox
  超时设计应采用同样的"超时为主、信号为辅"契约。

### 7. Agent 即数据的旁证

Flue agent 约等于 Markdown 加配置。`initialize` 在每次 harness 初始化
时重跑，不是一次性构造函数；skill 正文在发现期不驻留，调用时才重读，
省上下文且能拿到中途编辑。这两点对 Watt 的 AgentVersion 解释执行模型
（决策 3）和 ContextPackage 裁剪策略都是直接旁证。

## 作为 Agent Runtime 底座的评估

### 关键冲突：模型调用发生在 DO 内

这是采用 Flue 的最大障碍，且经源码确证：

- Flue 在 Cloudflare 上把每个 agent / workflow 生成为继承 Cloudflare
  Agents SDK `Agent` 的 Durable Object 类，run 经 `runFiber` 在 DO
  进程内执行。
- pi-agent-core 的 `streamFn` 直接 `await streamSimple(...)`（流式
  HTTP 模型调用），整条调用链在 DO 请求上下文内同步 await。
- 全仓没有使用 Cloudflare Workflows 或 Queues 产品；dispatch 队列是
  DO 自身的 fiber 加 DO 间 fetch。

这与 Watt 执行模型决策 4（模型调用永远不在 DO 内 await，转交
Workflow step 或 Queue consumer）正面冲突。每个并发 run 在模型 await
期间都占用一个按 wall-clock 计费、不可休眠的活跃 DO；数百并发即数百
份 wall-clock 计费。这正是 Watt 要规避的成本结构，且不是配置项能绕开
的：Flue 的 recovery / compaction 状态机围绕"同步 await 模型结果"
设计，改造意味着重写其 Cloudflare 生成层与 turn 驱动状态机。

### 高度可复用的部分

- 数据驱动的动态 Agent 可行：`createAgent(initialize)` 的
  `initialize` 支持 async，每次初始化重跑，可按 instance id 从外部
  存储拉取配置。`instructions / model / thinkingLevel / compaction /
  skills / subagents` 均可纯数据表达，正好覆盖 Watt AgentVersion 的
  主要字段。必须是代码的部分：工具的 `execute` 函数、sandbox
  factory、persist store——与 Watt "新工具能力走常规发布"的边界一致。
- DeepSeek 原生支持：DeepSeek 是 pi-ai 内置已知 provider（OpenAI
  兼容，自动识别 baseUrl，模型目录带真实成本元数据）。直接用
  `deepseek/<model>` 加 `configureProvider('deepseek', { apiKey })`
  即可。注意：自行 `registerProvider` 注册的 HTTP provider 成本元数据
  硬编码为 0，只统计 token，应避免走该路径。
- 成本与预算钩子：每次模型调用记录完整 usage 与 cost（含 cache
  read / write 细分）。调用前可拦截点有 `streamFn` / `getApiKey` /
  `onPayload`，但 `streamFn` 未作为公共 API 暴露（Session 内部硬
  接），实现 per-run 预算门需要 fork 或上游提案。没有开箱即用的
  超预算阻断。
- 并发特性：一 run 一 DO，水平分片，数百并发 run 本身无瓶颈；但同一
  (agent, instance, session) 严格 single-flight，同 session 不能并行
  操作。对 Watt 的 fan-out 模式（每个 AgentRun 独立实例）天然兼容。

### 成熟度与许可

- Apache-2.0，可商用、可 fork。
- 0.x beta：CHANGELOG 数日一发且多次 breaking change，曾要求清空
  持久化 session 状态。作为依赖意味着持续追赶上游。
- 测试 64 个文件，集中在 runtime 子系统，质量信号尚可。
- pi-agent-core / pi-ai 锁定 0.75.4，同样处于快速演进期；其 LICENSE
  未在本地核实，采用前需确认。

### 结论（已定案）

Flue 整体不能照搬为 Watt 的 Agent Runtime：其 Cloudflare 落地层的
执行模型与 Watt 的成本承诺正面冲突。

**决策：Agent Runtime 全自研。** 自写 turn loop 与薄模型层直连
DeepSeek（OpenAI 兼容协议），Flue / pi-agent-core / pi-ai / Vercel
AI SDK 均只作设计参考，不作依赖。理由：

- 决策 4 强制的执行形状（模型调用在 Queue consumer 内、结果回写
  Run Coordinator、turn 边界写 journal）市面上没有框架提供；外购
  只能覆盖约四分之一工作量（loop 内核与模型客户端），ContextPackage、
  预算门、成本汇总、工具授权审计、checkpoint 回写这些 Watt 特有件
  无论如何都要自建。
- V1 单一模型供应商（DeepSeek）且为 OpenAI 兼容协议，薄模型层成本
  很低；模型层藏在 Model Gateway Service 后面，后续要换库或加供应商
  都是局部替换。
- 避免对 0.x 快速演进依赖（flue、pi 系列均数日一发且有 breaking
  change）的追赶成本。

降低自研成本的关键架构窍门：一次 AgentRun 的完整 in-process loop 在
单个 Queue consumer 调用内跑完（consumer wall-time 上限 15 分钟，
对轻量 Agent 足够），turn 边界写 checkpoint 仅用于故障恢复，超长
AgentRun 用 re-enqueue 续跑。不做跨 step 可重入的 turn 状态机——
那正是改造 Flue 最贵的部分，绕开它。

候选图谱备忘（若未来重新评估）：

1. 循环内核库（唯一满足决策 4 的一档）：pi-agent-core + pi-ai
   （DeepSeek 与价格表原生，0.x 风险）；Vercel AI SDK 6（生态最稳，
   但只给 token 不给价格表）；自写 loop（已选）。
2. CF 原生框架（Cloudflare Agents SDK、Flue）：模型 await 在 DO 内，
   被决策 4 淘汰。但 Agents SDK 对 Actor Runtime（Manager /
   Supervisor，只管状态不 await 模型）仍是合适工具，可作互补件。
3. 重型框架（Mastra、LangGraph JS、OpenAI Agents SDK）：自带编排
   观点，与 Watt 的 PlanScript + Scheduler 双重编排，淘汰。
4. 进程级 coding-agent harness（Claude Agent SDK、Codex、OpenCode）：
   每 session 一个子进程，约 1 GiB RAM / 1 CPU，与"Agent 像函数一样
   便宜"差三个数量级。正确位置是 Sandbox Runtime / External Runtime
   的住户，不是通用 Agent Runtime。

无论实现如何演进，本文"可借鉴的架构设计"一节的内容都适用。
