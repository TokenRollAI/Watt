# Reference

> 本文是 Watt 设计所依赖的外部项目与平台能力的调研参考。所有结论截至调研时点，引用了确切 URL 以便复核。

## 1. Flue —— 开源 Agent 框架（核心参考项目)

### 1.1 项目定位

Flue 是 Astro 团队（withastro 组织）出品的开源 Agent 框架，自称 "The sandbox agent framework / The Open Agent Framework"。它不是对 LLM API 的薄封装，而是提供一个**可编程的 harness（Agent 骨架）**：给 Agent 一个任务而不是一串脚本步骤，由框架提供 sessions、tools、skills、instructions、文件系统访问与安全 sandbox，且模型无关。

- 主仓库：<https://github.com/withastro/flue>（Apache-2.0，约 7k stars，1.0 Beta）
- 官网/文档：<https://flueframework.com/>
- 1.0 Beta 公告：<https://flueframework.com/blog/flue-1-0-beta/>
- Cloudflare 官方集成博客：<https://blog.cloudflare.com/agents-platform-flue-sdk/>

> 勘误：早期讨论曾误将 flue 归于 TokenRollAI，经核实 `github.com/TokenRollAI/flue` 不存在（404）；TokenRollAI 名下相关项目是 HTBP 与 tool-bridge（见 §2，均为 Watt.md 明确引用）。作为 Cloudflare Agents 平台首批接入框架的 Flue（withastro/flue）与 Watt 的技术栈定位完全吻合，本文以它为准。

### 1.2 核心抽象

| 概念 | 含义 |
|---|---|
| Agent | 长时运行、跨对话与事件保持上下文、朝目标自治工作 |
| Workflow | 结构化自动化：由确定性代码引导 Agent 推理，从输入走到结果 |
| Sandbox | 安全执行环境（virtual / local / remote container） |
| Durable Execution | session 写入 durable stream；中断后自动恢复，客户端可重连 |
| Subagent | 可委派的专职子角色 |
| Tool | 类型化动作（API 调用、数据查询、受控变更） |
| Skill | 按需加载的可复用专长，以 `SKILL.md` 文件形式导入 |
| MCP Server | 通过 Model Context Protocol 接入需鉴权的外部工具 |
| Channel | Slack、Teams、Discord、GitHub、Linear、Telegram 等入站事件源适配 |

### 1.3 三层栈架构（对 Watt 分层的直接启发）

1. **Framework 层（Flue）**：项目结构、约定、CLI、DX。
2. **Harness 层（Pi）**：agentic loop 本体——sessions / tools / skills。
3. **Runtime / Platform 层**：sandbox、database、deployment；在 Cloudflare 上由 Agents SDK 提供计算、状态、存储原语。

配套：Durable Streams（append-only 事件日志）、`@flue/runtime`、`@flue/cli`、`@flue/sdk`（客户端消费已部署 Agent）、`@flue/react`、`@flue/opentelemetry`、`@flue/postgres`。

### 1.4 Flue × Cloudflare 关键机制

- **每个 Agent = 一个 Durable Object**：独立存储/计算、自动扩缩、无粘性会话。
- **Fiber API 持久化执行**：`runFiber()` / `ctx.stash()` / `onFiberRecovered()` 在 DO SQLite 中做检查点，Agent turn 中途崩溃可恢复。
- **Code Mode**：不暴露一堆 tool，而是给模型单个代码执行工具（`@cloudflare/codemode`），LLM 生成的代码跑在一次性 Worker isolate（Dynamic Worker Loader，open beta；冷启动毫秒级；计费 $0.002/唯一 Worker/天——beta 期暂免，请求与 CPU 费用另计，见 <https://developers.cloudflare.com/dynamic-workers/>）。
- **Durable Virtual Filesystem**：`@cloudflare/shell` 在 DO 内提供 SQLite 支持的虚拟文件系统；需要完整 OS 时切换到 Cloudflare Containers。
- **Dynamic Workflows**：`runWorkflow()` 让 Agent 运行时动态生成 workflow，由 Workflows 引擎负责持久化步骤、重试、sleep。

