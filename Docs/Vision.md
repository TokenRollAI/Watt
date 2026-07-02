# Vision

> Watt 是一个**廉价、可扩展、协议开放的云上 Agent 基础设施**。它让任何团队用接近零的固定成本，把任意 Agent 接入到组织的事件流、上下文和工具中，长期自治地运行。

## 1. 我们要解决的问题

今天想让 Agent 真正"上岗"（而不是聊天演示），团队必须自己搭一整套基础设施：

1. **事件接入难**：IM（飞书/钉钉/Slack）、webhook、邮件、定时器各有各的长连接、验签和回调样板，每接一个渠道就要写一遍。
2. **上下文碎片化**：知识散落在文件系统、飞书文档、mem0、内部系统里，Agent 没有一个统一的读写面。
3. **工具接入受限于运行环境**：MCP 生态丰富，但很多 Agent 运行环境（边缘函数、浏览器、受限 sandbox）跑不了 MCP client。
4. **常驻成本高**：Agent 需要长期在线等待事件，传统架构意味着 7×24 常驻服务器，空闲时间也在烧钱。
5. **管理与权限缺失**：谁的 Agent 在跑？花了多少 token？普通员工能不能问财务 Agent 要报表？没有现成答案。

## 2. Watt 是什么

Watt = **Agent Infra**。它不是又一个 Agent 框架，而是 Agent 框架之下的那一层：

```
┌─────────────────────────────────────────────────┐
│  你的 Agent（Flue / Claude / OpenAI SDK / 自研）   │   ← 任意 harness，协议接入
├─────────────────────────────────────────────────┤
│                     Watt                        │
│  Event Gateway · Agent Runtime · Context Layer  │
│  Tool Layer · Auth · Scheduler · Management     │
├─────────────────────────────────────────────────┤
│  Cloudflare Workers / Durable Objects /         │
│  Containers / R2 / Workflows / AI Gateway       │
└─────────────────────────────────────────────────┘
```

### 2.1 核心主张

| 主张 | 含义 |
|---|---|
| **Agent Infra，不绑定 Agent** | 任何 Agent 通过开放协议（MCP / HTBP / HTTP）接入；平台不假设 harness 的实现 |
| **派生 Agent** | 任何 Agent 都能派生 subagent 处理子任务（调研分工、并行收集、专职角色），派生关系被平台记录和管理 |
| **管理 Agent** | 每个层级（平台、Context、Tool、Cron……）都有一个 Manage Agent 作为自然语言入口，降低使用门槛——"和平台对话"而不是"学习控制台" |
| **Context Layer** | 多来源统一上下文面：FS/R2、飞书文档、mem0、任意自定义 Provider，向 Agent 提供一致的 List / Get / Update / Write 接口 |
| **Tool Layer** | 为**任何环境**的 Agent 提供统一访问面：工具与 Context 的消费全部融入一棵 HTBP 树（HTBP 协议 + tool-bridge 网关，MCP 上游供给、HTTP 下游消费），Agent 只需要一个 HTTP 入口 |
| **廉价的云上运行** | 基于 Cloudflare：DO 空闲零计费、WS hibernation、R2 零出口费、Containers scale-to-zero——成本随用量线性，零用量近零成本 |
| **易于拓展** | 一切能力皆 Plugin：新的 Context Provider、Tool Provider、IM Channel、Agent Adapter 都只需实现对应层的纯接口（编写指南见 Docs/Plugin.md） |

### 2.2 设计原则

1. **接口优先（Interface-first）**：每一层由必要且最小的纯接口定义（如 Context Provider 的 List / Get / Update / Write）；Plugin 生态建立在接口稳定性之上，实现可以随意替换。
2. **协议开放**：Agent 与平台之间、平台与工具之间，全部走开放协议（MCP、HTBP、标准 HTTP + Bearer）；不存在私有 SDK 锁定。
3. **事件驱动、默认休眠**：一切由 Event 驱动；没有事件时整个系统近乎零成本地休眠。
4. **人类在环（Human-in-the-loop）**：不可逆动作（上线、对外发布）必须留人类确认点；Agent 自治于过程，人类把关结果。
5. **一切可观测、一切可计费**：token、费用、缓存命中率、任务状态在 Dashboard 与 Manage Agent 中随时可查。

## 3. User Cases（验收基准）

以下六个场景来自最初的功能设计，是 Watt 架构必须完整覆盖的验收基准。每个 Case 标注了所依赖的模块（详见 Architecture）。

### Case 1：自动交付需求（Bug 反馈 → 修复上线）

1. **Event Gateway** 通过 webhook 收到一条用户反馈。
2. 平台启动 auto-delivery **Task** 与 Triage Agent（**Agent Runtime**）：
   - 从 **Context Layer** 检索历史相似反馈，读条目状态判断是否已修复；
   - 判定为新 bug，**写入** Feedback/bugs context；
   - 经 **Tool Layer** 查询 Logs/Trace/Metrics 定位报错原因；
   - 结论经 Event Gateway 同步到 Slack/飞书；
   - 通过 Agent 间通信通知 Coding Agent（跑在 **Container Runtime** 的对应 repo/container 中，workspace 与凭证由平台注入）开始修复；
   - 修复后通知 QA Agent 验证 → 经 Tool Layer 的 git 工具推送 PR → Review Agent 确认改动 → 经 CI/CD 工具触发流水线、部署测试环境；
   - **人类手动确认上线**（human-in-the-loop 检查点：Task 挂起 → IM 确认卡片 → 点击 → Signal 恢复）。
