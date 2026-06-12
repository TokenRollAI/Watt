# Watt 基础架构设计

本文描述 Watt 的基础架构边界。

它不设计详细 API，也不绑定某一个具体实现。它回答七个问题：

1. 有哪些服务。
2. 对用户暴露什么。
3. 如何存储。
4. 如何交付结果。
5. 如何通信。
6. 如何动态生成 Agent。
7. 如何分层。

## 架构目标

Watt 的目标是让 Agent 成为一种长期、廉价、可靠、可大量创建的行动基础设施。

架构必须支持：

- 7x24 小时在线的 Agent：长期可寻址、可唤醒、可恢复。
- 廉价运行经济学：低成本 runtime、低成本模型、低成本存储。
- 海量 Agent 创建：Agent 可以被临时生成、按需运行、回收、持久化。
- 可靠编排交付：任务能被拆解、执行、检查、恢复并产出可验证结果。
- 全面基础设施接入：GitHub、搜索、代码沙箱、文档、外部系统都能协议化接入。
- 平台可迁移：Cloudflare 是第一实现，但不是唯一实现。

## 总体抽象

Watt 可以被理解为五个 fabric 的组合：

```text
User Intent
  -> Mission Control
  -> Agent Fabric
  -> Context Fabric
  -> Delivery Fabric
  -> Infrastructure Adapter
```

其中：

- `Mission Control` 把用户意图变成任务、目标和运行图。
- `Agent Fabric` 负责 Agent 的定义、生成、版本化、部署和运行。
- `Context Fabric` 负责上下文的表示、传递、裁剪、引用和沉淀。
- `Delivery Fabric` 负责报告、工件、验证、通知和外部副作用。
- `Infrastructure Adapter` 把同一套抽象映射到 Cloudflare、Kubernetes 或其他平台。

Control Plane 是 Watt 的一部分，但不是全部。Watt 同时包含运行面、Agent 生成
能力、上下文系统、交付系统和基础设施接入层。

## 执行模型决策

本节回答一个核心问题：动态生成的 Agent 组织，如何在一个不允许运行时部署
代码的平台上可靠执行。

原则是一句话：

> 模型负责计划，确定性代码负责调度。

### 决策 1：计划与调度分离

动态编排拆成两个角色：

- `Planner`：由模型驱动，是 Manager 的一部分。输入 Task、Context、可用
  Agent 与工具，输出 AgentSpec 集合和计划脚本（PlanScript）。Planner
  只产出数据资产，不直接执行任何动作。
- `Scheduler`：由确定性代码实现。执行 PlanScript，派发 AgentRun，构造并
  传递 ContextPackage，监控超时与失败，执行预算与权限检查，写入事件
  和 checkpoint。Scheduler 不调用模型做调度决策。

需要改变计划时，Scheduler 暂停相关分支，把当前状态交回 Planner，由
Planner 产出计划的新修订版本。重新计划只能由白名单硬事件触发：节点
失败且重试耗尽、用户追加或修改要求、审批被拒。Agent 输出"结果不符合
预期"不能直接触发，只能通过失败传播（如输出 schema 校验不过）进入
失败路径。计划修订是数据变更：有版本、可审计、可回溯。

### 决策 2：计划是受限脚本，不是代码部署

Cloudflare Workflows 的定义是部署时静态代码，运行时只能创建已有定义的
实例，不能创建新定义。因此 Manager 动态生成的计划不能成为部署单元，
而是一份数据资产，由静态部署的解释器执行。

计划的表达形式是 PlanScript：一段确定性的、类 JavaScript 的受限脚本。
选脚本而不是声明式图（JSON RunGraph）的理由：

- 模型生成代码的可靠性高于生成深层嵌套 JSON。
- 循环、条件、并发 fan-out、流水线用代码表达自然，用图 schema 表达
  别扭。
- 这是 Temporal、Cloudflare Workflows 等成熟系统验证过的形态：
  确定性脚本加重放日志。

PlanScript 的边界：

- 脚本只能调用 Host API。V1 函数集定为 8 个：`run`（派发
  AgentRun）、`invoke`（直接工具调用）、`spawn`（经 Agent Factory
  生成临时 Agent）、`checkpoint`、`approval`（含出站通知）、
  `sleep`、`waitFor`（外部事件）、`artifact`（读写产物引用）。
  后续只加不改。沙箱内没有网络、文件、原生时间和随机数。
- 脚本永远不被原生执行：跑在 QuickJS WASM 受控解释器中，带指令级
  gas 计量和 wall-clock 超时。选 QuickJS 而不是 Dynamic Worker
  Loaders 的理由：确定性完全可控（沙箱内天然无原生时间、随机数、
  网络）、可做指令级计量、平台无关可平移到 Kubernetes；而 Dynamic
  Workers 截至 2026-06 仍是 open beta，按独立 Worker 数计费（每个
  新 PlanScript 即一个新 Worker），且原生 JS 全局需自行封堵。
  QuickJS 执行慢于原生，但重放只耗毫秒级 CPU，可接受。