### 1.5 对 Watt 的借鉴点

1. Framework / Harness / Runtime 的**三层解耦**——Watt 的 Runtime 层不绑定任何 harness，Flue、Claude Agent SDK、OpenAI Agent SDK 都只是可插拔的 harness。
2. **Channel 抽象**——IM 接入的验签、事件接收样板下沉到平台，Agent 只见标准化 Event。
3. **Skill / SKILL.md**——把"专长"作为 Context Layer 中的一种资源分发给 Agent。
4. **Durable Execution 语义**——长任务必须可检查点、可恢复，对应 Watt 的 Task 模块。

## 2. HTBP 与 tool-bridge —— Tool Layer 的协议与参考实现

### 2.1 HTBP（HTTP ToolBridge Protocol）

- 仓库：<https://github.com/TokenRollAI/HTBP>（公开，Draft 阶段，仅协议文档）
- 核心 RFC：<https://github.com/TokenRollAI/HTBP/blob/main/docs/rfcs/RFC-0001-htbp-core.md>

核心理念：**"如果 Agent 能 fetch 一个 URL，它就应该能学会使用这个 URL 对应的工具。"** 解决的问题是：许多 Agent 运行环境无法运行 MCP client / CLI / SDK，HTBP 让纯 HTTP Agent 也能发现并调用工具。

协议要点：

- **双平面**：Control Plane（`GET {path}/~help`、`GET {path}/~skill`、`POST {path}/~register`）+ Data Plane（Provider 现有 HTTP API，HTBP 不做标准化）。
- **`~help`（必选）**：`text/plain` 的紧凑 Help DSL，面向 LLM 阅读；`cmd <name> <METHOD> <path-template>` 描述命令，附 `q`/`h`/`body`/`returns`/`scope`/`effect`/`confirm` 等属性。
- **`~skill`（推荐）**：`text/markdown` 操作指南，讲多步 workflow、危险操作、错误恢复；作为远端文本不可覆盖用户意图（防 prompt injection）。
- **`~register`（可选）**：Agent 自助注册，支持 OAuth 动态客户端注册（RFC 7591）。
- **认证**：标准 `Authorization: Bearer`；scope 由 Provider 定义并在 Help 中按命令声明。
- **渐进式发现**：已知路径 → `~help` → 最小调用 → 必要时才读 `~skill` → 按需下钻，节省 context token。
- 与 MCP 关系：不替代 MCP；MCP 能力可被包装成 HTTP 端点再由 HTBP 描述。

### 2.2 tool-bridge（MCP → HTTP 桥接实现）

- 仓库：<https://github.com/TokenRollAI/tool-bridge>（私有）；线上：<https://tool-bridge.fantacy.live>
- 部署形态：Cloudflare Workers（wrangler 4.x + nodejs_compat），TypeScript，前端 React 19。

它把远端 MCP server 的 `tools/list` / `tools/call` 降维成普通 HTTP 调用，并把异构工具源收敛成一棵**自描述、可递归的 `~help` 树**：

```
GET  /htbp/~help                     # Domain：列出子节点（相对路径）
GET  /htbp/docs/context7/~help       # leaf：MCP server 整体作为叶子，内嵌全部工具 schema
POST /htbp/docs/context7             # 调用：body {"tool":"<name>","arguments":{...}}
```

五种节点类型：`directory`（中间节点）、`mcp`（MCP Streamable HTTP 叶子）、`http`（自定义 HTTP endpoint）、`remote`（联邦到另一个 tool-bridge 实例）、`mount`（把 R2 bucket 前缀树挂成只读子树）。

其他关键机制：

- **工具虚拟化**：对 MCP 工具做 namespace 前缀、rename、hide、description override，对外只暴露虚拟名。
- **多租户**：Bearer token 作为 Secret Key，`sha256` 哈希后在 KV 查租户，加载租户专属树；租户间互不可见。
- **Crawler**：`GET /api/tree` 递归爬取整棵树（环检测、深度 ≤8、节点 ≤200、remote 白名单）。
- **StorageProvider 接口**：抽象存储后端（当前 R2，S3 兼容可扩展）。

