# Architecture

> 本文定义 Watt 的完整架构：分层、每个 Module 的职责与边界、Cloudflare 上的落地映射，以及模块间的协作方式。所有接口的完整定义见 [Proto.md](./Proto.md)；本文只列出每个模块**必要的接口面**。

## 0. 总览

```
                        ┌──────────────────────────────────────────────┐
   飞书 / 钉钉 / Slack   │              Management Plane                │
   Webhook / Email  ──▶ │   Dashboard ←──同一套接口──→ Manage Agents     │
   Cron / Agent         └──────────────┬───────────────────────────────┘
        │                              │ (管理调用)
        ▼                              ▼
┌───────────────┐   Event   ┌─────────────────────┐
│ Event Gateway │ ────────▶ │    Agent Runtime    │◀── MCP / HTBP / HTTP ── 外部 Agent
│  (Channels)   │ ◀──────── │  (DO / Container)   │
└───────────────┘  出站消息  └──────┬──────┬───────┘
        ▲                          │      │
        │                    ┌─────▼──┐ ┌─▼───────┐     ┌──────────────┐
   ┌────┴─────┐              │Context │ │  Tool   │ ──▶ │ 上游 MCP/HTTP │
   │Scheduler │              │ Layer  │ │  Layer  │     │   工具源      │
   └──────────┘              └────────┘ └─────────┘     └──────────────┘
        横切：Auth（所有调用点） · Observability（所有模块） · Model Provider（LLM 流量）
```

**分层原则**：每一层由一组**纯接口（pure interface）**定义；层内实现（内置的或 Plugin 的）都只是接口的 Provider。层与层之间只通过接口交互，接口之外不存在旁路。

**两个全局模式**：

- **三大 Registry**：平台的三类核心对象各有一个一等注册表——`AgentRegistry`（M2，管 AgentDefinition）、`ToolRegistry`（M4，管 ToolMount）、`ContextRegistry`（M3，管 NamespaceMount）——全部遵循统一的 `List / Get / Write / Update` 四动词（Proto §0.4）；其余配置类注册表（ChannelRegistry、PolicyStore、Scheduler、ModelProviderRegistry、PluginRegistry）同构。
- **单一 HTBP 消费面**：Agent 对平台的全部消费（工具、Context、平台能力）收敛为一棵 HTBP 树（`/htbp/tools/...`、`/htbp/context/...`、`/htbp/platform/...`），由 Tool Gateway（tool-bridge）统一服务——Tool Layer 与 Context Layer 的 Agent 访问面**融入 HTBP**，而非各自另设协议（Proto §11.3）。

**模块清单**：

| # | Module | 一句话职责 | Cloudflare 落地 |
|---|---|---|---|
| M1 | Event Gateway | 事件的统一入口/出口与路由 | Worker + Channel DO + Queues |
| M2 | Agent Runtime | Agent 实例的生命周期、派生、协议接入 | Agents SDK (DO) + Containers |
| M3 | Context Layer | 多来源上下文的统一读写面 | Context Registry DO + R2/D1/Vectorize + Plugin |
| M4 | Tool Layer | 任何环境的 Agent 的工具访问面 | tool-bridge (Worker) + HTBP |
| M5 | Auth | Principal / Policy / 访问判定 | Worker 中间件 + D1 + KV |
| M6 | Scheduler | Cron / 延迟任务 | DO alarms (`this.schedule`) |
| M7 | Task | 长任务的持久化执行与人类检查点 | Cloudflare Workflows |
| M8 | Model Provider | 模型渠道注册、路由、计量 | AI Gateway |
| M9 | Observability | 用量 / 费用 / 缓存 / 审计 | AI Gateway analytics + Analytics Engine |
| M10 | Management | Dashboard + 各层级 Manage Agent | Pages + Agent 实例 |
| M11 | Plugin System | 一切扩展的注册与生命周期 | Registry DO + Worker 部署 |

---

## M1. Event Gateway

**职责**：Watt 是事件驱动系统，Event Gateway 是唯一的事件入口与出口。它把异构来源（IM、webhook、email、cron、Agent）的消息规约成统一的 `Event`（信封格式见 Proto §1），路由给订阅者，并把 Agent 的出站消息投递回对应渠道。

### 组成

| 组件 | 职责 | 落地 |
|---|---|---|
| **Ingress Worker** | 接收入站 HTTP：渠道回调统一入口 `POST /channels/<channelId>/inbound`（按 `ChannelConfig.adapter` 分发给对应 Adapter：Verify → Decode → 补齐 → Publish，见 Proto §2.1 接入模式）、email、外部系统直接 API Call；验签、限流，规约成 Event。"直接通过 API Call" 的来源持 Bearer/OAuth 凭证调用 Platform API 的 `EventBus.Publish`，被规约为 `source.kind='webhook'` | Worker（`fetch` / `email` handler） |
| **Channel Adapter** | 每种渠道一个适配器（feishu / dingding / slack / **email** / webhook），负责协议细节：验签（email 渠道的 Verify = SPF/DKIM/DMARC 校验）、长连接或回调维持、消息格式互转、出站投递 | Plugin（实现 `ChannelAdapter` 接口）；有状态渠道（如飞书长连接凭证、群会话）各占一个 DO；email 走 Email Routing 的 `email()` handler |
| **Event Bus** | 按订阅规则把 Event 分发给 Agent 实例 / Task / 外部 webhook；失败重试与死信 | Queues（缓冲/重试/DLQ）+ Router DO（订阅表） |
| **Session Mapper** | 维护"渠道会话 ↔ Agent 实例"的映射（如：某飞书群 ↔ 某记录 Agent 实例），保证同一会话事件到达同一实例 | Router DO 内 SQLite |