- 脚本必须确定性：相同的 Host 调用返回序列产生相同的执行流，以支持
  重放恢复。时间和随机数只能来自 journaled 的 Host 函数。
- 脚本经静态校验（语法白名单、禁用 import / eval、Host API 之外无
  全局名）和策略检查（工具与 Agent 授权、预算配额）后，存为不可变的
  PlanVersion，可审计、可回溯。
- 计划不能嵌套生成计划：脚本内没有调用 Planner 的能力，Agent 也不能
  产出子 PlanScript。需要改变计划只有一条路：交回 Planner 产出新的
  PlanVersion（受每 Run 修订次数上限约束）。

Host API 必须支持经典编排语义：

- 并发 fan-out 与 wait-all（Promise.all）。
- 部分等待与竞速（Promise.race、any）。
- 流水线：前序结果作为后继输入逐段传递。
- 容错继续：单个分支失败不中断整体，脚本可捕获类型化错误后降级或
  跳过（continue-on-error）。
- 顺序、条件、循环由语言本身表达。

并发由 Host 控制而不是语言限制：脚本可以一次发起大量调用，Host 按
配额调度执行，超出部分自动排队。上限应配置得足够大（详见“预算与
失控防护”），瓶颈设计在调度器而不是表达能力上。

PlanScript 的语法子集、Host API 契约和静态校验规则属于 `protocol` 包。

### 决策 3：AgentVersion 是纯数据

同理，运行时不能部署新的 Agent 代码。AgentVersion 只包含 prompt、模型
设置、工具授权、context 策略、输出 schema 等配置数据，由一个通用
Agent Runtime 解释执行。Agent Factory 生成的是配置，不是程序。

需要真正新代码的能力（新工具、新集成）通过常规发布流程进入平台，再以
工具授权的形式提供给动态 Agent。

### 决策 4：Durable Object 持久化状态，但不等待模型调用

DO 在 await 外部 fetch 期间不可休眠，并按 wall-clock 持续计费。一次
模型调用可达分钟级。如果 Agent actor 在 DO 内直接 await 模型调用，
海量 Agent 的成本承诺会被击穿。

因此规则是：

- DO 负责身份、状态、事件日志和路由，是长时间运行工作的持久化落点。
- 模型调用和长 I/O 永远发生在 Workflow step 或 Queue consumer 中，
  结果通过回调写回 DO。
- DO 的单次操作应在毫秒级返回，使对象空闲时立刻满足休眠条件。

### 决策 5：长期任务是周期性实例，不是永生实例

Workflows 单实例有步数和状态上限。跨天、跨月的长期目标不应表达为一个
永不结束的 workflow 实例，而应表达为每个周期一个实例，由调度触发，
周期之间通过 checkpoint 和 memory 衔接。

## 调度器设计

调度器是 Orchestration Layer 的具体执行机制，由三部分组成。

### Run Coordinator：per-Run Durable Object

每个顶层 Run 对应一个 DO 实例，是这次运行的状态权威。

它持有：

- 当前 PlanVersion 引用和每个 Host 调用的状态。
- 运行事件日志，存放在 DO SQLite storage 中（单实例上限 10 GB）。
- hot context 草稿和 checkpoint 草稿。
- 预算计数器：模型花费、Agent 数量、并发额度、修订次数。

Run 结束后事件日志归档到 R2，可查询索引异步写入 D1。

### Script Runner：静态部署的通用 Workflow

一个静态部署的通用 workflow 负责执行 PlanScript，执行模型是重放加
日志（replay + journal）：

- 脚本在 QuickJS WASM 沙箱解释器中从头执行。已完成的 Host
  调用从 journal 立即返回缓存结果，执行流快进到第一个未完成的调用，
  发起它，然后挂起。
- Host 调用映射到 Workflow step：派发 AgentRun / ToolRun 是一个
  step.do 加入队；等待完成是 waitForEvent；sleep 与审批等待映射到
  对应原语。Workflows 引擎的 step 缓存即 journal，durable retry、
  长 sleep、事件等待由平台承担。
- 每次重放只消耗毫秒级 CPU，等待期间实例处于 waiting 状态，不占
  并发额度、不产生计算成本。
- Host 调用按发起顺序分配确定性 ID，并发调用的完成顺序不影响重放
  一致性。
- Host 调用的返回值一律是 ContextRef 或小型结构，大结果落 R2，避开
  step 返回值上限。
- 未捕获的脚本错误使 Run 进入失败状态，journal 即完整执行记录，作为
  重新计划或人工诊断的输入。

### Dispatcher：Queues 加通用 Agent Runtime

AgentRun 命令携带 idempotency key 进入队列，由通用 Agent Runtime
worker 消费：装载 AgentVersion、解析 ContextPackage、执行模型调用和
工具调用、产出结果与事件，写回 Run Coordinator，并向 Script Runner
回发完成事件。

