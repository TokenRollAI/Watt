#  Watt

Watt是一个面向个人自动化的 Agent 控制平面。

它的目标不是先做一个单一的 Agent 应用，而是先定义一套稳定的 Agent
资源模型、运行协议和对外 API。用户可以从 Web UI、CLI 或统一 REST API
提交任务，系统根据任务动态创建或复用 Agent Team，持续观察运行状态，沉淀
上下文记忆，并最终产出可验证的报告或工件。

第一版先聚焦架构与协议设计，不急于实现完整运行时代码。

## 愿景

Watt把 Agent 当成一种可以管理的资源。

Agent 不是一次聊天，也不一定是一个持续占用 CPU 的常驻进程。它更像一个有
稳定职责、稳定输入输出、可版本化、可回滚、可部署、可观察、可持久化上下文
的能力单元。

理想状态下，Watt应该做到：

- 成本低：空闲 Agent 不应该持续消耗计算资源。
- 不掉线：Agent 的身份、状态、上下文和任务进度应长期可寻址、可恢复。
- 能完成任务：系统以 Task、Workflow、Run、Checkpoint、Artifact 管理工作，
  而不是依赖不可控的自然语言聊天记录。
- 可验证：每次运行完成后都应产出清晰报告、结果工件和可追溯摘要。
- 可扩展：第一落点是 Cloudflare，但核心协议应能迁移到 Kubernetes 或其他
  runtime。

## 要解决的问题

### Agent 缺少稳定控制面

很多 Agent 系统从对话循环开始，这适合单个助手，但不适合长期运行和复杂
编排。Watt从资源模型开始：Agent、Workflow、Task、Run、Context、
Checkpoint、Artifact、Tool 和 Integration。

### Agent Team 不能写死

Agent Team 应该根据任务动态生成。Manager 可以为某个任务创建临时 Agent，
也可以把有价值的 Agent 持久化，甚至在未来把它公开为 workspace 或 global
级别的能力。

### 长期记忆不能变成日志垃圾堆

第一版不追求完整 replay。更重要的是每个任务或阶段结束后写入结构化
checkpoint：做了什么、改了什么、产出了什么、哪些内容值得进入 memory。

### Cloudflare 是首选实现，不是架构锁定

Cloudflare Workers、Durable Objects、D1、R2、Queues、Workflows、
Containers 和 AI Gateway 很适合Watt的第一版实现。但Watt的核心抽象不应
绑定 Cloudflare。Cloudflare 应该是 reference runtime adapter，而不是整个
产品本身。

## V1 范围

第一版应包含：

- Web UI 和 CLI。
- Web UI、CLI 共用同一套公开 REST API。
- 单用户优先，但所有资源预留 workspace / namespace 边界。
- 版本化 Agent 资源模型。
- 可复用 Workflow 和 Manager 动态生成 Workflow。
- Manager 负责用户沟通、状态汇报、后台观察和任务协调。
- 基于 checkpoint 的上下文回溯和 memory 候选沉淀。
- 默认只接入 DeepSeek 官方 API。
- 以 GitHub 作为第一类参考集成，用于调研结果、架构文档和任务报告落地。

第一版暂不追求：

- 完整企业多租户权限系统。
- 所有外部系统集成。
- 完整 GitHub Issue / PR / webhook 接入。
- 编排 Codex、Claude Code、OpenCode 等外部 Agent。
- 完整 Kubernetes 替代品。

这些可以作为后续阶段演进。

## 核心资源模型

### Workspace

Workspace 是顶层命名空间。

V1 可以先服务个人用户，但每个资源都应带上 workspace 边界，方便后续支持
团队、企业、部门、员工权限和 global 级资源。

### Agent

Agent 是一个逻辑能力。

Agent 的职责应该保持稳定。它可以升级实现、调整提示词、替换工具或切换运行
策略，但它负责的事情、输入契约和输出契约应尽可能稳定。

示例：

- Research Agent
- GitHub Reporter Agent
- Code Engine Agent
- Memory Curator Agent
- Runtime Supervisor Agent

Agent 应包含：