### 必要接口（详见 Proto §2）

- `ChannelAdapter` — `Verify` / `Decode` / `Encode` / `Send`：渠道插件的全部义务。
- `ChannelRegistry` — `List` / `Get` / `Write` / `Update`：渠道实例配置管理（Dashboard User→IM 视图）。
- `EventBus` — `Publish` / `Subscribe` / `Unsubscribe` / `ListSubscriptions`（订阅的三类创建主体见 Proto §2.3：AgentDefinition 声明式订阅、渠道生命周期自动订阅、手工管理）。
- `EventStore` — `List` / `Get`：事件的可查询留痕（Dashboard 的 User→Event 视图）。

### 关键设计

1. **入站与出站对称**：Agent 回复消息不直连 IM API，而是 `Publish` 一个出站 Event，由对应 ChannelAdapter 的 `Send` 投递。这样审计、限流、权限（Agent 是否能向某渠道发消息）都在同一点收敛。
2. **会话粘性**：`Event.session` 字段（如 `feishu:chat:<chat_id>`）经 Session Mapper 稳定映射到 Agent 实例 ID —— Case 3 的群聊记录 Agent 因此天然长驻同一 DO。
3. **Agent-to-Agent 通信也是 Event**：Agent 间通知（Case 1 中 Triage → Coding → QA → Review 的接力）复用同一 Event Bus，来源类型为 `agent`，从而全链路可观测。

---

## M2. Agent Runtime

**职责**：管理 Agent 的定义、实例、生命周期与派生关系；把任意 harness 的 Agent 以开放协议接入平台。

### 核心概念

- **AgentDefinition**（定义）：名字、说明、harness 类型、入口（DO class / 容器镜像 / 外部 URL）、默认模型、默认权限、可见的 Context namespace 与 Tool scope。
- **AgentInstance**（实例）：定义的一次具体运行，有稳定 ID、状态机（`idle | running | waiting | terminated`）、派生树位置。
- **派生（Spawn）**：任何实例可以创建子实例执行子任务；平台记录 parent/child 关系，父实例终止时可级联回收，子实例的权限 ≤ 父实例（attenuation only，见 M5）。

### 两级执行环境

| 环境 | 适用 | 落地 |
|---|---|---|
| **Light Runtime** | 事件响应、编排、对话类 Agent（长驻、低成本） | Agents SDK：每实例一个 DO，`this.state`/`this.sql` 持久化，WS hibernation，空闲零计费 |
| **Heavy Runtime** | 需要完整 OS 的 Agent（Claude Code 修 bug、Python 框架、跑测试） | Cloudflare Containers / Sandbox SDK：`Container` 类按实例路由，`sleepAfter` scale-to-zero |

Case 1 中 Triage/QA/Review Agent 跑 Light Runtime，Coding Agent 在 Heavy Runtime 的对应 repo 容器中工作。

**Heavy Runtime 的 workspace 与凭证（Case 1 的关键机制）**：容器 Agent 的 repo 访问有两条路径，都不把凭证暴露给 LLM 上下文——

1. **workspace 预置**：`AgentDefinition.entry.container` 声明 `workspace: { repo, ref }` 与 `bindings: [{name, secretRef}]`（Proto §3.1）；平台在容器启动时 clone repo 并把 git token 等密钥注入为环境变量/凭证文件，生命周期与容器一致；
2. **经 Tool Layer**：git push / 创建 PR / 触发 CI 等对外动作走挂载在工具树上的 git/CI ToolProvider（M4），凭证保持在 Tool Gateway 侧。

推荐组合：容器内本地读写代码用路径 1，穿越信任边界的动作（PR、CI/CD、部署）用路径 2——后者天然获得 Auth 判定与审计。

### 协议接入（Protocol Adapter）

平台不假设 harness。Agent 与 Watt 的交互面只有三种，全部开放协议：

1. **Platform API（Agent 消费平台）**：Agent 访问 Context/Tool/Spawn 等能力，走 **HTBP**（纯 HTTP，任何环境可用）或 **MCP**（平台以 `McpAgent` 暴露 `watt-platform` MCP server，工具即 Proto 中的接口）。
2. **Agent Endpoint（平台驱动 Agent）**：平台向 Agent 投递事件、查询状态，Agent 实现 `AgentEndpoint` 接口（Proto §3）；内置 harness（Flue/Agents SDK）直接原生实现，外部 harness 通过 HTTP 回调或 MCP sampling 适配。
3. **身份传播**：每次调用携带平台签发的 Agent Token（含实例 ID、派生链、代表的 Principal），见 M5。