并发调度发生在这一层：脚本可以一次发起大量 AgentRun，Dispatcher 按
Run 与 workspace 的并发配额放行，超出部分在队列中等待，对脚本透明。

### 定时与唤醒

- 周期性任务：Workflow 实例挂 cron，或由上一周期实例在结束前创建下
  一周期实例。
- 等待外部事件：waitForEvent，最长 365 天；等待中的实例不占并发额度。
- 大量细粒度定时：由一个 Scheduler DO 在 storage 中维护时间索引，
  多路复用 alarm（每个 DO 同时只有一个 alarm）。
- 账户级 Cron Triggers 配额有限，不按 Task 分配 cron。

## 分层设计

### 1. Interface Layer

面向用户和外部系统。

职责：

- Web UI。
- CLI。
- Public REST API。
- 后续 webhook、GitHub issue/PR、外部系统入口。

这一层不应该包含核心业务逻辑。Web UI 和 CLI 都应通过同一套公开 API 使用
Watt。

### 2. Mission Layer

负责理解用户意图，并把意图转成可执行任务。

核心对象：

- `Intent`：用户的自然语言目标或外部触发。
- `Mission`：被结构化后的长期目标、约束和成功标准。
- `Task`：一次具体工作请求。

Mission Layer 不负责实际执行。它负责说明“要完成什么、限制是什么、怎么算
完成”。

V1 边界：V1 不实现独立的 Mission 资源。长期目标先表达为带调度配置的
Task（定时触发、事件触发），Mission 在调度与记忆机制稳定后再作为正式
资源引入。

### 3. Orchestration Layer

负责编排任务执行。

核心对象：

- `Workflow`：可复用或动态生成的工作流程。
- `PlanScript / PlanVersion`：一次运行的计划脚本及其不可变版本。
- `Run`：执行实例。
- `Checkpoint`：阶段性摘要和恢复点。

Orchestration Layer 要解决：

- 任务拆解。
- Agent 选择或创建。
- 工具调用顺序。
- 重试和恢复。
- 审批等待。
- checkpoint 边界。
- 最终交付触发。

具体执行机制见前文“执行模型决策”与“调度器设计”。

### 4. Agent Layer

负责 Agent 的生命周期和运行。

它包含三块：

- `Agent Registry`：管理 Agent、AgentVersion、AgentDeployment。
- `Agent Factory`：根据 Mission 和 Context 生成新的 AgentSpec。
- `Agent Runtime`：在合适 runtime 中执行 Agent。

Agent Layer 是 Watt 的核心。Watt 不只是调用预设 Agent，而是能够大量创建临时
Agent，并把有价值的 Agent 持久化为可复用能力。

### 5. Context Layer

负责上下文的表示、传递和沉淀。

核心对象：

- `ContextPackage`：传给 Agent 的结构化上下文包。
- `ContextRef`：大型上下文、memory、artifact、repo、外部系统状态的引用。
- `Memory`：从 checkpoint 或结果中提升出来的长期知识。
- `ArtifactRef`：运行产物引用。

Context Layer 不是单纯存储层。它是 Agent 协作时的行动介质。

### 6. Integration And Delivery Layer

负责接入外部系统，并把结果交付到用户关心的地方。

它包含：

- `Integration Layer`：GitHub、搜索、文件、代码沙箱、未来支付/生活/企业系统。
- `Tool Layer`：把外部能力封装成可授权、可审计的工具。
- `Delivery Layer`：生成报告、artifact、验证摘要、通知、外部写入。

Watt 的交付结果不应该只停留在聊天回复里。结果应成为 artifact，并能被追溯、
验证和复用。

### 7. Infrastructure Adapter Layer

负责把 Watt 抽象映射到具体平台。

第一目标是 Cloudflare：

- Workers。
- Durable Objects / Agents SDK。
- D1。
- R2。
- Queues。
- Workflows。
- Containers / Sandbox。
- AI Gateway。

后续应可映射到：

- Kubernetes。
- Temporal / Argo Workflows。
- PostgreSQL / SQLite。
- Object Storage。
- Queue 系统。
- 自托管容器池。

## 逻辑服务划分

以下是服务边界，不代表第一版必须拆成独立部署单元。

### Gateway Service

统一入口。

职责：

- 处理 Web UI、CLI、REST API 请求。
- 认证和 workspace 解析。
- 请求路由。
- 基础限流。
- 返回 run 状态和 artifact 入口。

### Mission Service

把用户输入转为 Mission 和 Task。

职责：

- 保存用户目标。
- 记录约束、预算、期望输出和成功标准。
- 为 Orchestrator 提供结构化任务输入。

### Orchestrator Service

负责编排执行。

职责：

- 为 Task 创建 Run。
- 生成或选择 Workflow（PlanScript 由 Planner 产出，本服务负责校验、
  存版、启动 Script Runner）。
- 调度 AgentRun、ToolRun、WorkflowRun。
- 处理重试、取消、恢复、等待。
- 决定 checkpoint 边界。