### 2.3 对 Watt 的意义

HTBP = Tool Layer 的**协议契约**；tool-bridge = Tool Layer 的**参考实现/网关**。二者组合恰好满足 Watt.md 中 "为任何环境的 Agent 提供工具访问和 Context Layer 的访问能力" 的要求：MCP 在上游供给，HTBP 在下游供 Agent 消费；`mount` 节点还天然提供了把 Context（文件/对象存储）暴露为工具树的路径。

## 3. Cloudflare 平台能力地图

### 3.1 Agents SDK（`agents` npm 包）

- 文档：<https://developers.cloudflare.com/agents/>
- Agent 继承 `Agent<Env, State>`，**每个 Agent 实例背后是一个 Durable Object**（内嵌 SQLite）；同名 ID 永远路由到同一实例。路由：`routeAgentRequest()` → `/agents/:agent-name/:instance-name`。
- 生命周期钩子：`onStart` / `onRequest` / `onConnect` / `onMessage` / `onEmail` / `onStateChanged` / `onError` / `onClose`。
- 状态：`this.state` + `setState()` 自动同步到所有连接的客户端；`this.sql` 直接访问实例本地 SQLite。
- 调度：`this.schedule(when, callback, payload)` 支持延迟秒数 / 精确 Date / cron 字符串，底层是 DO alarm + SQLite 持久化，重启不丢。
- React 集成：`useAgent()` / `useAgentChat()`，WebSocket 状态流式同步。

### 3.2 Durable Objects

- 文档：<https://developers.cloudflare.com/durable-objects/>
- 每个命名对象 = 全局唯一单线程实例 + 就地 SQLite 存储（10 GB/对象 paid），串行强一致执行——天然的 Agent/会话协调点。
- Alarms 触发未来计算；WebSocket Hibernation 让上万长连接在空闲时不计费。
- **成本模型（"廉价"的依据）**：请求 $0.15/M；duration 按 128 MB 固定内存 $12.50/M GB-s；**空闲对象零计费**；1 万条 WS 连接约 $10/月。
- 限制：CPU 默认 30s/请求（可配至 5 min）；单值 ≤2 MB。

### 3.3 其他相关组件

| 组件 | 作用 | 关键限制/价格 | 文档 |
|---|---|---|---|
| Workflows | 持久化执行：`step.do`（自动重试）、`step.sleep`（至 365 天）、`step.waitForEvent`（human-in-loop） | 步骤 ≤10k，step 输出 ≤1 MiB | <https://developers.cloudflare.com/workflows/> |
| Queues | 消息队列 + DLQ | 消息 ≤128 KB，5k msg/s/队列 | <https://developers.cloudflare.com/queues/> |
| Cron Triggers | Worker 级定时（分钟粒度，UTC） | 配置传播 ≤15 min | <https://developers.cloudflare.com/workers/configuration/cron-triggers/> |
| R2 | S3 兼容对象存储，**零出口流量费** | $0.015/GB-月 | <https://developers.cloudflare.com/r2/> |
| KV | 全球最终一致 KV | 1 write/s/key | <https://developers.cloudflare.com/kv/> |
| D1 | Serverless SQLite，30 天 PITR | 10 GB/库 | <https://developers.cloudflare.com/d1/> |
| Vectorize | 向量库（RAG） | ≤1536 维，10M 向量/索引 | <https://developers.cloudflare.com/vectorize/> |
| Workers AI / AI Gateway | 模型托管 + **模型路由、缓存、fallback、token/费用分析** | Neurons $0.011/1k | <https://developers.cloudflare.com/workers-ai/> |
| Containers / Sandbox SDK | 跑完整容器（重型 Agent runtime、Claude Code、Python），`Container` 类以 DO 形式绑定，scale-to-zero | lite 1/16 vCPU 起，按 10ms 计费 | <https://developers.cloudflare.com/containers/> · <https://developers.cloudflare.com/sandbox/> |
| Email Routing / Email Workers | 入站邮件触发 Worker（`email()` handler），Agent 侧 `onEmail`/`replyToEmail` | 入站 ≤25 MiB；出站受限：`reply` 仅限回复入站邮件（一次/事件），主动发给任意收件人需 Email Service（public beta）onboard 发信域，否则仅限已验证 destination address | <https://developers.cloudflare.com/email-routing/email-workers/> · <https://developers.cloudflare.com/email-service/> |