### 必要接口（详见 Proto §3）

- `AgentRegistry` — `List` / `Get` / `Write` / `Update`：Agent 定义的管理（Dashboard User→Agent 视图、Manage Agent 均调用它）。
- `AgentRuntime` — `Spawn` / `Send` / `Status` / `Interrupt` / `Terminate` / `ListInstances`：实例生命周期。`Send`/`Spawn` 支持 `expect`（correlationId + 超时），完成经 `agent.result`/`agent.failed` 事件定向回送——多 Agent 接力与 fan-in 的完成协议见 Proto §3.4。
- `AgentEndpoint` — `OnEvent` / `Describe`：Agent 侧需要实现的最小义务。

### Demo 阶段 harness 选型

初期内置两个参考 harness（都只是 `AgentEndpoint` 的实现，可替换）：

1. **Flue**（见 Reference §1）：跑在 Agents SDK 上，每 Agent 一个 DO，fiber 检查点，天然契合。
2. **Claude Agent SDK / OpenAI Agent SDK**：跑在 Container 中，经 HTBP 消费平台工具。

---

## M3. Context Layer

**职责**：把多来源的上下文（FS/对象存储、飞书文档、mem0、任意自定义源）统一成一个**带命名空间的读写面**，供 Agent、Task、Dashboard 一致访问。

### 核心概念

- **ContextProvider**：一种来源的接入实现（Plugin）。**每个 Provider 必须且仅需实现 `List` / `Get` / `Update` / `Write` 四个接口**（Proto §4）；可选能力（`Search` / `Watch` / `Delete`）通过 capability 声明，调用方需先探测。
- **Namespace**：挂载点。形如 `feedback/bugs`、`research/scratch/<task-id>`，每个 namespace 绑定一个 Provider 实例 + 权限策略 + 可选 TTL。
- **临时 Context**：带 TTL 的 namespace（Case 3 的群聊 scratch），到期由平台回收——Provider 无需自行实现过期逻辑。临时 namespace 默认挂内置 vector provider（具备可选能力 `Search`），保证"@ 时召回"可语义检索；条目量小的场景直接 `List` 全量亦可。
- **ContextEntry**：统一的条目模型（uri、metadata、content），内容可以是文本、结构化 JSON 或对象存储引用。

### 组成

| 组件 | 职责 | 落地 |
|---|---|---|
| **Context Registry** | namespace 注册表（三大 Registry 之一）、路由（uri → Provider）、TTL 回收、权限拦截、变更通知 | Registry DO（注册表 SQLite）+ `this.schedule`（TTL） |
| **内置 Provider: object** | 通用对象/文件存储 | R2（S3 兼容，满足 Watt.md 的 S3 诉求） |
| **内置 Provider: kv/structured** | 结构化小数据（如 bugs 列表） | D1 |
| **内置 Provider: vector** | 语义检索（可选 capability `Search`） | Vectorize + Workers AI embeddings |
| **外部 Provider（Plugin）** | 飞书文档、mem0、内部系统…… | 实现 `ContextProvider` 的 Worker 或外部 HTTP 服务（经 HTBP 描述） |

### 必要接口（详见 Proto §4）

- `ContextProvider` — `List` / `Get` / `Update` / `Write`（+ 可选 `Search` / `Watch` / `Delete`）。
- `ContextRegistry` — `List` / `Get` / `Write` / `Update`（+ `Delete` 卸载、`Resolve` 调试）：namespace 挂载管理（Dashboard User→Context 视图；三大 Registry 之一）。

### 关键设计

1. **对 Agent 只有一个抽象**：Agent 不感知"这是飞书文档还是 R2"，只见 `context://feedback/bugs/1234` 这样的 URI；换 Provider 不改 Agent。记忆型来源（mem0）同样收敛进四动词：add→`Write`、召回→可选能力 `Search`（映射示例见 Proto §4.1）。
2. **读写对等**：Case 1 要求 Agent 既检索历史反馈（`List`+`Get`）又登记新 bug（`Write`）并在修复后更新状态（`Update`，如 `metadata.status: open→fixed`，条目约定见 Proto §4.1）——四个动词就是从 User Case 反推出来的最小集合。
3. **Context 消费面融入 HTBP**：Agent 读写 Context 不走独立协议——每个 namespace 就是 HTBP 树 `/htbp/context/<namespace>` 下的一个节点（cmd = 四动词 + 声明的可选能力），由 Tool Gateway 统一服务，同时以 MCP resource 形态暴露（Proto §11.3）。无 SDK 的 Agent 也能读写 Context；`ContextProvider` 四动词是**Provider 侧 SPI**，HTBP 是**Agent 侧消费面**，Tool Gateway 在中间做翻译（复用 tool-bridge 的节点机制，见 Reference §2.2）。
4. **Skill 分发**：Flue 意义上的 SKILL.md（可复用专长）不需要专门机制——就是挂在 `context://skills/...` 下的 markdown 条目，Agent 按需 `List/Get` 加载（Reference §1.5 借鉴点 3 的落地）。