### Agent Registry Service

管理 Agent 资源。

职责：

- 管理 Agent。
- 管理 AgentVersion。
- 管理 AgentDeployment。
- 管理 Agent visibility。
- 管理 Agent 权限和 runtime policy。

### Agent Factory Service

动态生成 Agent。

职责：

- 根据 Mission、ContextPackage、工具集合和历史 memory 判断需要哪些能力。
- 生成 AgentSpec。
- 生成临时 AgentVersion。
- 决定 Agent 是否临时、持久化、公开或复用。
- 将运行效果反馈给 Registry 和 Memory。

### Agent Runtime Service

真正执行 Agent。

职责：

- 选择 runtime target。
- 启动轻量 Agent。
- 唤醒有状态 Agent。
- 分配 Container / Sandbox 执行重任务。
- 管理 AgentRun 状态。
- 写入运行事件、checkpoint 输入和 artifact 引用。

运行形态：

- `Worker Runtime`：轻量判断、摘要、模型调用、小工具。
- `Actor Runtime`：长期可寻址 Agent、Manager、Supervisor、Memory Agent。
- `Sandbox Runtime`：代码执行、repo 操作、测试、浏览器自动化。
- `External Runtime`：未来接入 ACP 或其他外部 Agent。

### Context Service

构造和管理上下文。

职责：

- 构造 ContextPackage。
- 裁剪上下文。
- 解析 ContextRef。
- 管理 checkpoint。
- 生成 memory candidates。
- 将有效 memory 提升到长期存储。

### Integration Service

接入外部能力。

职责：

- 管理 integration 配置。
- 管理凭证和权限。
- 暴露 tools。
- 审计外部副作用。
- 将外部结果转成 context 或 artifact。

V1 参考集成是 GitHub。

#### 凭证管理

集成凭证是用户级数据，数量不定，不能放进 Worker secrets。采用信封
加密：

- 主密钥保存在 Secrets Store，只有 Integration Service 可读。
- 每个 integration 的凭证用主密钥加密后存入 D1。
- 凭证只在工具执行时解密注入，不进入 ContextPackage、日志和模型上下文。
- Sandbox 内不落明文凭证：出站流量经 outbound handler 代理并注入鉴权，
  容器内代码只看到代理后的请求。
- 每次凭证使用写入 Audit Store。

### Delivery Service

负责结果交付。

职责：

- 生成最终报告。
- 生成或发布 artifact。
- 汇总 checkpoint。
- 生成验证摘要。
- 写入 GitHub 文档或其他目标系统。
- 通知用户：Run 完成、失败和审批等待都应产生出站通知（V1 至少支持
  邮件或 webhook 之一），审批不能只依赖用户主动轮询。

### Model Gateway Service

统一模型访问。

职责：

- 调用 DeepSeek 官方 API。
- 管理 prompt prefix cache 策略。
- 记录成本、延迟、token 使用。
- 做限流和预算控制。
- 为后续模型供应商预留 adapter。

### Telemetry And Audit Service

负责可观察性和审计。

职责：

- 记录 run events。
- 记录 tool calls。
- 记录外部副作用。
- 记录模型调用。
- 记录错误、重试和恢复。
- 为 Manager 汇总状态提供依据。

平台对 Worker、Queue、Workflow、DO、Container 之间的调用没有原生分布
式追踪。trace 上下文（run_id、节点 id、父 span）必须作为协议字段进入
每条队列消息、每个 workflow step 和每次 DO 调用，由各组件透传。

## 对用户暴露什么

用户不应该直接面对底层 runtime，也不应该直接管理每个内部 AgentRun。

用户主要看到这些资源：

- `Mission`：长期目标（V1 后引入，先以带调度配置的 Task 表达）。
- `Task`：一次工作请求。
- `Run`：当前执行状态。
- `Agent`：可复用能力。
- `Session`：与某个 Agent 的直连会话（一个 Agent 可有多个）。
- `Workflow`：可复用流程。
- `Checkpoint`：阶段摘要。
- `Artifact`：交付结果。
- `Integration`：外部系统连接。

### Web UI

Web UI 应优先支持：

- 提交任务。
- 查看 Run 状态。
- 查看 checkpoint 和事件。
- 查看最终报告和 artifact。
- 浏览 Agent 注册表，选中 Agent 直接对话（多 Session 管理）。
- 管理 Agent 和 Workflow。
- 配置 GitHub 等 integration。

### CLI

CLI 应优先支持：

- 提交任务。
- 查询 run。
- 拉取 artifact。
- 列出 agent/workflow。
- 管理 integration 配置。

### Public REST API

REST API 是 Web UI 和 CLI 的共同底座。

第一版先定义资源语义，不急着细化 endpoint 和 schema。后续接口设计应从本文
的资源边界自然展开。

### 鉴权

公开 REST API 部署即公网可达，单用户也需要最小鉴权设计：