- 身份：id、name、namespace、visibility。
- 职责：它负责完成什么。
- 输入契约：它接受什么请求。
- 输出契约：它应该产出什么结果。
- Context 策略：它能读取、写入、记忆和遗忘什么。
- Tool 策略：它能使用哪些工具和集成。
- Runtime 策略：它可以运行在哪里、如何运行。

### AgentVersion

AgentVersion 是 Agent 实现的不可变快照。

它可以包含：

- prompt / system instructions
- tools
- model settings
- runtime settings
- context policy
- output schema
- permission policy

每个 Run 都应该记录自己使用的具体 AgentVersion。这样以后即使 Agent 升级，
历史任务仍能知道当时到底用了哪个版本。

### AgentDeployment

AgentDeployment 是从 Agent 到某个 AgentVersion 的可变指针。

它类似 Deployment：Agent 的职责不变，但实现可以升级、回滚、灰度或切换
channel。

常见 channel：

- `draft`
- `stable`
- `experimental`
- `global`

这样可以表达：

- 当前稳定版本是什么。
- 某个版本是否对外公开。
- 是否允许回滚。
- 某次运行到底绑定哪个版本。

### Task

Task 是用户或系统提交的工作请求。

Task 表达意图，不一定表达完整执行计划。Manager 可以把一个 Task 转换成一个
WorkflowRun，再拆出多个 AgentRun 或工具调用。

示例：

- 调研一个主题并写入 GitHub 仓库中的 Markdown 文档。
- 总结昨天的操作并生成 memory。
- 读取一个 repo，给出架构理解和后续实现计划。

### Workflow

Workflow 是完成任务的可复用或动态生成的编排方案。

Workflow 有两类：

- 用户定义 Workflow：由用户显式创建、编辑、复用。
- Manager 生成 Workflow：由 Manager 为某个 Task 动态生成，必要时可保存为
  可复用 Workflow。

Workflow 可以：

- 调用 Agent。
- 使用工具。
- 读取或写入 Context。
- 等待用户确认。
- 写入 Checkpoint。
- 发布 Artifact。
- 创建子 Workflow 或子 Agent。

Workflow 本身也应该考虑版本化，但 V1 可以先把重点放在 AgentVersion 和
Run 记录上。

### Run

Run 是一次执行实例。

Run 是系统的主要观察对象。一个 Task 可以创建一个顶层 Run；顶层 Run 内部可
以包含 WorkflowRun、AgentRun、ToolRun 等子运行。

Run 应暴露：

- 当前状态。
- 使用的 Agent / Workflow / Version。
- 开始和结束时间。
- 输入快照。
- 输出快照。
- Checkpoints。
- Artifacts。
- 错误和恢复状态。
- 成本统计：模型调用、工具调用和运行资源的累计成本。

### Context

Context 是 Agent 可使用的结构化上下文和工作材料。

V1 可以分为：

- Hot Context：当前任务状态、近期消息、当前计划、临时摘要。
- Persistent Context：稳定 memory、任务摘要、项目笔记、可复用知识。
- Artifact Context：报告、日志、代码变更、截图、文件等大体积产物。
- Integration Context：从 GitHub 或未来其他集成拉取的外部状态。

Context 不是简单的聊天历史。它应支持被 Agent、Workflow、Checkpoint 和
Integration 以协议化方式读写。

### Checkpoint

Checkpoint 是一次有意义工作完成后的轻量摘要。

V1 不需要主观评分，也不需要复杂质量判断。第一版只需要在运行结束或阶段结束
时，让 Agent 额外总结：

> 这段时间做了什么？改变了什么？产出了什么？哪些内容应该被记住？

最小字段：

- `id`
- `workspace_id`
- `run_id`
- `agent_id` 或 `workflow_id`
- `summary`
- `changes`
- `artifacts`
- `memory_candidates`
- `next_steps`
- `created_at`

后续可以再加入验证状态、引用来源、成本、工具调用统计等字段。

### Artifact

Artifact 是一次运行产生的持久结果。

示例：

- Markdown 调研报告。
- 架构设计文档。
- GitHub issue。
- GitHub pull request。
- 代码 patch。
- 测试日志。
- 决策记录。

Artifact 应能从 Run 和 Checkpoint 追溯。

### Tool 与 Integration

Tool 是可执行能力。