3. 结论汇报：同步飞书 + 回写 Context Layer（bug 状态置为 fixed）。

覆盖模块：Event Gateway、Agent Runtime（多 Agent 协作）、Context Layer（读+写）、Tool Layer、Task/Workflow、Auth。

### Case 2：Deep Research（派生 Agent 扇出）

1. 用户通过飞书提出问题并要求深度调研（**IM Channel → Event Gateway**）。
2. Master Agent 制定调研方案，创建 deep-research **Task** 并挂起在确认检查点，方案经 IM 卡片发给用户（**human-in-the-loop**）。
3. 用户飞书点击确认，Task 恢复执行。
4. Master Agent **派生 N 个 subagent**（Agent Runtime 的 Spawn，带 expect 结果期约），各自使用 websearch 工具（Tool Layer）。
5. Subagent 完成后以 `agent.result` 回传（超时者由平台代发 `agent.failed`，不悬挂）。
6. Master Agent fan-in 汇总，经 Event Gateway 返回消息。

覆盖模块：Event Gateway（IM 双向）、Agent Runtime（Spawn/派生树）、Tool Layer、Task。

### Case 3：群聊记录（潜伏式长期 Agent）

1. 用户将飞书机器人加入群聊（**IM Channel**）。
2. 群里持续讨论；Agent **始终不回复**，只持续记录话题（长期存活的 Agent 实例 = 一个 DO，空闲时休眠零计费）。
3. Agent 派生 subagent 获取相关 context，写入**临时 Context Layer**（带 TTL 的 scratch namespace）。
4. 用户突然 @ 机器人提问；Agent 基于积累的 context 立即回答。

覆盖模块：Event Gateway（群聊事件流）、Agent Runtime（长驻实例 + 派生）、Context Layer（临时 namespace）。

### Case 4：权限控制（同一 Agent，不同调用者）

1. 用户 A（CEO）与用户 B（普通员工）和同一个财务 Agent 聊天。
2. A 有权限：财务 Agent 正常调用财务工具并回答。
3. B 无权限：**Auth 模块在 Tool Layer 调用点拒绝**，财务 Agent 无法使用工具，礼貌拒绝。

要点：权限判定的主体是 **(调用者 Principal, Agent, 资源)** 三元组——同一个 Agent 因调用者不同而获得不同的工具/Context 可见性。

覆盖模块：Auth（Principal 传播、Policy 判定）、Tool Layer、Event Gateway（身份来源）。

### Case 5：Provider 管理（模型渠道运营）

1. Admin 登录 Dashboard（**Management**）。
2. 查看正在运行的 Agent 数量和 Task 数量。
3. 查看最近 7 天 token 用量、计费金额、缓存命中率（**Model Provider 模块 + Observability**，底层 AI Gateway analytics）。
4. 发现某渠道缓存命中率低。
5. 新增一个模型来源（Model Provider 的 Write），并将默认模型来源指向它（Update）。

覆盖模块：Management/Dashboard、Model Provider、Observability、Auth（admin 角色）。

### Case 6：定时任务（对话式发布 Cron）

1. Admin 访问 Dashboard，与 **Manage Agent** 对话："每天定时获取 token 用量，webhook 发到飞书某群"。
2. Manage Agent 写一段查询脚本存入 Context（`context://automations/...`），调用 **Scheduler** 接口发布 `action=script` 的 cron job（附带脚本所需的最小权限声明）。
3. 每天定时触发：Scheduler 在一次性隔离环境中执行脚本 → 查询 Observability → Event Gateway 出站 webhook → 飞书群。

覆盖模块：Management（Manage Agent）、Scheduler、Observability、Event Gateway（出站）。

## 4. 非目标（Non-Goals）

- **不做 Agent 框架**：不发明新的 agentic loop；harness 由 Flue / Claude / OpenAI SDK 等提供。
- **不做模型托管**：模型能力经 AI Gateway 路由到任意 Provider，Watt 只做路由、计量与管理。
- **不追求单机极致性能**：优先架构简洁与成本线性；重计算下沉到 Container。
- **初期不做多云抽象**：绑定 Cloudflare 换取极低成本与开发效率；各层接口保持云中立，迁移路径保留。

## 5. 成功标准

1. 上述六个 User Case 在架构与协议层面全部走通，无需任何"接口之外"的旁路。
2. 新增一种 Context 来源 / 工具来源 / IM 渠道 = 实现一个 Plugin 接口 + 注册，不改平台核心。
3. 一个完全没有 Watt SDK 的 Agent（只会 HTTP fetch）能通过 HTBP 发现并使用平台的全部工具与 Context。
4. 空闲状态下（无事件）平台月成本接近零；成本随事件量与 Agent 活跃度线性增长。
5. 任何一个层级都可以"用对话完成管理"（Manage Agent）、"用界面完成管理"（Dashboard）或"用命令行完成管理"（Watt CLI），三者调用的是同一套接口。