- API key 按 workspace 签发，可轮换、可吊销，服务端只存哈希。
- Web UI 会话第一版可复用 API key 机制。
- CLI 凭证保存在本地配置文件，只通过 HTTPS 发送。
- 所有 key 带 workspace 作用域，为后续多租户铺路。

## 存储设计

Watt 的存储应按语义拆分，而不是只放进一个数据库。

### Registry Store

存储稳定资源定义：

- Workspace。
- Agent。
- AgentVersion。
- AgentDeployment。
- Workflow。
- Tool。
- Integration。

### Run Store

存储执行状态：

- Mission。
- Task。
- Run。
- PlanVersion 索引（脚本本体在 Artifact Store）。
- AgentRun。
- ToolRun。
- WorkflowRun。
- retry / cancel / failure state。

### Hot Context Store

存储当前活跃运行需要的上下文：

- 当前计划。
- 最近状态。
- 活动消息。
- 临时摘要。
- checkpoint 草稿。

这类状态适合靠近 Agent Runtime。

### Memory Store

存储长期可复用知识：

- 从 checkpoint 提升的 memory。
- 项目偏好。
- 用户偏好。
- 任务经验。
- 可检索摘要。

Memory 不应等于完整日志。Memory 应该是被筛选、可复用、可检索的知识。

### Artifact Store

存储运行产物：

- Markdown 报告。
- 代码 patch。
- 日志。
- 测试结果。
- 截图。
- 大型上下文文件。
- GitHub 写入结果引用。

### Audit Store

存储审计信息：

- 工具调用。
- 外部系统写入。
- 凭证使用。
- 模型调用。
- 成本和限流。
- 审批记录。

### Cloudflare 存储映射

第一版 Cloudflare 映射可以是：

- D1：Registry Store、Run index、Workflow metadata。按 workspace 拆库：
  一个 workspace 一个 D1 库。D1 单库是单写线程且有容量上限，按
  workspace 拆既避免全局瓶颈，也与 workspace 边界天然对齐。
- Durable Objects storage：per-Run 事件日志与节点状态（Run
  Coordinator）、per-Agent hot context、Manager state。
- R2：Artifact Store、大型日志、大型上下文、Run 事件归档、快照。
- Vectorize / search layer：Memory Store 的检索层。
- Queues / Workflows state：异步命令和长任务状态。

状态权威：执行期间 Run 状态以 Run Coordinator（DO）为权威，Workflows
实例负责驱动推进，D1 中的 Run index 是异步更新的查询投影。高频 run
events 不直接写 D1。跨 Run 的指针索引存在一个可对照备选：单例
Registry DO 承担热路径强一致查找，D1 投影承担分析查询，两者可混合
（见 `docs/flue-reference.md`）。

## 交付设计

Watt 的交付不是“最后回复一段话”。

每次重要 Run 完成后，Delivery Service 应产出四类结果：

### Final Report

给用户看的自然语言报告。

应包含：

- 做了什么。
- 产出了什么。
- 结果在哪里。
- 哪些部分已验证。
- 哪些风险或不确定性仍存在。

### Artifact

可持久访问的结果。

示例：

- GitHub 中的 Markdown 文档。
- issue。
- PR。
- 代码 patch。
- 测试日志。
- 研究资料包。

### Verification Summary

说明结果如何验证。

验证必须区分两类：

- 机械验证：由代码执行、结果可判定。例如 artifact 已写入 GitHub（API
  回读确认 commit 存在）、链接可达、测试退出码为 0、输出符合声明的
  schema。输出 schema 校验的参考机制是注入式 finish / give_up 工具：
  校验在工具执行内进行，通过才终止循环，失败有显式投降路径
  （见 `docs/flue-reference.md`）。
- 模型自述：Agent 总结自己做了什么、读了什么来源。只能作为参考，不算
  验证。

V1 要求每个交付型节点至少声明一项机械验证。Verification Summary 应
列出：

- 执行了哪些机械验证，结果如何。
- 读取了哪些来源。
- 哪些验证未执行。
- 哪些结论需要人工确认。

### Memory Candidates

从本次任务中提取可进入长期记忆的内容。

这些内容不应自动全部进入 Memory Store。V1 的提升机制：候选由
Manager（模型驱动）评估并决定是否提升为 persistent memory，每次
提升写入 Audit Store 并可由用户回滚；用户也可手动提升或删除。
Manager 误判会污染后续任务上下文，因此提升记录必须可审计、可撤销。

## 通信设计

Watt 的通信不应以自然语言 A2A 为默认协议。

### 用户到 Watt

用户通过 Web UI、CLI 或 REST API 提交任务、查看状态、读取结果。

进度更新第一版可以使用轮询式资源查询。后续可以加入 SSE 或 WebSocket，但
实时通道不是第一版协议核心。

### 用户到 Agent：直连会话

用户可以在管理 UI 或 CLI 中浏览 Agent 注册表，选中一个 Agent 直接
对话。这是 Task / Run 之外的第二条用户路径。