---

## M4. Tool Layer

**职责**：为**任何环境**的 Agent 提供统一的发现与调用面。上游聚合 MCP server、HTTP API、平台内置能力；下游以 HTBP（纯 HTTP）与 MCP 双协议供给。Tool Gateway 同时是**整棵 HTBP 树的宿主**：除工具子树外，Context 子树（M3 消费面）与平台管理子树也由它服务——这正是 HTBP/tool-bridge 在 Watt 中的定位：不只是工具桥，而是 Agent 面向平台的单一入口。

### 组成

| 组件 | 职责 | 落地 |
|---|---|---|
| **Tool Gateway（HTBP 网关本体）** | 整棵 HTBP 树的服务：`/htbp/tools/*`（工具挂载）、`/htbp/context/*`（Context 消费面，代理到 M3 的 Provider）、`/htbp/platform/*`（平台接口）；`~help`/`~skill` 生成、调用代理、上游凭证注入 | tool-bridge（Worker，见 Reference §2.2） |
| **ToolProvider** | 一种工具源的接入（Plugin）：`mcp`（上游 MCP server）、`http`（任意 HTTP API）、`builtin`（平台能力：websearch、code exec、browser rendering） | tool-bridge adapter |
| **工程工具挂载（Case 1 依赖）** | Git/PR/CI/CD/部署不是平台内置模块，而是标准的工具挂载：如 `ToolRegistry.Write({path:"eng/github", provider:"mcp", ...})` 挂 GitHub MCP server（create-pr、merge），`eng/ci` 挂 CI 系统的 `http` Provider（trigger、status）、`eng/deploy` 挂部署系统。Coding/QA/Review Agent 经 `ToolProvider.Call` 完成推 PR、触发 CI、部署测试环境 | ToolMount 配置，无需新接口 |
| **工具虚拟化** | namespace 前缀、rename、hide、description override；按调用者裁剪可见树 | tool-bridge virtualize + Auth 联动 |

### 必要接口（详见 Proto §5）

- `ToolProvider` — `List` / `Get` / `Call`：工具源插件的全部义务（`Get` 返回单个工具的 schema/描述，即 `~help` 的数据源）。
- `ToolRegistry` — `List` / `Get` / `Write` / `Update`：工具源的挂载管理（Dashboard User→Tool 视图）。

### 关键设计

1. **凭证不出网关**：上游 API key / OAuth token 存在 Tool Gateway 侧，Agent（尤其是运行在容器里的 LLM 生成代码）永远拿不到原始凭证——对应 Flue×Cloudflare 的 bindings 理念。
2. **权限在调用点判定**：每次 `Call` 携带 Agent Token，Tool Gateway 调用 Auth 的 `Check((principal, agent), tool, invoke)`；Case 4 的"B 无法使用工具"就发生在这里，而不是靠 prompt 约束。
3. **可见性即权限**：`List`/`~help` 结果按调用者裁剪——无权限的工具对该调用者根本不出现，减少无效尝试与信息泄露。

---

## M5. Auth

**职责**：回答一个问题——**"这个 Principal（经由这个 Agent、这条派生链）能否对这个资源做这个动作？"** 覆盖 Watt.md 的原始要求："Agent 是否能够访问某个工具/context"。

### 核心概念

- **Principal**：`user:<id>`、`agent:<definition-name>`（定义级）、`service:<id>`。用户身份由 Channel Adapter 从 IM 身份映射（如飞书 open_id → user）；实例级授权走 Policy subject `agent-instance:<id>`（Proto §6.4b），实例身份不作 principal。人类直接调用（Dashboard）的认证与引导见 Proto §6.5。
- **委托链（Delegation chain）**：Agent 替用户做事时，有效权限 = `Principal 权限 ∩ Agent 自身权限 ∩ 派生链上每个祖先的权限`——**只能衰减，不能放大**。Case 4 中同一财务 Agent、不同用户 → 不同工具可见性，正是靠链上的 user 段区分。
- **Resource**：统一 URI —— `tool://<path>`、`context://<namespace>/...`、`agent://<name>`、`event://<channel>`、`model://<provider>`。
- **Policy**：`(principal-selector, resource-pattern, actions, effect)` 声明式规则，支持角色（CEO/admin/employee）。

### 组成与落地

| 组件 | 落地 |
|---|---|
| Policy 存储 | D1（策略表）+ KV（判定缓存） |
| 判定点（PEP） | Tool Gateway（HTBP 树全部子树）、Context Registry、Event Gateway、Agent Runtime 的每个入口中间件 |
| Token 签发 | 平台签发短期 Agent Token（JWT：实例 ID、派生链、on-behalf-of principal、scope）；外部接入走 OAuth 2.1（`workers-oauth-provider`，MCP 标准要求） |

### 必要接口（详见 Proto §6）

- `Authorizer` — `Check` / `CheckBatch`：唯一的判定入口，所有模块只依赖它。
- `PolicyStore` — `List` / `Get` / `Write` / `Update`：策略管理（Dashboard / Manage Agent）。
- `IdentityMapper` — `Resolve`：渠道身份 → Principal。