Integration 是对外部系统的配置化连接，例如 GitHub、搜索、支付、生活服务、
企业系统或未来的外部 Agent 协议。

GitHub 是 V1 的参考集成，但不能污染核心架构。它应作为 Integration Layer 的
第一个实现，用来验证Watt的任务、上下文、工件和报告协议是否成立。

## Manager 模型

Manager 可以先实现为一个 Agent，但职责上应拆成两个部分。

### User-Facing Manager

负责和用户对话、汇报状态、解释进展、请求澄清、展示最终结果。

### Runtime Supervisor

负责后台观察运行状态、协调 Workflow、创建或复用 Agent、触发 Checkpoint、
处理失败恢复。

调度执行部分应由确定性代码实现，模型只负责生成和修订计划。详见
`docs/architecture.md` 的“执行模型决策”。

第一版可以把二者放在同一个 Manager 中，但协议层要保留这两个责任边界。

## 通信模型

Watt不应默认使用自然语言 Agent-to-Agent 聊天作为内部协议。

公共接口应优先使用 RESTful API。内部运行时可以使用平台原生机制，但它们应
实现同一套资源语义。

核心操作包括：

- 创建或更新 Agent。
- 创建 AgentVersion。
- 部署或回滚 AgentDeployment。
- 提交 Task。
- 启动 WorkflowRun。
- 查询 Run 状态。
- 追加 Context。
- 写入 Checkpoint。
- 发布 Artifact。
- 取消或重试 Run。

V1 不要求 WebSocket。进度更新可以先用轮询式 REST 资源表达，例如查询
`/runs/{id}` 和 `/runs/{id}/events`。后续如果需要更实时的体验，可以再考虑
SSE 或 WebSocket，但不应让它成为第一版协议的核心。

## REST API 草案

精确 schema 可以后续演进，但资源边界应先稳定。

```text
GET    /v1/workspaces
POST   /v1/workspaces

GET    /v1/agents
POST   /v1/agents
GET    /v1/agents/{agent_id}
PATCH  /v1/agents/{agent_id}

GET    /v1/agents/{agent_id}/versions
POST   /v1/agents/{agent_id}/versions
GET    /v1/agents/{agent_id}/versions/{version_id}

GET    /v1/agent-deployments
POST   /v1/agent-deployments
PATCH  /v1/agent-deployments/{deployment_id}

GET    /v1/workflows
POST   /v1/workflows
GET    /v1/workflows/{workflow_id}
PATCH  /v1/workflows/{workflow_id}

POST   /v1/tasks
GET    /v1/tasks/{task_id}

POST   /v1/runs
GET    /v1/runs/{run_id}
GET    /v1/runs/{run_id}/events
POST   /v1/runs/{run_id}/cancel
POST   /v1/runs/{run_id}/retry

GET    /v1/runs/{run_id}/checkpoints
POST   /v1/runs/{run_id}/checkpoints

GET    /v1/artifacts
POST   /v1/artifacts
GET    /v1/artifacts/{artifact_id}

GET    /v1/integrations
POST   /v1/integrations
GET    /v1/tools
POST   /v1/tools
```

## Runtime 抽象

Watt应先定义 runtime-neutral interface，再绑定到具体平台。

### Control Plane

负责资源定义、公开 API、registry、策略、deployment、run state。

### Agent Runtime

负责执行 Agent 逻辑、调用模型、应用工具策略、读写上下文。

### Workflow Engine

负责执行用户定义或 Manager 动态生成的 Workflow，处理重试、等待、审批、
子运行和 checkpoint 边界。

### Context Store

负责热状态、持久 memory、artifact、大体积上下文和可搜索摘要。

### Sandbox Runtime

负责隔离执行不可信代码、shell、repo 操作、测试和重工具任务。

沙箱不应暴露公网入站端口。外部系统不能直接访问沙箱。出站权限控制和
凭证代理从 V1 开始提供：沙箱关闭直接外网访问，出站流量经代理层做白
名单过滤和凭证注入，沙箱内不落明文凭证，所有出站副作用写入审计日志。

### Integration Layer

负责把外部系统封装为工具能力，并明确权限、凭证、审计和上下文边界。

### Model Provider

负责模型路由、成本记录、延迟记录、缓存行为、预算和限流。