- `Session` 是用户可见资源：一个 Agent 可同时持有多个 Session，
  每个 Session 有独立历史和 hot context。
- 会话交互不是 Run：没有 PlanScript、没有 run id、不进入 Run
  Store、不出现在 Run 列表。这条边界必须结构性强制（ID 语法区分、
  事件字段 `run_id` 与 `session_id` 互斥），不能靠约定。参考 flue
  的 runs-vs-sessions 不变量（`docs/flue-reference.md`）。
- 执行路径不破坏决策 4：会话状态住在 per-Agent actor（DO），模型
  调用发生在无状态 Worker 的请求上下文中——Workers 按 CPU 计费，
  await 模型期间的 wall-clock 等待近乎免费；DO 只做毫秒级状态
  读写。
- 同一 Session 内操作单飞（single-flight）：并行对话开新 Session。
- 会话中的工具调用与模型调用走同一套预算、成本与审计记账。
- V1 会话回复用同步请求-响应（单轮完整返回），不做流式。

### 服务到服务

内部服务通过资源事件和状态变化协作。

典型通信方式：

- 同步查询：读取 registry、run state、context refs。
- 异步命令：提交 AgentRun、ToolRun、Workflow step。
- 事件流：记录 run events、tool events、delivery events。
- 状态机：通过 PlanScript 重放和 checkpoint 推进任务。

### Orchestrator 到 Agent

Orchestrator 不应该只给 Agent 发自然语言。

它应传递：

```text
Command
ContextPackage
ExpectedOutput
PermissionScope
RuntimePolicy
CheckpointPolicy
```

### Agent 到 Agent

Agent 之间默认不直接自由聊天。

Agent 协作通过三种方式发生：

- 共享 ContextRef。
- 产出 Artifact。
- 更新 Run / Checkpoint 状态。

如果确实需要 Agent 之间协商，应由 Orchestrator 或 Manager 形成结构化交互，
并体现在 PlanScript 的调用结构和 journal 中。

### 幂等与恢复

所有异步命令都应假设可能重复投递。

因此：

- Command 需要 idempotency key。
- ToolRun 需要可查询状态。
- 外部副作用需要审计记录。
- checkpoint 写入应可重复检测。
- Delivery 操作需要避免重复发布。

## 动态生成 Agent

动态生成 Agent 是 Watt 区别于传统自动化系统的关键能力。

### 输入

Agent Factory 接收：

- Mission。
- Task。
- ContextPackage。
- 可用 Tool 列表。
- Integration 权限。
- 历史 Memory。
- 交付目标。
- 成本和时间限制。

### 输出

Agent Factory 生成 AgentSpec。

AgentSpec 应描述：

- 职责。
- 输入契约。
- 输出契约。
- 工具权限。
- Context 权限。
- Runtime target。
- Checkpoint 规则。
- 验证方式。
- 生命周期策略。

V1 边界：AgentSpec 先取 6 字段最小集（职责 prompt、输出 schema、
工具授权、模型设置、runtime target、生命周期策略），其余字段在
真实任务跑通后再引入。

### 生命周期

动态 Agent 的生命周期：

```text
Need
  -> AgentSpec Draft
  -> Policy Check
  -> AgentVersion
  -> Temporary Deployment
  -> AgentRun
  -> Checkpoint / Artifact
  -> Evaluate
  -> Promote / Reuse / Delete
```

### 持久化判断

一个临时 Agent 是否值得持久化，可以根据：

- 是否解决了重复问题。
- 是否产出稳定结果。
- 是否具备清晰输入输出。
- 是否工具权限可控。
- 是否能被其他 Workflow 复用。
- 是否通过用户或 Manager 的认可。

## 预算与失控防护

Agent Factory 加上 Agent 创建子 Agent 的能力构成递归结构，必须有硬性
配额兜底，而不能只靠提示词约束。防护分四层，全部由确定性代码执行：

- 脚本层：PlanScript 解释器的指令级 gas 计量和单次重放 wall-clock
  超时，防死循环；沙箱内没有原生时间、随机数和网络。
- Host 调用层：每次 spawn / run / invoke 前检查 Run Coordinator 的
  预算计数器——模型花费上限、Agent 数量上限、并发额度、单调用超时
  与重试上限。
- 计划层：每个 Run 的 PlanVersion 修订次数上限（防计划修订风暴）；
  计划禁止嵌套生成计划。
- 平台层：Workflow step 数、CPU 时间等平台上限作为最终兜底；
  workspace 级并发 Run 上限和月度预算。

并发上限的设计原则：上限尽可能大，瓶颈放在调度而不是表达能力上。
脚本可以一次发起数百个调用，Dispatcher 按配额放行、其余排队；真正的
约束是预算（花费）而不是并发数本身。

执行点：

- per-Run 预算由 Run Coordinator 在派发前检查，Model Gateway 在模型
  调用前二次检查。
- AI Gateway 的 spend limits 每网关最多 20 条规则，只承担账户和
  workspace 级兜底；per-Run 预算必须由 Watt 自己的 Model Gateway
  Service 实现。