---

## M6. Scheduler

**职责**：定时（cron）与延迟触发。CronJob 的 `action` 有三种形态（Proto §7）：`publish`（纯发事件，做什么由订阅决定）、`agent`（到点调用某个 Agent）、`script`（执行一段运行时脚本）。触发时留痕 `cron.fired`，执行结束留痕 `cron.completed`（含结果/错误）。

### 落地

- 每个 CronJob 挂在 Scheduler DO 上，用 Agents SDK 的 `this.schedule()`（DO alarm + SQLite 持久化，重启不丢；alarm 本身为秒级以下精度，"分钟级"仅是 cron 表达式的语义粒度）。
- **script 动作**承载 Case 6 的"Manage Agent 写脚本"：脚本作为数据存入 `context://automations/<id>`（可审计、可改），到点后在一次性 Worker isolate（Code Mode / Dynamic Worker Loader，open beta，冷启动毫秒级，成本极低，见 Reference §1.4）中执行，只注入 `grants` 声明的平台接口绑定，每次调用照常过 Auth（principal = createdBy，链上追加 `cron:<jobId>` 系统段，判定规则见 Proto §6.4c）。这与 Task 的 workflow 模板（代码部署产物，不可运行时注册）形成明确分界：**重编排用 Task 模板，轻自动化用 cron script**。

### 必要接口（详见 Proto §7）

- `Scheduler` — `List` / `Get` / `Write` / `Update` / `Trigger` / `Delete`（`Trigger` 用于手动立即执行一次，便于调试）。

Case 6 中 Manage Agent 正是先 `ContextProvider.Write` 存脚本、再调用 `Scheduler.Write{action:script}` 发布任务——对话式管理与 Dashboard 表单走同一接口。

---

## M7. Task

**职责**：承载**跨小时/跨天、多阶段、含人类检查点**的长任务。Agent 的单轮响应不需要 Task；Case 1 的"反馈→修复→上线"全链路需要。

### 核心概念

- **Task**：一次长任务实例，有阶段列表、状态机（`pending | running | waiting_human | waiting_event | done | failed | cancelled`）、产物引用。
- **检查点**：`waiting_human` 状态挂起等待确认（Case 1 的"人类手动确认上线"、Case 2 的"用户确认调研方案"）。闭环由 Proto §1.1 的规范化事件承载：Task 挂起时 Publish `task.checkpoint`（含 prompt 与通知目标）→ 内置路由把它渲染成带按钮的 IM 确认卡片（按钮内嵌 `{taskId, checkpoint, decision}`）→ 用户点击产生 `im.action` 事件 → 平台校验点击者权限后自动调用 `TaskManager.Signal` → Workflows 的 `waitForEvent` 恢复执行。

### 落地

- Cloudflare Workflows：`step.do`（自动重试的阶段）、`step.sleep`（至 365 天）、`step.waitForEvent`（人类/外部事件检查点）。实现注记：Workflows 的事件 type 不允许 `.`，Watt 点分事件名在适配层按 `.`→`-` 净化（`agent-result-<correlationId>`、`task-signal-<checkpoint>`，规则见 Proto §3.4）。
- Task 的每个阶段可以是：调用某个 Agent（经 Agent Runtime `Send(expect)`，用 `waitForEvent` 等 `agent.result` 回传）、调用工具、读写 Context。
- Task 状态回写 Observability，Dashboard User→Task 视图可查。

### 必要接口（详见 Proto §8）

- `TaskManager` — `List` / `Get` / `ListDefinitions` / `Write` / `Update` / `Cancel` / `Signal`（`Signal` 投递人类确认/外部事件给 `waiting_*` 的 Task；workflow 模板是代码部署产物，`ListDefinitions` 只读列举）。

### 与"脚本式多 Agent 编排"的关系（Claude Code Workflow 模式）