### 3.4 MCP 支持

- `McpAgent`：每个 MCP client session = 一个 McpAgent 实例 = 一个 DO；`MyMCP.serve("/mcp")` 暴露 Streamable HTTP；支持流恢复（`Last-Event-ID`）。文档：<https://developers.cloudflare.com/agents/model-context-protocol/>
- OAuth：`workers-oauth-provider` 实现 OAuth 2.1 provider 侧（MCP 要求），支持动态客户端注册 + PKCE，可桥接上游 IdP（GitHub/Google/Auth0 等）。文档：<https://developers.cloudflare.com/agents/model-context-protocol/authorization/>

## 4. Agent Framework 候选（Demo 阶段）

| 框架 | 形态 | 适配 Watt 的方式 |
|---|---|---|
| Flue | TS harness + runtime，Cloudflare 原生支持 | 首选：直接跑在 Agents SDK / DO 上 |
| Cloudflare Agents SDK | 平台原语（Agent 类） | 轻量 Agent 直接继承 `Agent` 实现 |
| Claude Agent SDK / Claude Code | 完整 coding agent，需要 OS 环境 | 跑在 Cloudflare Containers / Sandbox SDK 中 |
| OpenAI Agent SDK | Python/TS agent loop | 跑在 Containers 中，经 Tool Layer (HTBP) 访问工具 |

> 注：早期讨论中出现过的 Paimon、PyAgentCore 未检索到权威公开资料（非 Watt.md 内容），Demo 选型以上表四者为准；接入协议统一走 MCP / HTBP，因此后续替换 harness 不影响平台层。

## 5. Claude Code Workflow 逆向研究（脚本式多 Agent 编排）

- 仓库：<https://github.com/TokenRollAI/claude-code-workflow-research>（基于 Reqable 抓包 + 运行产物的逆向分析）

核心结论：Claude Code 的 Workflow 功能 = **LLM 生成编排脚本（受限 JS DSL）+ 本地运行时执行 + 子代理结构化返回**。四层架构：主会话（看到本地 `Workflow` 工具）→ 编排脚本（`agent()` / `pipeline()` / `parallel()` / `phase()`）→ 本地运行时（并发、缓存、schema 校验、journal/resume）→ 子代理（每个 `agent()` 调用即一次普通 Messages API 会话，经 `StructuredOutput` 工具返回被 schema 校验的 JSON）。

对 Watt 最有价值的三条经验（均已吸收进设计）：

1. **多代理协作是数据流程序，不是群聊**——代理间从不直接对话，所有交接发生在编排层，上下文传播是显式的。对应 Watt 的完成协议（Proto §3.4）：`agent.result` 定向回送给编排者，编排者决定下一跳的输入。
2. **结构化返回是可靠 fan-in 的前提**——子代理被强制"恰好调用一次 StructuredOutput"，schema 校验失败带错重试。对应 Watt 的 `ExpectSpec.schema`（Proto §3.2）：平台在回送前校验 `agent.result.output`，不符退回重试，仍失败发 `agent.failed(invalid_output)`。
3. **模型负责生成与判断，程序负责控制流与数据传递**——运行时的持久化/重放要求脚本决定论。对应 Watt 的 Task（Cloudflare Workflows 的 step 语义同样要求确定性重放）；完整映射表见 Architecture M7。

实测规模参考（"桌游设计锦标赛"一次运行）：5 个发明代理 + 15 个评判代理 + 1 个综合代理，共 21 个子代理、约 23.3 万 tokens、约 258 秒——印证了 Watt 按"事件驱动 + DO 派生"设计的量级假设。