成本是 V1 的一等公民字段：每次模型调用和工具调用记录成本，逐级汇总到
AgentRun、Run、Task 和 workspace。运营侧的预算控制、成本看板和
“某个 Agent 是否值得持久化”的判断都建立在这之上。

## Cloudflare 参考运行架构

Cloudflare 是第一版最自然的 runtime。

### 轻量 Agent

运行在 Worker。

适合：

- 简单模型调用。
- D1 查询。
- checkpoint 摘要。
- 小型工具编排。
- ContextPackage 构造。

### 长期 Agent

运行在 Durable Objects / Agents SDK。

适合：

- Manager。
- Runtime Supervisor。
- Memory Agent。
- 长期等待外部事件的 Agent。
- 保存 per-Agent hot context。

受执行模型决策 4 约束：这些 actor 持久化状态、路由事件，但不在请求
路径上 await 模型调用，模型调用转交 Workflow step 或 Queue consumer。

### 重型 Agent

运行在 Containers / Sandbox。

适合：

- repo 操作。
- 测试。
- 构建。
- 浏览器自动化。
- 大型文件处理。
- Code Engine。

出站控制从 V1 开始提供：容器关闭直接外网访问，出站流量经 Worker 层
outbound handler 代理，在代理层做白名单和凭证注入。平台原生支持这套
机制，没有理由推迟。注意容器出站流量单独计费，浏览器自动化类任务的
流量成本应计入 Run 成本。

### 长任务

运行在 Workflows。

适合：

- 跨分钟、小时、天的任务。
- 等待用户审批。
- 等待外部系统。
- durable retry。
- 定时唤醒。

### 异步削峰

使用 Queues。

适合：

- AgentRun 排队。
- ToolRun 排队。
- 大量临时 Agent 创建。
- 外部写入削峰。

## Kubernetes 或其他平台映射

同一架构可以迁移到其他平台。

可能映射：

- Gateway Service -> API Gateway / Ingress。
- Mission / Orchestrator -> Controller Service。
- Agent Runtime -> Worker Service / Job / Pod。
- Sandbox Runtime -> Kubernetes Job / isolated container。
- Workflow Engine -> Temporal / Argo Workflows。
- Registry Store -> PostgreSQL / SQLite。
- Artifact Store -> S3-compatible object storage。
- Queue -> Redis / SQS / NATS / Kafka。
- Model Gateway -> 自建模型代理或第三方网关。

关键是保持 Watt 的资源语义不变：平台只是 adapter。

## Monorepo 建议

第一版适合 monorepo。

可能结构：

```text
apps/
  web/
  cli/
  api-worker/

packages/
  protocol/
  plan-script/
  sdk/
  mission/
  orchestrator/
  agent-registry/
  agent-factory/
  runtime-core/
  runtime-worker/
  runtime-actor/
  runtime-sandbox/
  context/
  delivery/
  integrations-github/
  model-deepseek/
  telemetry/

docs/
  vision.md
  architecture.md
```

其中：

- `protocol` 定义平台无关资源和事件。
- `plan-script` 定义 PlanScript 的 Host API 契约、语法子集、静态校验
  和解释器封装。
- `runtime-core` 定义 Agent Runtime 抽象。
- `runtime-worker`、`runtime-actor`、`runtime-sandbox` 是具体 runtime adapter。
- `integrations-*` 封装外部系统。
- `apps/*` 只负责用户入口。

## V1 建议切片

第一版可以先实现最小闭环：

1. Web UI / CLI / REST API 提交 Task。
2. Mission Service 生成 Mission。
3. Orchestrator 校验 PlanScript（第一刀用手写脚本，第二刀接 Planner
   生成），启动 Script Runner。
4. Agent Factory 生成或选择 Research Agent 和 Reporter Agent。
5. Context Service 构造 ContextPackage。
6. Agent Runtime 执行轻量调研和报告生成。
7. GitHub Integration 写入 Markdown artifact。
8. Delivery Service 返回最终报告。
9. Checkpoint 写入本次任务摘要和 memory candidates。
10. 管理 UI 支持浏览 Agent 注册表并直连对话（一个 Agent 多个
    Session）。

这个闭环可以验证：

- Agent 是否能动态生成。
- Context 是否能协议化传递。
- Run 是否可观察。
- Artifact 是否能交付。
- GitHub 是否能作为第一集成落地。
- Cloudflare 是否能支撑低成本运行。
- 用户是否能与持久 Agent 直接对话。

## 暂不设计的内容

本文暂不设计：

- 详细 REST endpoint。
- 具体数据库 schema。
- UI 页面结构。
- Agent prompt 模板。
- GitHub App / PAT 的具体权限配置。
- 企业多租户权限模型。
- 外部 Agent 协议细节。

这些应在架构边界稳定后再进入下一轮 RFC。

## 仍需确认的问题

