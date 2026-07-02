# 模块边界与数据流（M1~M11）

> 真源：`Docs/Architecture.md`（模块边界）、`Docs/Plugin.md`（插件契约）。接口契约查 [../reference/proto-map.md](../reference/proto-map.md)。

## 模块表（M1~M11）

注意：实际编号为 M1~M11（含 M11 Plugin System）。Architecture M2~M11 与 Proto §2~§11 编号一一对齐。

| # | 模块 | 职责 | 宿主 | 持久化 | 接口面 |
|---|---|---|---|---|---|
| M1 | Event Gateway | 事件统一入口/出口与路由，异构来源规约成 `Event` | Ingress Worker（`fetch`/`email`）+ Channel DO + Queues + Router DO | Queues（缓冲/重试/DLQ）、Router DO SQLite（订阅表/Session Mapper）、D1（EventStore，建议 30 天） | ChannelAdapter / ChannelRegistry / EventBus / EventStore |
| M2 | Agent Runtime | Agent 定义/实例/生命周期/派生/协议接入 | Agents SDK（每实例一 DO = Light）+ Containers/Sandbox（Heavy） | DO `this.state`/`this.sql`；容器 scale-to-zero 无持久态 | AgentRegistry / AgentRuntime / AgentEndpoint |
| M3 | Context Layer | 多来源上下文的带命名空间统一读写面 | Context Registry DO + 内置 Provider + Plugin | R2（object）、D1（structured）、Vectorize+Workers AI embeddings（vector）；Registry SQLite + `this.schedule` TTL 回收 | ContextProvider / ContextRegistry |
| M4 | Tool Layer | 统一工具发现/调用面；**整棵 HTBP 树的宿主** | tool-bridge（Worker） | 无独立存储（ToolMount 注册表 DO 内聚）；上游凭证在网关侧 Secrets | ToolProvider / ToolRegistry |
| M5 | Auth | Principal/Policy/访问判定（衰减式委托链） | Worker 中间件（PEP 分布在各模块入口） | D1（策略表）+ KV（authz-cache/tenants） | Authorizer / PolicyStore / IdentityMapper |
| M6 | Scheduler | Cron/延迟触发；action = publish/agent/script | Scheduler DO（`this.schedule` alarm）；script 走一次性 isolate（Dynamic Worker Loader） | DO alarm + SQLite；script 本体存 `context://automations/<id>` | Scheduler |
| M7 | Task | 跨小时/跨天长任务 + 人类检查点 | Cloudflare Workflows | Workflows 引擎持久化（step.do / sleep ≤365 天 / waitForEvent） | TaskManager |
| M8 | Model Provider | 模型渠道注册/默认路由/fallback/计量 | AI Gateway（统一 LLM 流量入口） | D1（Provider 配置）；密钥经 Secrets | ModelProviderRegistry / ModelRouter |
| M9 | Observability | 用量/费用/缓存/性能/审计 | AI Gateway analytics + Workers Analytics Engine | Analytics Engine（时序）+ D1（审计明细） | Metrics / AuditLog |
| M10 | Management | Dashboard + Manage Agent + Watt CLI 三对等入口 | Pages（React）+ 内置 Agent（manage/*）+ npm `watt-cli` | 无自有存储（纯 Platform API 客户端） | 复用各模块接口（HTBP 绑定），无管理旁路 |
| M11 | Plugin System | 一切扩展的注册与生命周期 | Registry DO + Worker 部署（或外部 HTTP 服务） | PluginRegistry DO | PluginRegistry / PluginLifecycle |

## 两个全局模式

1. **三大 Registry**：AgentRegistry(M2) / ToolRegistry(M4) / ContextRegistry(M3)，统一 `List/Get/Write/Update` 四动词（Proto §0.4）；其余配置类注册表（ChannelRegistry、PolicyStore、Scheduler、ModelProviderRegistry、PluginRegistry）同构。
2. **单一 HTBP 消费面**：Agent 对平台的全部消费收敛为一棵 HTBP 树——`/htbp/tools/...`、`/htbp/context/...`、`/htbp/platform/...`，由 tool-bridge（M4）统一服务。Tool 与 Context 的 Agent 访问面融入 HTBP，不各自另设协议。HTBP 翻译层：ContextProvider 四动词是 Provider 侧 SPI，HTBP 是 Agent 侧消费面，Tool Gateway 在中间翻译；每个 namespace = `/htbp/context/<namespace>` 一个节点。

## 入站→路由→Agent→出站数据流

1. **入站**：渠道回调统一入口 `POST /channels/<channelId>/inbound`，Ingress Worker 按 `ChannelConfig.adapter` 分发 → Verify → Decode → 规约成 `Event`；email 走 `email()` handler；外部系统持 Bearer 直接调 `EventBus.Publish`（`source.kind='webhook'`）。
2. **路由**：按订阅规则（三类订阅：AgentDefinition 声明式 / 渠道生命周期自动 / 手工）经 Queues + Router DO 分发给 Agent 实例/Task/外部 webhook。
3. **会话粘性**：`Event.session`（如 `feishu:chat:<chat_id>`）经 Session Mapper 稳定映射到实例 ID，同会话事件恒达同一 DO。
4. **Agent 消费平台**：经 HTBP 或 MCP（`watt-platform` MCP server）访问 Context/Tool/Spawn；平台驱动 Agent 经 `AgentEndpoint.OnEvent`；每次调用带 Agent Token（实例 ID/派生链/on-behalf principal）。
5. **判定**：每个入口 PEP（Tool Gateway 全 HTBP 子树、Context Registry、Event Gateway、Agent Runtime）调 `Authorizer.Check`；有效权限 = Principal ∩ Agent ∩ 派生链祖先，**只衰减不放大**。
6. **出站**：Agent 不直连 IM API，而是 Publish 出站 Event（`type:"outbound.message"`）→ 对应 ChannelAdapter 的 `Send` 投递；审计/限流/权限在同一点收敛。
7. **Agent-to-Agent**：Agent 间接力复用同一 Event Bus（`source.kind='agent'`）；完成经 `agent.result`/`agent.failed` 定向回送（Proto §3.4，correlationId+超时）。

## Human-in-the-loop 链路（Case 1/2 的确认环）

Task 挂起并 Publish `task.checkpoint`（含 prompt + 通知目标）→ 内置路由渲染成带按钮的 IM 卡片（按钮内嵌 `{taskId, checkpoint, decision}`）→ 用户点击产生 `im.action` → 平台校验点击者权限 `Check(task://<taskId>, 'signal')` → 调 `TaskManager.Signal` → Workflows `waitForEvent` 恢复。适配层把点分事件名净化（`.`→`-`，Workflows 事件 type 禁 `.`），详见 [../reference/proto-map.md](../reference/proto-map.md) §3.4 节。

## M10 Watt CLI 命令表

> 原文标注"**节选核心命令**"，非完整枚举。做 CLI 完备性核对时以 M10 命令族为上界、DOD 各 Phase 子命令为最小验收集。

| 命令 | 背后接口 |
|---|---|
| `watt login` / `watt whoami` | OAuth 2.1 device flow → user token（Proto §6.5）；whoami 解码 claims |
| `watt status` | `Metrics.Query` + 各模块 Health 汇总 |
| `watt agent list/get/spawn/send/terminate/tree` | AgentRegistry.* + AgentRuntime.*（tree = `ListInstances(tree)`） |
| `watt context ls/cat/put/patch/mount/unmount` | ContextProvider 四动词 + ContextRegistry.* |
| `watt tool ls/describe/call/mount` | ToolProvider.List/Get/Call + ToolRegistry.* |
| `watt task list/get/run/signal/cancel` | TaskManager.*（signal = 人类检查点的命令行确认路径） |
| `watt cron list/create/trigger/rm` | Scheduler.* |
| `watt event tail/get/subs` | EventStore.List/Get（tail = 轮询）+ EventBus.ListSubscriptions |
| `watt channel list/set/connect` | ChannelRegistry.*；connect = 本地承载 push 型长连接（如飞书 WSClient），开发期替代 Container 宿主 |
| `watt provider list/add/set-default` | ModelProviderRegistry.* |
| `watt policy list/add/rm` | PolicyStore.* |
| `watt plugin register/list/health` | PluginRegistry.* + PluginLifecycle.Health |
| `watt metrics query` / `watt audit list` | Metrics.Query / AuditLog.List |

DOD 各 Phase 子命令合并清单（最小验收集）：Phase 0 `status`；Phase 1 `login/whoami/policy list|add|rm/audit list`；Phase 2 `event tail|get|subs/channel list|set`；Phase 3 `context ls|cat|put|patch|mount|unmount`；Phase 4 `agent list|spawn|send|tree/tool ls|call|mount/provider list`；Phase 5 `task list|run|signal|cancel/cron list|create|trigger`；Phase 6 `channel connect/metrics query/status/plugin register/audit list`；Phase 7 复用以上作 E2E 驱动器。

认证：`watt login` 走 OAuth 2.1 device flow，token 缓存 `~/.watt/credentials`；非交互场景支持 `WATT_TOKEN` 环境变量；权限走 Proto §6.4c 纯 principal 路径。

## Plugin 四类契约摘要（Plugin.md）

Watt Plugin = 实现某一层纯接口的可注册部署单元。三步：挑类型（=挑接口）→ 任意语言实现 HTTP 契约 → `PluginRegistry` 注册 manifest。

| kind | 实现接口 | 能力 | 例子 |
|---|---|---|---|
| `context-provider` | ContextProvider 四动词（+可选 Search/Watch/Delete，Proto §4.1） | 新上下文来源挂 `context://<ns>` | 飞书文档、mem0、Notion |
| `tool-provider` | ToolProvider List/Get/Call（Proto §5.1） | 新工具挂 `/htbp/tools/<path>` | 上游 MCP server、内部 API |
| `channel-adapter` | ChannelAdapter Verify/Decode/Encode/Send（push 型可豁免 Verify/Decode，capabilities 声明 `push`，Proto §2.1） | 新事件渠道 | 飞书、Slack、Email |
| `agent-harness` | AgentEndpoint OnEvent/Describe（Proto §3.3） | 新 Agent 运行方式 | Flue、Claude Agent SDK 容器 |

要点：
- **模型渠道不是 Plugin**——只是 `ModelProviderRegistry.Write` 的一条数据。
- 能力边界：Plugin 只能 (a) 响应平台对接口的调用；(b) 用 plugin token 回调平台，scope 严格等于 manifest 的 `requiredGrants`。
- 注册流程：探活（healthPath）→ 抓 `~help` 契约校验（方法集与 `interfaceVersion` 不符则拒绝挂载）→ 挂载；响应含 `platformBaseUrl`/`jwksUrl`/`pluginToken`。健康检查连续失败标 unhealthy 并告警，**不自动注销**。
- 双向认证：平台→Plugin 用 `platform-token`（JWT，平台公钥验签）或 `bearer`（静态密钥经 Secrets）；Plugin→平台用 plugin token。
- 版本：`interfaceVersion` = `<kind>/v<major>`；同 major 向后兼容；未知字段必须忽略。
- 部署形态：平台内 Worker（推荐）/ 外部 HTTP 服务 / Container（agent-harness 需完整 OS）。

## 附B 部署拓扑与资源引导顺序

资源清单：workers `watt-gateway`（M1+M5+Platform API）/ `watt-toolbridge`（M4）/ `watt-plugins/*`；DO：AgentInstance、AgentRegistry、ToolRegistry、ChannelSession、EventRouter、ContextRegistry、SchedulerHub、PluginRegistry；containers `agent-heavy-*`；workflows `watt-task`；storage：R2（context-objects/artifacts）、D1（policies/providers/audit/events）、KV（authz-cache/tenants）、Vectorize（context-index）；AI Gateway；pages `watt-dashboard`；cli `watt-cli`。

**引导顺序（bootstrap）**：
1. 部署 Workers/DO/Workflows。
2. 写入初始 admin principal + 种子 Policy（Proto §6.5c）。
3. 注册内置 Provider/Adapter（object/structured/vector Context Provider、builtin Tool Provider、各 IM Adapter）。
4. 写内置 AgentDefinition（`manage/*` 系列）。
5. 挂载工具树与 Context namespace。
6. Dashboard 可用。