## Cloudflare 参考实现

Cloudflare 是第一版首选落地目标。

映射关系：

- Workers：REST API gateway、认证、路由、Web UI / CLI 后端。
- Durable Objects / Agents SDK：可寻址 Agent actor、Manager 状态、Hot
  Context、单 Agent 运行状态。
- D1：workspace registry、Agent registry、Workflow registry、deployment
  记录、run index。
- R2：artifact、日志、报告、大型上下文文件、快照。
- Queues：异步命令、削峰、可重试任务。
- Workflows：长时间多步骤任务、审批等待、sleep、durable retry。
- Containers / Sandbox：代码执行、repo 操作、测试、浏览器或 shell 任务。
- AI Gateway：DeepSeek 路由、请求日志、预算、限流。

Cloudflare 内部可以使用 Durable Object stub、Queues 或其他平台原生通信方式，
但对外仍应保持同一套 REST 资源模型。

## Kubernetes 与其他平台映射

同一套模型应能迁移到其他平台。

可能的 Kubernetes 映射：

- API Gateway / Ingress：公开 REST API。
- Controller Service：控制面和 reconciliation loop。
- PostgreSQL / SQLite Service：registry、run、workflow metadata。
- Object Storage：artifact 和大型 context。
- Queue System：命令投递、重试、削峰。
- Jobs / Pods：沙箱执行。
- Workflow Engine：Temporal、Argo Workflows 或自研 runner。
- Secrets Manager：集成凭证和模型密钥。

在这个映射中，AgentDeployment 可以变成 controller 管理的资源，Run 可以变成
被持续 reconcile 的执行记录。

## 模型策略

V1 默认只使用 DeepSeek 官方 API。

运行时应针对 prefix cache 优化：

- 静态 system instructions、工具契约、Agent policy 放在 prompt 前部。
- 动态任务状态、近期上下文、用户输入放在后部。
- 避免把时间戳、随机 id、短期变量放进稳定前缀。
- 如果 provider 暴露缓存行为，应记录 cache hit、成本和延迟。

其他模型供应商可以通过 Model Provider 接口后续接入，但 V1 不需要兼容
Anthropic、OpenAI 或多模型 parity。

## GitHub 参考场景

V1 可以用 GitHub 验证Watt的核心协议。

一个最小闭环：

1. 用户通过 Web UI 或 CLI 提交调研任务。
2. Manager 选择或生成 Research Workflow。
3. Manager 创建或复用 Research Agent 和 GitHub Reporter Agent。
4. Research Agent 使用被授权的工具进行网络调研。
5. Runtime Supervisor 在阶段结束时写入 Checkpoint。
6. GitHub Reporter Agent 把 Markdown 调研报告或架构设计文档写入仓库。
7. Manager 返回最终报告，包含 artifact 链接、执行摘要和验证结果。

GitHub Issue、PR、webhook、自动化 code review 等可以作为后续阶段能力，不是
第一版协议设计的前置条件。

## 仍需确认的问题

- GitHub 自动写入时，哪些操作需要审批，哪些可以默认自动执行？
- Agent visibility 如何区分 private、workspace、global？

已有结论（详见 `docs/architecture.md` 与 `docs/protocol-v1.md`）：

- `/runs/{id}/events` 第一版做分页事件日志，不做 SSE。
- Workflow 资源 V1 不引入；PlanVersion 不可变即已版本化。
- GitHub V1 artifact 写入 workspace 配置的专用 artifact repo，路径
  `runs/<YYYY-MM-DD>-<task-slug>/<file>`。
- Checkpoint 的 memory candidates 由 Manager 评估提升，写审计、可
  回滚，用户可手动干预。
- Agent Runtime 全自研；协议契约已落地为 `packages/protocol`。
- 用户可与 Agent 直连对话：Session 是一等资源，一个 Agent 多个
  Session；会话不是 Run。

## 当前进度

- `docs/`：愿景、架构、协议 V1、Flue 调研笔记，均已定稿。
- `packages/protocol`：ID 语法、AgentSpec、ContextPackage、Host API
  契约、Session、事件 schema（zod），含单测。

```sh
pnpm install
pnpm test
pnpm typecheck
```