- Workflows 单实例内多个并发 waitForEvent 的行为需实现前验证。
- AgentSpec / ContextPackage 最小字段集的具体 schema 草稿待起草后
  评审（字段范围已定，见下）。

已有结论的问题：

- PlanScript 解释器选 QuickJS WASM，不用 Dynamic Worker Loaders。
  理由：确定性可控、指令级 gas 计量、平台无关；Dynamic Workers
  截至 2026-06 仍 open beta 且按独立 Worker 数计费。
- Workflow 资源 V1 不引入、不版本化。PlanVersion 本身不可变即已
  版本化；可复用流程先表达为可复用的 PlanScript 模板，等真实复用
  需求出现再正式化 Workflow 资源（与 Mission 的推迟逻辑一致）。
- Planner 重新计划只由白名单硬事件触发：节点失败且重试耗尽、用户
  追加或修改要求、审批被拒。"结果不符合预期"只能经失败传播（如
  schema 校验不过）进入失败路径，不能直接触发；修订次数上限兜底。
- Host API V1 函数集为 8 个：run / invoke / spawn / checkpoint /
  approval / sleep / waitFor / artifact。后续只加不改。
- AgentSpec V1 取 6 字段：职责 prompt、输出 schema、工具授权、模型
  设置、runtime target、生命周期策略。ContextPackage V1 取 5 字段：
  目标、输入 refs、预算限制、期望输出、权限范围。其余字段
  （checkpoint 规则、验证方式、敏感级别、有效期等）推迟。
- Checkpoint 提升为 Memory 由 Manager（模型驱动）评估决定，每次
  提升写 Audit Store、可回滚；用户可手动提升或删除。
- V1 GitHub artifact 写入 workspace 配置的专用 artifact repo，路径
  `runs/<YYYY-MM-DD>-<task-slug>/<file>`，不与用户代码 repo 混写。
- Agent Runtime 全自研：自写 turn loop 与薄模型层（DeepSeek 为
  OpenAI 兼容协议，单供应商时模型层很薄），不依赖 Flue / pi-agent-core /
  Vercel AI SDK。理由：决策 4 强制的执行形状（模型调用在 Queue
  consumer、结果回写 Run Coordinator）市面框架都不提供，外购只能覆盖
  约四分之一工作量；现成框架的 Cloudflare 落地层与决策 4 冲突。
  执行形状：一次 AgentRun 的完整 loop 在单个 Queue consumer 调用内
  跑完（wall-time 上限 15 分钟），turn 边界写 checkpoint 仅用于故障
  恢复，超长 AgentRun 用 re-enqueue 续跑，不做跨 step 可重入状态机。
  选型分析与可借鉴设计见 `docs/flue-reference.md`。
- 进度更新 V1 用分页轮询，不做 SSE / WebSocket。标准 WebSocket 还会
  阻止 DO 休眠、增加成本。
- Sandbox 出站白名单和凭证代理 V1 就做，平台原生支持。
- Mission 资源 V1 不实现，先用带调度配置的 Task 表达。
- 计划形态是 PlanScript（确定性受限脚本），不是声明式 JSON 图。
- 计划禁止嵌套生成计划。
- 并发由 Host 配额调度，不在语言层限制；上限尽可能大。
- approval 等待必须伴随至少一条出站通知（V1 至少邮件或 webhook 之一），
  不能只依赖用户主动轮询。

## 附录：Cloudflare 关键平台约束

以下是本设计依赖的平台事实，核实于 2026-06 的官方文档。数字会随平台
演进变化，实现前应复核。

- Durable Objects：await 外部 fetch 期间不可休眠并按 wall-clock 计费；
  每对象同时仅 1 个 alarm；SQLite storage 每对象 10 GB；单对象吞吐
  软上限约 1,000 请求/秒。
- Workflows：定义为部署时静态代码，运行时只能创建实例；Paid 单实例
  默认 10,000 步（可配至 25,000）；step 返回值上限 1 MiB，单实例状态
  上限 1 GB；sleep 和 waitForEvent 最长 365 天；waiting / sleeping
  实例不占并发额度。
- D1：单库上限 10 GB（不可提升），单写线程；Paid 每账户 50,000 个库；
  batch 即事务；读复制仍为 beta。
- Queues：消息上限 128 KB；单队列 5,000 msg/s；at-least-once 投递；
  消费者 wall-time 上限 15 分钟。
- Workers：Paid CPU 默认 30 秒，可配至 5 分钟；HTTP 请求 wall-clock
  无硬上限；内存 128 MB。
- Containers：已 GA；最大实例 4 vCPU / 12 GiB 内存 / 20 GB 磁盘；
  冷启动 1–3 秒；支持 enableInternet=false 与 outbound handler；出站
  流量按区域单独计费；不能直接从公网接收入站请求。
- AI Gateway：支持 DeepSeek；spend limits 每网关最多 20 条规则；支持
  BYOK、日志、缓存、按 metadata 维度统计。
- Cron Triggers：账户级配额（Paid 250 个），不是按 Worker 分配。