[claude-code-workflow-research](https://github.com/TokenRollAI/claude-code-workflow-research) 逆向出的 Claude Code Workflow 四层架构——主会话 → 模型生成的编排脚本 → 本地运行时 → 结构化返回的子代理——与 Watt 的原语一一对应，Watt 天然支持这种"动态派生 + 结构化汇总"的编排风格：

| Claude Code Workflow | Watt 对应 |
|---|---|
| `agent(prompt, {schema})` 派生子代理 | `AgentRuntime.Spawn({expect: {schema}})`（Proto §3.2） |
| `StructuredOutput` 强制 JSON + 校验重试 | `ExpectSpec.schema`：平台校验 `agent.result.output`，不符退回重试，仍失败 → `agent.failed(invalid_output)` |
| `pipeline()` 无 barrier 逐项推进 | 编排者收到单个 `agent.result` 即可立即对该 item 发起下一阶段 `Spawn/Send`——完成协议本身就是事件驱动的，无隐式 barrier |
| `parallel()` barrier 聚合 | 编排者按 correlationId 收齐 N 个结果后继续（Case 2 的 fan-in） |
| 运行时负责并发/缓存/resume | 编排者形态二选一：**Task（Workflows）**——`step.do` 天然提供持久化、重试、断点续跑（对应 journal/resume）；**编排 Agent（DO）**——状态存 `this.sql`，灵活但持久化语义自管 |
| 脚本决定论约束 | Workflows 的 step 语义同样要求确定性重放——同一约束在 Watt 的 Task 形态下由 Cloudflare Workflows 引擎强制 |
| `<task-notification>` 回流主会话 | `agent.result` 定向回送 / `task.checkpoint` 事件（Proto §3.4、§1.1） |

关键区别：Claude Code 的编排脚本跑在本地进程里；Watt 的编排者是**平台上的一等公民**（Task 或 Agent 实例），因此获得 Claude Code 没有的能力——跨天挂起（`step.sleep`）、人类检查点（`waitForEvent`）、派生树可视化（`ListInstances(tree)`）、每次派生过 Auth 衰减、全链路审计。"模型生成编排脚本"的动态性也有落点：Manage Agent 写的编排逻辑可以走 cron `script` 动作（轻自动化，Proto §7）或生成后部署为 workflow 模板（重编排）。

**运行时提交编排脚本**（全动态形态）当前不在范围内，但已在 Proto §8.1 预留了 additive-only 的扩展缝（`ListDefinitions.kind` 开放枚举、`Write.script` 可选入参、`orchestration:<taskId>` 链段）——将来引入时不破坏任何既有契约。

---

## M8. Model Provider

**职责**：模型渠道的注册、默认路由、fallback 与计量。Agent 声明"我要一个模型"，平台决定流量去哪个渠道。

### 落地

- 所有 LLM 流量经 **AI Gateway**：统一 endpoint、缓存、重试、fallback、per-provider token/费用/缓存命中率 analytics（Case 5 的数据源）。
- Provider 配置（渠道、密钥、优先级、默认指向）存 D1；密钥经 Secrets 管理，不进 Agent 环境。

### 必要接口（详见 Proto §9）

- `ModelProviderRegistry` — `List` / `Get` / `Write` / `Update`（Case 5 的"增加新模型来源"= `Write`，"默认来源指向它"= `Update{default:true}`）。
- `ModelRouter` — `Route`：给定 (agent, 模型要求, 上下文) 返回实际渠道；实现内聚在平台，Agent 不感知。

---

## M9. Observability

**职责**：全平台的用量、费用、性能与审计数据的采集与查询——Dashboard 和 Manage Agent 的所有"看"都从这里来。

### 采集面

| 数据 | 来源 |
|---|---|
| token 用量 / 费用 / 缓存命中率 | 按渠道/天：AI Gateway analytics 原生聚合；**按 Agent**：AI Gateway 原生分析不含此维度——平台在请求侧注入 `cf-aig-metadata`（agent 实例/定义 ID），经 AI Gateway Logs / GraphQL API 聚合入 Analytics Engine |
| Agent 实例数、Task 数、状态分布 | Agent Runtime / TaskManager 上报 |
| 事件吞吐、渠道健康 | Event Gateway 上报 |
| 工具调用次数、失败率、鉴权拒绝 | Tool Gateway / Auth 上报 |
| 审计日志（谁、经谁、对什么、做了什么） | 各判定点统一写入 |

落地：Workers Analytics Engine（打点/时序聚合）+ D1（审计明细）。

### 必要接口（详见 Proto §10）

- `Metrics` — `Query`：维度化查询（Case 5 的"最近 7 天 token / 计费 / 缓存命中率"即一次 `Query`）。
- `AuditLog` — `List` / `Get`。

---

## M10. Management

**职责**：平台的三个对等管理入口——**Dashboard**（界面）、**Manage Agent**（对话）与 **Watt CLI**（命令行）。三者调用**完全相同**的模块接口（Platform API 的 HTBP 绑定），不存在管理专用旁路。

### Manage Agent

- Watt.md 的要求："在每个层级都有一个 Agent 用来降低使用门槛"。落地为一组内置 AgentDefinition：
  - `manage/platform`：全局入口，跨模块问答与操作路由；
  - `manage/context`、`manage/tool`、`manage/cron`、`manage/agent`……每层一个，system prompt 中内嵌该层接口的 `~skill` 文档，工具即该层接口（经 Tool Layer 以 `builtin` Provider 暴露）。
- Manage Agent 本身受 Auth 约束：它替 admin 操作时才有 admin 权限（委托链，见 M5）——不会成为提权后门。
- Case 6 的流程：admin 对话 → `manage/cron` Agent 生成任务脚本 → 调用 `Scheduler.Write` → 完成。

### Dashboard

- 落地：Cloudflare Pages（React）+ Platform API。
- 视图与接口的对应（即 Watt.md 列举的 User→X 清单）：

| 视图 | 背后接口 |
|---|---|
| User → Agent | `AgentRegistry.List/Get/Write/Update` + `AgentRuntime.ListInstances/Status` |
| User → Context | `ContextRegistry.List/Get/Write/Update` + `ContextProvider.List/Get/Update/Write` |
| User → Tool | `ToolRegistry.*` + `ToolProvider.List/Get` |
| User → Cronjob | `Scheduler.*` |
| User → Task | `TaskManager.List/Get/Cancel/Signal` |
| User → Event | `EventStore.List/Get` + `EventBus.ListSubscriptions` |
| User → IM | `ChannelRegistry.List/Get/Write/Update`（Channel 配置） |
| User → Agent Workflow | `TaskManager.ListDefinitions`（模板为代码部署产物，只读）+ `TaskManager.*` + 派生树可视化（`AgentRuntime.ListInstances(tree)`） |
| Provider 管理 | `ModelProviderRegistry.*` + `Metrics.Query` |

### Watt CLI

- 落地：单二进制 Node CLI（npm 包 `watt-cli`，命令名 `watt`），**纯 Platform API 客户端**——每条子命令一一映射到 Proto 接口，无任何本地状态或专用端点；`--json` 输出供脚本消费，这也使 CLI 成为 E2E 测试的天然驱动器（DOD §9 的六条 E2E 全部可经 CLI 表达）。
- 认证：`watt login` 走 OAuth 2.1 设备授权（device flow，CLI 无回调页），拿到的 user token（Proto §6.5）缓存于 `~/.watt/credentials`；非交互场景（CI/loop）支持 `WATT_TOKEN` 环境变量。
- 命令面与接口的对应（与 Dashboard 视图表同源，节选核心命令）：

| 命令 | 背后接口 |
|---|---|
| `watt login` / `watt whoami` | OAuth 2.1 device flow → user token（Proto §6.5）；whoami 解码 token claims |
| `watt status` | `Metrics.Query`（实例数/Task 数/今日 token）+ 各模块 Health 汇总 |
| `watt agent list/get/spawn/send/terminate/tree` | `AgentRegistry.*` + `AgentRuntime.*`（tree = `ListInstances(tree)`） |
| `watt context ls/cat/put/patch/mount/unmount` | `ContextProvider.List/Get/Write/Update` + `ContextRegistry.*` |
| `watt tool ls/describe/call/mount` | `ToolProvider.List/Get/Call` + `ToolRegistry.*` |
| `watt task list/get/run/signal/cancel` | `TaskManager.*`（signal = 人类检查点的命令行确认路径） |
| `watt cron list/create/trigger/rm` | `Scheduler.*` |
| `watt event tail/get/subs` | `EventStore.List/Get`（tail = 轮询 List）+ `EventBus.ListSubscriptions` |
| `watt channel list/set/connect` | `ChannelRegistry.*`；`connect` = 在本地承载 push 型渠道的长连接（如飞书 WSClient），事件转发进 `EventBus.Publish`——开发期替代 Container 宿主 |
| `watt provider list/add/set-default` | `ModelProviderRegistry.*` |
| `watt policy list/add/rm` | `PolicyStore.*` |
| `watt plugin register/list/health` | `PluginRegistry.*` + `PluginLifecycle.Health` |
| `watt metrics query` / `watt audit list` | `Metrics.Query` / `AuditLog.List` |

- 权限语义与其他入口一致：CLI 持 user token，判定走 Proto §6.4c 的纯 principal 路径——`watt` 下发的每个操作在 AuditLog 中的主体就是登录用户本人。

---

## M11. Plugin System

**职责**：Watt 的"易于拓展"落在这里——**平台的每个扩展点 = 某一层的一个纯接口**。Plugin 就是"实现了某接口的可注册部署单元"。Plugin 的编写指南（契约、manifest、示例骨架、注册与调试流程）单独成文：[Plugin.md](./Plugin.md)。

### Plugin 类型与对应接口

| Plugin 类型 | 实现的接口 | 例子 |
|---|---|---|
| Context Provider | `ContextProvider`（List/Get/Update/Write） | 飞书文档、mem0、Notion |
| Tool Provider | `ToolProvider`（List/Get/Call） | 上游 MCP server、内部 HTTP API |
| Channel Adapter | `ChannelAdapter`（Verify/Decode/Encode/Send；push 型可豁免前两者，见 Proto §2.1） | 飞书、钉钉、Slack、Telegram、Email（Verify=SPF/DKIM/DMARC） |
| Agent Harness | `AgentEndpoint`（OnEvent/Describe） | Flue、Claude SDK 容器、自研 |

> 新增模型渠道**不是 Plugin**——那是 `ModelProviderRegistry.Write` 的一条配置数据（与 Plugin.md §2 一致），如 OpenRouter、Bedrock 渠道。

### 部署与注册

- **部署形态**：a) 平台内 Worker（推荐，享受 bindings）；b) 外部 HTTP 服务——只要实现接口对应的 HTTP 契约（HTBP 描述，见 Proto §11），托管在哪无所谓。
- **注册**：`PluginRegistry.Write` 提交 manifest（类型、接口版本、endpoint、所需权限、健康检查路径）；平台验证接口契约（调 `~help` + 探活）后挂载到对应层。
- **隔离**：Plugin 只持有自己声明的权限；对平台的回调（如 Channel Adapter 发布事件）用平台签发的 plugin token。

### 必要接口（详见 Proto §11）

- `PluginRegistry` — `List` / `Get` / `Write` / `Update`。
- `PluginLifecycle` — `Health` / `Describe`：每个 Plugin 必须实现的元接口。

---

## 附A. User Case → 模块调用链核对

| Case | 走通路径（模块序列） |
|---|---|
| 1 自动交付需求 | M1(webhook 入站) → M7(Write: auto-delivery Task) → M2(Triage Agent) → M3(List/Get 历史反馈, Get metadata.status 判断是否已修复, Write 新 bug) → M4(Call: logs/trace/metrics 工具) → M1(同步 Slack/飞书) → M2(Send expect→Coding Agent@Container, workspace+bindings 见 M2; 完成经 agent.result 回传) → M4(Call: eng/github 推 PR) → M2(QA/Review Agent 接力, 各自 agent.result 推进) → M4(Call: eng/ci 触发 CI/CD, eng/deploy 部署测试环境) → M7(task.checkpoint→IM 卡片→im.action→Signal: 人类确认上线) → M4(Call: eng/deploy 上线) → M1(飞书汇报) + M3(Update: status→fixed) |
| 2 deepresearch | M1(飞书入站) → M2(Master Agent) → M7(Write: deep-research Task, 进入 waiting_human) → M1(出站方案+确认按钮) → M7(im.action→Signal: 用户确认) → M2(Spawn×N, expect) → M4(Call: websearch) → M2(Master 收 N 个 agent.result/agent.failed 做 fan-in 汇总, 超时者由平台代发 failed) → M1(出站结果) |
| 3 群聊记录 | M1(群事件流, session 粘性；订阅由 AgentDefinition.subscriptions 声明式建立——Proto §2.3 规则 1) → M2(长驻实例, accept 事件但不出站) → M2(Spawn) → M3(Write 临时 namespace: TTL+vector provider) → M1(@事件) → M3(Search/List+Get) → M1(出站回答) |
| 4 权限控制 | M1(IdentityMapper: 飞书身份→Principal+roles, 写入 CallContext) → M2(财务 Agent, 委托链带 user) → M4(Call) → M5(Check: roles 匹配 Policy, 拒绝/放行) |
| 5 Provider 管理 | M10(Dashboard, admin) → M2(ListInstances)+M7(TaskManager.List)(实时数) 与 M9(Metrics.Query: 7 天 token/费用/缓存命中率趋势) → M8(Write 新渠道, Update 默认指向) |
| 6 定时任务 | M10(manage/cron Agent 对话) → M3(Write: 脚本存 context://automations/daily-token-report) → M6(Scheduler.Write: action=script+grants) → 每日: M6(一次性 isolate 执行脚本)→M9(Metrics.Query)→M1(出站 webhook→飞书群) |

## 附B. 部署拓扑（Cloudflare 资源清单）

> 资源命名约定（2026-07-02 Phase 0 落地）：云上资源统一 `watt-` 前缀（账户内有其他项目资源，避免混淆）；D1 按模块 ownership 拆多库。实际创建由幂等脚本 `pnpm provision` 负责。

```
workers:
  watt-gateway        # M1 Ingress + M5 中间件 + Platform API 路由
  watt-toolbridge     # M4 Tool Gateway（tool-bridge）
  watt-plugins/*      # 各 Plugin（可独立仓库/账号）
durable_objects:
  AgentInstance       # M2 Light Runtime（Agents SDK）
  AgentRegistry       # M2 定义注册表（三大 Registry 之一）
  ToolRegistry        # M4 工具挂载注册表（内聚于 watt-toolbridge）
  ChannelSession      # M1 有状态渠道
  EventRouter         # M1 订阅表 + Session Mapper + ChannelRegistry
  ContextRegistry     # M3 注册表 + TTL
  SchedulerHub        # M6
  PluginRegistry      # M11
containers:
  agent-heavy-*       # M2 Heavy Runtime（Claude Code / Python harness）
workflows:
  watt-task           # M7
storage:
  R2: watt-context-objects / watt-artifacts            # M3 object provider（S3 兼容）
  D1: watt-policies / watt-providers / watt-audit / watt-events   # M5 / M8 / M9 / M1 EventStore（留痕，建议 30 天保留期）
  KV: watt-authz-cache / watt-tenants                  # M5
  Vectorize: watt-context-index                        # M3 vector provider（1024 维 bge-m3, cosine）
queues:
  watt-events                                          # M1 EventBus
gateway:
  AI Gateway: 全部 LLM 流量               # M8 / M9
pages:
  watt-dashboard                         # M10
cli:
  watt-cli (npm)                         # M10 命令行入口（纯 Platform API 客户端，无云上资源）
```

**引导顺序（bootstrap）**：部署 Workers/DO/Workflows → 写入初始 admin principal 与种子 Policy（Proto §6.5c）→ 注册内置 Provider/Adapter（object/structured/vector Context Provider、builtin Tool Provider、各 IM Adapter）→ 写内置 AgentDefinition（`manage/*` 系列）→ 挂载工具树与 Context namespace → Dashboard 可用。
