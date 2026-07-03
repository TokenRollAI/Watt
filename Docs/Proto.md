# Proto

> 本文是 Watt 各层接口的**规范性定义**。所有接口都是**纯粹的 Interface 描述**（契约），不含任何实现约束——同一接口可以由平台内置模块实现，也可以由 Plugin（Worker 或外部 HTTP 服务）实现。章节编号与 [Architecture.md](./Architecture.md) 中各模块的引用一一对应。
>
> 记法约定：使用 TypeScript 风格描述形状；`?` 表示可选；所有接口方法都是异步的（返回 `Promise<T>`，为简洁省略）。分页、错误、URI 等通用约定见 §0。

## §0. 通用约定

### 0.1 资源 URI

平台中一切可授权的资源使用统一 URI：

```
context://<namespace>/<path>          # Context 条目
tool://<tree-path>                    # 工具（Tool Gateway 树上的路径）
agent://<definition-name>            # Agent 定义
agent-instance://<instance-id>       # Agent 实例
event://<channel>/<session?>         # 事件渠道/会话
task://<task-id>
cron://<job-id>
model://<provider-id>
plugin://<plugin-id>
platform://<module>[/<method>]       # 平台接口本身（metrics / audit / scheduler / policy /
                                     #   registry/<name> ...），供 Policy 与 grants 授权
                                     #   平台能力调用，如 platform://metrics + action "read"
```

### 0.2 通用类型

```ts
type URI = string                       // §0.1 定义的资源 URI
type Timestamp = string                 // ISO 8601, UTC

interface Page<T> {
  items: T[]
  cursor?: string                       // 存在则表示还有下一页；传回 List 继续
}

interface ListOptions {
  cursor?: string
  limit?: number                        // 实现可声明默认/上限；未声明时规范默认 50、上限 200，
                                        // 超上限静默钳制（不报错）
  filter?: Record<string, string>       // 键集合由各接口文档/~help 声明；未声明的键 → invalid_argument
}

interface WattError {
  code: 'not_found' | 'permission_denied' | 'invalid_argument'
      | 'conflict' | 'unavailable' | 'rate_limited' | 'internal'
  message: string                       // 面向 LLM/人类可读
  retryable: boolean
}
```

**WattError ↔ HTTP 映射（规范性）**：`not_found`→404、`permission_denied`→403、`invalid_argument`→400、`conflict`→409、`rate_limited`→429、`unavailable`→503、`internal`→500。`retryable=true` 仅允许出现在 `rate_limited` / `unavailable` / `internal` 上；平台对 429 与 5xx 且 `retryable=true` 的响应按指数退避重试。

**未认证（规范性补充，2026-07-02）**：缺失或无法验签的 token 属**认证层**失败，发生在进入 `Authorizer.Check` 之前——返回 HTTP **401**，body 复用 `WattError` 形状且 `code: 'permission_denied'`、`retryable: false`（7 码集合不为此扩容：403 与 401 的区分由 HTTP 状态码承担，`code` 语义均为"无权访问"）。

**未实现占位（规范性补充，2026-07-02）**：尚未落地的路由/能力返回 HTTP **501**，body 复用 `WattError` 形状且 `code: 'unavailable'`、`retryable: false`（同上原则：7 码不扩容，501/503 的区分由 HTTP 状态码承担；`retryable: false` 表示"重试无意义，需等实现落地"，是 `unavailable` 允许 `retryable=false` 的合法取值）。

### 0.3 调用上下文（所有接口隐式携带）

每个调用在传输层携带 `CallContext`，实现方**不得**要求调用方在参数中重复传递身份：

```ts
interface CallContext {
  principal: PrincipalRef               // 最终受益人；无人类受益人的系统任务（如 cron 触发的
                                        // 自治 Agent）允许以 agent:/service: 作为 principal
  roles: string[]                       // principal 的角色（IdentityMapper.Resolve 产物，
                                        // 供 Policy 的 "role:*" subject 匹配；见 §6）
  agent?: AgentChainRef                 // 经由的 Agent 实例及完整派生链
  traceId: string                       // 全链路观测
}
type PrincipalRef = string              // "user:alice" | "service:ci" | "agent:finance"（定义级，
                                        // 见 §6.4b；实例身份走 claims 的 agent_inst，不作 principal）
interface AgentChainRef {
  instanceId: string
  chain: string[]                       // 从根到当前的链段序列：实例 ID，或系统段
                                        // "cron:<jobId>"（cron script/agent 触发时追加，
                                        // 其权限上限的求法见 §6.4c）
}
```

### 0.4 CRUD 动词的统一语义

**Registry 类**接口（AgentRegistry、ToolRegistry、ChannelRegistry、PolicyStore、Scheduler、ModelProviderRegistry、PluginRegistry……）统一采用四动词；**Provider 类**接口的动词由其领域语义决定（ContextProvider = 完整四动词；ToolProvider = List/Get/Call，工具源天然只读+可调用）：

| 动词 | 语义 |
|---|---|
| `List` | 枚举集合，分页，结果按调用者权限裁剪 |
| `Get` | 按 id/uri 取单个完整对象；不存在 → `not_found` |
| `Write` | 创建**或整体替换**（幂等 upsert，以调用方给定的 id/uri 为准） |
| `Update` | 部分更新（patch 语义）；不存在 → `not_found` |

删除是可选能力：支持者提供 `Delete(id)`，并在 `Describe`/capability 中声明；不支持者用 `Update{disabled:true}` 表达下线。

---

## §1. Event（事件信封）

一切进出平台的消息统一为：

```ts
interface Event {
  id: string                            // 平台生成，全局唯一
  source: EventSource
  type: string                          // "im.message" | "im.mention" | "im.action" | "im.bot_joined"
                                        // | "webhook.received" | "cron.fired" | "cron.completed"
                                        // | "agent.message" | "agent.result" | "agent.failed"
                                        // | "task.checkpoint" | "email.received"
                                        // | ... （开放集合，点分命名；规范化事件见 §1.1、§3.4、§7）
  session?: string                      // 会话粘性键，构造规范 "<channel>:<scope>:<id>"，
                                        // 如 "feishu:chat:oc_xxx"，由 ChannelAdapter.Decode 生成（见 M1）
  principal?: PrincipalRef              // 已解析的触发者身份（IdentityMapper 产物，平台补齐）
  channelUser?: { channel: string, userId: string }
                                        // 渠道原始用户标识，由 Decode 填写；平台在 Publish 前
                                        // 以此调 IdentityMapper.Resolve 补齐 principal/roles
  dedupeKey?: string                    // 入站去重键（如 "<channel>:<message_id>"）；支持重投的
                                        // 渠道 Decode 必填，Publish 对相同 key 在时间窗内幂等返回原 eventId
  payload: unknown                      // type 决定 schema
  raw?: unknown                         // 渠道原始报文（审计用，可截断）
  occurredAt: Timestamp
  traceId: string
}
```

**尺寸上限（规范性）**：Event 序列化总尺寸 ≤128 KB（对齐 Queues 消息上限，见 Reference §3.3）。超限时大内容（如入站邮件正文）必须先落地 Context/R2，payload 以 `{ "$ref": "<context:// URI 或预签名 URL>" }` 引用；`raw` 超限强制截断并在 metadata 标记 `truncated`。

```ts
interface EventSource {
  kind: 'im' | 'webhook' | 'email' | 'cron' | 'agent' | 'system'
  channel?: string                      // kind=im 时: "feishu" | "dingding" | "slack" | ...
  ref?: string                          // 来源细化：webhook 端点 id / cron job id / agent 实例 id
}
```

出站消息复用同一信封，`type: "outbound.message"`，`payload` 为 `OutboundMessage`：

```ts
interface OutboundMessage {
  channel: string                       // 目标渠道（"feishu"）或 "webhook"
  target: string                        // chat id / user id / webhook URL
  content: MessageContent               // 渠道无关的消息模型
  replyTo?: string                      // 回复某条入站事件 id（渠道支持时映射为回复）
}
interface MessageContent {
  text?: string                         // Markdown 子集
  blocks?: unknown[]                    // 富文本卡片（渠道 Adapter 各自渲染）
  actions?: ActionButton[]              // 按钮 → 回传 "im.action" 事件（人类确认点，见 §1.1）
}
interface ActionButton {
  id: string
  label: string
  signal?: {                            // 存在则：点击后由平台自动转为 TaskManager.Signal
    taskId: string
    checkpoint: string
    decision: 'approve' | 'reject' | 'custom'
  }
}
```

### 1.1 规范化事件（human-in-the-loop 闭环，规范性）

人类确认闭环由两个规范化事件类型 + 一条平台内置路由规则组成：

```ts
/** Task 进入 waiting_human 时由 Task 引擎 Publish */
interface TaskCheckpointPayload {       // Event.type = "task.checkpoint"
  taskId: string
  checkpoint: string                    // "confirm-release"
  prompt: string                        // 给人类看的说明
  options: ('approve' | 'reject' | 'custom')[]
  notify: { channel: string, target: string }   // 向哪个会话征求确认
}

/** 用户点击 IM 按钮 / Dashboard 操作时由 ChannelAdapter.Decode 产出 */
interface ImActionPayload {             // Event.type = "im.action"
  actionId: string
  signal?: ActionButton['signal']       // 原按钮携带的 Signal 载荷
}
```

**内置路由规则（system subscriber，不占用用户订阅表）**：

1. `task.checkpoint` → 平台按 `payload.notify` 构造带 `actions`（每个 option 一个按钮，内嵌 `signal`）的 `outbound.message`，经对应 ChannelAdapter 发出确认卡片；
2. `im.action` 且 `payload.signal` 存在 → 平台校验点击者权限（`Check(context, task://<taskId>, 'signal')`）后调用 `TaskManager.Signal(taskId, {checkpoint, decision})`。

由此 Case 1（上线确认）与 Case 2（方案确认）的"Task 挂起 → IM 卡片 → 人类点击 → Signal 回 Task"全链路在接口层闭合。

---

## §2. Event Gateway

### 2.1 ChannelAdapter（Plugin 接口）

每种渠道插件必须实现的全部义务：

```ts
interface ChannelAdapter {
  /** 校验入站请求真实性（验签/token）。失败 → 拒收 */
  Verify(request: RawInbound): boolean

  /** 渠道原始报文 → 标准 Event（不含 id/traceId，由平台补齐）。
   *  Decode 的字段义务（规范性）：必须填 type / session / payload / occurredAt / source.channel；
   *  有触发者时必须填 channelUser（供平台调 IdentityMapper 补 principal/roles）；
   *  支持重投的渠道必须填 dedupeKey；raw 建议保留（可截断） */
  Decode(request: RawInbound): Partial<Event>[]

  /** 渠道无关消息模型 → 渠道原生报文 */
  Encode(message: OutboundMessage): RawOutbound

  /** 投递出站报文（持有渠道凭证的唯一位置） */
  Send(payload: RawOutbound): SendReceipt
}

interface RawInbound  {
  headers: Record<string,string>
  bodyRaw: string                       // 字节精确的原始 body（二进制以 base64 编码，
                                        // encoding 标注）；验签（HMAC/DKIM）依赖字节级原文，
                                        // 平台必须透传不得重序列化；>1 MiB 走 $ref（§11.4d）
  encoding: 'utf8' | 'base64'
}
interface RawOutbound { endpoint: string, headers: Record<string,string>, body: unknown }
interface SendReceipt { ok: boolean, channelMessageId?: string, error?: WattError }
```

> 有状态渠道（长连接、token 轮换）的状态由 Adapter 自行持有（其 DO 内部事务），不进入接口。

**接入模式（规范性）**：ChannelAdapter 有两种接入模式，manifest 的 capabilities 声明——

- **webhook 型（默认，平台拉）**：IM/webhook 的回调 URL 指向平台入站端点 `POST /channels/<channelId>/inbound`；平台按 `ChannelConfig.adapter` 找到 Adapter，依次调用 `Verify → Decode → 补齐（id/traceId/principal/roles）→ Publish`。此模式下 Verify/Decode 必须实现。
- **push 型（插件推）**：长连接渠道（如飞书 WebSocket）由 Adapter 自持连接，收到消息后自行规约并以 plugin token 直接调用 `EventBus.Publish`（字段义务同 Decode）；Verify/Decode 可豁免（capabilities 声明 `push`），Encode/Send 仍必须实现以承接出站。

### 2.2 ChannelRegistry（渠道配置管理）

```ts
interface ChannelRegistry {
  List(opts?: ListOptions): Page<ChannelConfig>
  Get(channelId: string): ChannelConfig
  Write(config: ChannelConfig): ChannelConfig
  Update(channelId: string, patch: Partial<ChannelConfig>): ChannelConfig
}
interface ChannelConfig {
  id: string                            // "feishu-main"
  adapter: string                       // plugin id
  enabled: boolean
  settings: Record<string, unknown>     // app id 等非敏感配置；密钥走 Secrets 引用
  defaultAgent?: string                 // 该渠道生命周期事件（如机器人入群）自动订阅时
                                        // 绑定的 AgentDefinition（见 §2.3 规则 2）
}
```

### 2.3 EventBus

```ts
interface EventBus {
  /** 发布事件（入站规约后 / Agent 出站 / cron 触发统一走这里）。
   *  参数为 Omit<Event,'id'|'traceId'|'occurredAt'>：id/traceId/occurredAt 由平台补齐
   *  （traceId 已在链路中时透传）。规范性澄清（2026-07-03）：occurredAt 若调用方已提供
   *  （如 §2.1 Decode 义务字段携带的渠道侧发生时刻）则平台保留不覆写，仅缺省时以接收
   *  时刻补齐——与 §2.1 的 Decode 义务一致；dedupeKey 相同的重复 Publish 在时间窗内
   *  幂等返回原 eventId。
   *  鉴权（规范性）：type="outbound.message" 时判定
   *  Check(context, event://<channel>/<target>, 'write')——"Agent 能否向某渠道发消息"
   *  在此收敛；外部系统经 Platform API（Bearer/OAuth，见 §11.3）直接 Publish 时，
   *  事件被规约为 source.kind='webhook'，与入站 webhook 同权处理 */
  Publish(event: Omit<Event, 'id' | 'traceId' | 'occurredAt'>): { eventId: string }

  /** 订阅：匹配的事件将投递到 sink */
  Subscribe(sub: Subscription): { subscriptionId: string }
  Unsubscribe(subscriptionId: string): void
  ListSubscriptions(opts?: ListOptions): Page<Subscription>
}

interface Subscription {
  id?: string
  match: {                              // 全部条件 AND；缺省字段不参与匹配
    type?: string                       // 支持后缀通配 "im.*"
    sourceKind?: EventSource['kind']
    channel?: string
    session?: string                    // 会话粘性订阅（Case 3）
  }
  sink: | { kind: 'agent',   definition: string, instanceBy: 'session' | 'event' | 'singleton' }
        | { kind: 'task',    workflow: string }
        | { kind: 'webhook', url: string }
  // instanceBy: 'session' → 同一 session 路由到同一 Agent 实例（Session Mapper 语义）
}
```

**订阅的建立时机（规范性）**：订阅不是悬空接口，有三类创建主体——

1. **AgentDefinition 声明式订阅**：`AgentDefinition.subscriptions`（§3.1）在 `AgentRegistry.Write` 时由平台自动转为 `Subscribe` 调用（如群聊记录 Agent 声明 `{type:"im.*", channel:"feishu"}`）——**Case 3 的规范路径**；
2. **ChannelAdapter 触发**：仅当 `ChannelConfig.defaultAgent` 已配置时生效——渠道生命周期事件（机器人被拉入群 → `im.bot_joined`）由内置规则为该 session 建立指向 `defaultAgent` 的 `instanceBy:'session'` 订阅。与规则 1 产生的订阅按 `(definition, session)` 去重，规则 1 优先；
3. **Manage Agent / Dashboard 手工管理**：直接调用 `Subscribe/Unsubscribe`。

### 2.4 EventStore（留痕查询）

```ts
interface EventStore {
  List(opts?: ListOptions): Page<Event>   // filter: type/channel/session/时间范围
  Get(eventId: string): Event
}
```

---

## §3. Agent Runtime

### 3.1 AgentRegistry（定义管理）

```ts
interface AgentRegistry {
  List(opts?: ListOptions): Page<AgentDefinition>
  Get(name: string): AgentDefinition
  Write(def: AgentDefinition): AgentDefinition
  Update(name: string, patch: Partial<AgentDefinition>): AgentDefinition
}

interface AgentDefinition {
  name: string                          // "triage" | "manage/cron" | "finance"
  description: string
  runtime: 'light' | 'heavy' | 'external'
  entry:                                // runtime 决定形态
    | { kind: 'do-class', className: string }              // light: Agents SDK
    | { kind: 'container',                                 // heavy: Containers
        image: string, cmd?: string[],
        bindings?: { name: string, secretRef: string }[],  // 平台注入的凭证绑定（如 git token），
                                                           // 密钥只在容器启动时注入，不经过 LLM 上下文
        workspace?: { repo: string, ref?: string } }       // 预置的 repo 工作区（Case 1 Coding Agent）
    | { kind: 'endpoint', url: string, protocol: 'htbp' | 'mcp' | 'http' } // external
  model?: { preferred: string, fallback?: string[] }       // 交给 ModelRouter 解析
  grants: { resources: URI[], actions: string[] }[]        // Agent 自身权限上限（见 §6）
  contextNamespaces: string[]           // 默认可见的 Context 挂载
  toolScopes: string[]                  // 默认可见的工具树前缀
  subscriptions?: { match: Subscription['match'],
                    instanceBy: 'session' | 'event' | 'singleton' }[]
                                        // 声明式订阅：Write 时平台自动建立（见 §2.3）。
                                        // instanceBy 决定实例复用策略——群聊记录 Agent 用 'session'，
                                        // 一事一实例的处理器用 'event'，全局唯一的用 'singleton'
}
```

### 3.2 AgentRuntime（实例生命周期）

```ts
interface AgentRuntime {
  /** 创建实例（含派生：CallContext.agent 存在时自动记录父子关系并做权限衰减）。
   *  expect 存在时必返 correlationId（与 Send 返回形状对齐） */
  Spawn(req: SpawnRequest): { instance: AgentInstanceInfo, correlationId?: string }

  /** 向实例投递事件/消息（Agent 间通信、平台驱动均走这里）。
   *  需要结果时传 expect（结果回传协议见 §3.4）：平台生成/透传 correlationId，
   *  到期未收到 agent.result 则由平台代发 agent.failed(reason='timeout') */
  Send(instanceId: string, event: Event,
       expect?: ExpectSpec): { accepted: boolean, correlationId?: string }

  Status(instanceId: string): AgentInstanceInfo
  Interrupt(instanceId: string, reason?: string): void   // 请求中断当前工作（协作式）。
                                                         // 扩展接口：六个验收 Case 不依赖它，
                                                         // 为 Dashboard 的人工干预预留，非 MVP 必需
  Terminate(instanceId: string, opts?: { cascade?: boolean }): void  // cascade: 级联回收派生子树
  ListInstances(opts?: ListOptions & { tree?: string }): Page<AgentInstanceInfo>
  // tree=<instanceId>: 返回该实例的完整派生子树（Dashboard 派生树可视化）
}

interface SpawnRequest {
  definition: string                    // AgentDefinition.name
  instanceKey?: string                  // 幂等键；如 session id（同键返回同实例）
  input?: unknown                       // 初始任务/参数
  ttl?: number                          // 秒；到期自动 Terminate（临时 subagent）
  expect?: ExpectSpec                   // 需要结果的派生（Case 2 的 fan-out）：
                                        // 子实例的 agent.result/agent.failed 自动回送父实例（§3.4）
}

interface ExpectSpec {
  correlationId?: string                // 缺省由平台生成并在返回值回传
  timeoutMs?: number
  schema?: unknown                      // JSON Schema：约束 agent.result.output 的形状。
                                        // 平台在回送前校验；不符 → 携带校验错误退回子实例
                                        // 重试（最多 N 次，实现声明），仍失败 →
                                        // agent.failed(reason='invalid_output')。
                                        // 结构化 fan-in（打分/排序/聚合）依赖此保证
}

interface AgentInstanceInfo {
  instanceId: string
  definition: string
  state: 'idle' | 'running' | 'waiting' | 'terminated'
  parent?: string                       // 派生自
  children: string[]
  createdAt: Timestamp
  lastActiveAt: Timestamp
}
```

### 3.3 AgentEndpoint（Agent 侧最小义务）

任何 harness 想被 Watt 驱动，只需实现两个方法（内置 harness 原生实现；外部 harness 以 HTTP 回调实现，见 §11.3 绑定）：

```ts
interface AgentEndpoint {
  /** 平台投递事件；Agent 自行决定处理方式。返回 ack 即可，结果经 EventBus/Context 异步产出。
   *  Agent 可以 accept 事件而不产生任何出站消息（Case 3 的潜伏记录正是如此）。
   *  注：ctx 是进程内绑定的形参形态；HTTP 绑定（§11.4）下 CallContext 一律只经
   *  X-Watt-Context 头承载，body 不重复携带，如重复出现以 header 为准 */
  OnEvent(event: Event, ctx: CallContext): { accepted: boolean }

  /** 自描述：能力、状态、健康（Manage Agent 与 Dashboard 展示用） */
  Describe(): { name: string, harness: string, capabilities: string[], healthy: boolean }
}
```

> Agent **消费平台**（读 Context、调工具、Spawn）不需要额外接口——它作为客户端调用本文其余接口的 HTBP/MCP 绑定即可。

### 3.4 结果回传协议（AgentInvocation，规范性）

`{accepted}` 只是投递确认；Case 1 的接力（Coding→QA→Review）和 Case 2 的 fan-in 依赖**完成协议**。完成协议不是新接口，而是两个规范化事件 + 四条路由规则：

```ts
/** Agent 完成一次被 expect 的调用后 Publish（经平台 SDK/HTBP 的 finish 命令，或直接 Publish） */
interface AgentResultPayload {          // Event.type = "agent.result"
  correlationId: string                 // Send/Spawn 的 expect 所生成/透传
  instanceId: string                    // 产出者
  output: unknown                       // 结构化结果（≤1 MiB；更大产物放 Context，用 artifacts 引用）
  artifacts?: URI[]                     // context:// 引用（修复报告、调研文档……）
}

interface AgentFailedPayload {          // Event.type = "agent.failed"
  correlationId: string
  instanceId: string
  reason: 'error' | 'timeout' | 'terminated' | 'rejected' | 'invalid_output'
  error?: WattError                     // reason='error'/'invalid_output' 时
}
```

**路由规则**：

1. **定向回送**：带 `correlationId` 的 `agent.result`/`agent.failed` 不进通用订阅匹配，由平台直接投递给等待方——`Send` 的调用者（Agent 实例 → 其 `OnEvent`；Task 步骤 → 该步骤的 `waitForEvent`）；
2. **派生自动回送**：`Spawn(expect)` 产生的子实例，其结果自动回送父实例（Case 2 的 Master 收集 N 个 subagent 结果 = 收 N 个 `agent.result`，correlationId 区分）；
3. **超时代发**：`expect.timeoutMs` 到期未见结果，平台代发 `agent.failed(reason='timeout')`（幂等：其后真实结果到达则丢弃并记审计）；重试策略由调用方决定——收到 failed 后可再次 `Send`，平台不隐式重试；
4. **终止即失败**：等待中的实例被 `Terminate`（含级联），平台对其未完成的 correlation 代发 `agent.failed(reason='terminated')`——等待方不会悬挂；
5. **等待方先消失**：等待方（父实例/Task）已终止或取消时，到达的 `agent.result`/`agent.failed` 丢弃并记审计（EventStore 照常留痕）；
6. **结果去重**：同一 `correlationId` 首个结果生效，其后重复结果丢弃并记审计。correlation 记录在结果送达、超时或双方终止时清理。

**correlationId 约束**：字符集 `[A-Za-z0-9_-]`、长度 ≤80（平台生成时保证，透传时校验，违规 → `invalid_argument`）——保证净化后的 Workflows 事件名合法（见下）。

> 与 Cloudflare Workflows 的适配（实现注记）：Workflows `waitForEvent` 的事件 type 仅允许 `[A-Za-z0-9_-]` 且 ≤100 字符，不含 `.`。规范映射：**`agent.result` 与 `agent.failed` 进入 Workflows 时归并为同一事件 type** `agent-result-<correlationId>`，payload 携带 `status: 'result' | 'failed'` 与对应 Payload，由步骤代码分支处理——否则等待 result 的步骤永远收不到 failed。人类确认同理：`waitForEvent("task-signal-<checkpoint>")`。另注意 `waitForEvent` 默认超时 24h、上限 365 天：Task 引擎在 `waiting_human`/`waiting_event` 检查点必须显式设置超时并捕获超时异常转为 checkpoint 超时语义（提醒/升级），而非放任 Workflow 实例 failed（Case 1 的上线确认可能挂数天）。净化只发生在 Workflows 适配层，平台层事件名保持点分。

---

## §4. Context Layer

### 4.1 ContextProvider（Plugin 接口 —— 核心四动词）

**每个 Context Provider 必须实现且只必须实现以下四个接口**：

```ts
interface ContextProvider {
  /** 枚举条目（浅层列表 + 分页）。path 为 namespace 内相对路径前缀 */
  List(path: string, opts?: ListOptions): Page<ContextEntryMeta>

  /** 读取单个条目（含内容） */
  Get(path: string): ContextEntry

  /** 部分更新：patch 已存在条目的内容或 metadata；不存在 → not_found */
  Update(path: string, patch: ContextPatch): ContextEntryMeta

  /** 创建或整体替换条目 */
  Write(path: string, entry: ContextEntryInput): ContextEntryMeta
}

/** 可选能力（capability 声明于 PluginLifecycle.Describe，调用方先探测再用） */
interface ContextProviderOptional {
  Search?(query: string, opts?: ListOptions): Page<ContextEntryMeta>   // 语义/全文检索
  Watch?(path: string, sink: Subscription['sink']): { watchId: string } // 变更通知
  Delete?(path: string): void
}
```

```ts
interface ContextEntryMeta {
  uri: URI                              // context://<namespace>/<path>
  contentType: string                   // "text/markdown" | "application/json" | ...
  size?: number
  version: string                       // 乐观并发：Update/Write 可携带 ifVersion
  updatedAt: Timestamp
  metadata: Record<string, string>      // 标签、来源、作者……Provider 自定
}

interface ContextEntry extends ContextEntryMeta {
  content: string | unknown             // 文本或 JSON；大对象可返回 { $ref: URI }（如 R2 预签名）
}

interface ContextEntryInput {
  contentType: string
  content: string | unknown
  metadata?: Record<string, string>
  ifVersion?: string                    // 不匹配 → conflict
}

interface ContextPatch {
  content?: string | unknown            // 提供则替换内容
  metadata?: Record<string, string>     // 浅合并
  ifVersion?: string
}
```

**条目约定示例（非规范性，展示四动词如何承载真实场景）**：

a) Case 1 的 bug 条目——"检查是否已修复"= `Get` 后读 `metadata.status`；"修复后回写"= `Update{metadata:{status:"fixed"}}`：

```jsonc
// context://feedback/bugs/1235
{
  "contentType": "text/markdown",
  "content": "## 报错描述\n用户上传 >10MB 文件时 500 ...",
  "metadata": { "status": "open",        // open | fixing | fixed | wontfix
                "severity": "P1", "reporter": "webhook:crisp",
                "duplicateOf": "" }
}
```

b) mem0 这类"记忆型"Provider 的动词映射——`Write`→add memory（path 由调用方提供，推荐客户端生成的 uuid，保持 §0.4 的幂等 upsert 语义）、`List`→按前缀列 memory、`Get`→按 id 取、`Update`→修正记忆；语义召回走可选能力 `Search`（mem0 的核心检索路径），不支持 `Search` 的挂载点由 Context Registry 拒绝声明该 capability。四动词对记忆型来源同样封闭够用。

c) **Skill 分发**——Flue 意义上的 SKILL.md（可加载专长）就是 `contentType: "text/markdown"`、挂在 `context://skills/<domain>/...` 下的普通条目；Agent 用 `List/Get` 按需加载，无需任何专门接口。

### 4.2 ContextRegistry（namespace 挂载管理）

三大 Registry（Agent/Tool/Context）之一，遵循 §0.4 的 Registry 四动词；挂载对象是 `NamespaceMount`：

```ts
interface ContextRegistry {
  List(opts?: ListOptions): Page<NamespaceMount>
  Get(namespace: string): NamespaceMount
  Write(mount: NamespaceMount): NamespaceMount       // 挂载（mount）或整体替换
  Update(namespace: string, patch: Partial<NamespaceMount>): NamespaceMount
  Delete(namespace: string): void                     // 卸载（unmount）
  /** uri → (provider, provider 内相对路径)；Agent 通常不需要，网关内部与调试用 */
  Resolve(uri: URI): { provider: string, path: string }
}

interface NamespaceMount {
  namespace: string                     // "feedback/bugs" | "research/scratch/task-42"
  provider: string                      // plugin id 或内置 "object" | "structured" | "vector"
  providerConfig?: Record<string, unknown>
  ttl?: number                          // 秒；到期整个 namespace 回收（临时 Context，Case 3）
  readOnly?: boolean
}
```

---

## §5. Tool Layer

### 5.1 ToolProvider（Plugin 接口）

```ts
interface ToolProvider {
  /** 枚举本源提供的全部工具（含 schema 摘要）。按调用者权限的可见性裁剪
   *  由 Tool Gateway 在本方法结果之上执行（Architecture M4/M5），
   *  Provider 无需也不应感知调用者权限 */
  List(opts?: ListOptions): Page<ToolMeta>

  /** 单个工具的完整描述（inputSchema、危险性、scope）——~help 的数据源 */
  Get(toolName: string): ToolSpec

  /** 调用工具 */
  Call(toolName: string, args: unknown): ToolResult
}

interface ToolMeta {
  name: string                          // 虚拟名（经 namespace/rename 后对外的名字）
  summary: string
  effect: 'read' | 'write' | 'destructive'   // Auth 与确认策略的依据
}

interface ToolSpec extends ToolMeta {
  inputSchema: unknown                  // JSON Schema
  outputSchema?: unknown
  scope?: string                        // 所需权限 scope（映射 Policy 的 action）
  confirm?: boolean                     // true → 平台在调用前插入人类确认（经 Task/IM 按钮）
  skill?: string                        // markdown 操作指南（~skill 内容）
}

interface ToolResult {
  ok: boolean
  content: unknown                      // 成功产物（结构化或文本）
  error?: WattError
}
```

### 5.2 ToolRegistry（工具源挂载管理）

```ts
interface ToolRegistry {
  List(opts?: ListOptions): Page<ToolMount>
  Get(mountPath: string): ToolMount
  Write(mount: ToolMount): ToolMount
  Update(mountPath: string, patch: Partial<ToolMount>): ToolMount
}

interface ToolMount {
  path: string                          // 工具树位置："observability/logs"
  provider: string                      // plugin id 或内置 "mcp" | "http" | "builtin"
  providerConfig?: Record<string, unknown>   // 上游 endpoint 等；凭证走 Secrets 引用
  virtualize?: {                        // 工具虚拟化（Reference §2.2）
    prefix?: string
    rename?: Record<string, string>
    hide?: string[]
    describeOverride?: Record<string, string>
  }
  enabled: boolean
}
```

---

## §6. Auth

### 6.1 Authorizer（唯一判定入口）

```ts
interface Authorizer {
  /** 核心判定：CallContext（principal + agent 链）能否对 resource 做 action */
  Check(req: AccessRequest): AccessDecision
  CheckBatch(reqs: AccessRequest[]): AccessDecision[]   // List 裁剪用
}

interface AccessRequest {
  context: CallContext
  resource: URI
  action: string                        // "read" | "write" | "invoke" | "spawn" | "signal"
                                        // | "manage" | tool scope
}

interface AccessDecision {
  allow: boolean
  reason?: string                       // deny 时给 Agent/人的可读解释（Case 4 的礼貌拒绝素材）
  obligations?: ('require_confirm' | 'audit_verbose')[]  // 附加义务
}
```

**判定语义（规范性）**：`allow = P(principal) ∩ P(agent 定义 grants) ∩ P(链上每个祖先)` 均允许该 `(resource, action)`。任何一环缺失 → deny。即权限只能沿派生链**衰减**。

### 6.2 PolicyStore

```ts
interface PolicyStore {
  List(opts?: ListOptions): Page<Policy>
  Get(policyId: string): Policy
  Write(policy: Policy): Policy
  Update(policyId: string, patch: Partial<Policy>): Policy
}

interface Policy {
  id: string
  subject: string                       // "user:alice" | "role:ceo" | "agent:finance" | "*"
  resource: string                      // URI pattern，支持前缀通配 "tool://finance/*"
  actions: string[]
  effect: 'allow' | 'deny'              // deny 优先
  condition?: Record<string, string>    // 预留（时间窗、IP 等）
}
```

### 6.3 IdentityMapper

```ts
interface IdentityMapper {
  /** 渠道身份 → 平台 Principal（含角色）。未映射 → principal "user:anonymous" + 空角色。
   *  产出的 roles 由 Event Gateway 写入 CallContext.roles（§0.3），
   *  Authorizer 据此匹配 Policy.subject 的 "role:*" 规则——Case 4 的 CEO/员工分流即在此 */
  Resolve(channel: string, channelUserId: string): { principal: PrincipalRef, roles: string[] }

  /** 已知 Principal → 当前 roles（平台身份目录为数据源）。
   *  用于无渠道身份的路径：cron 触发（principal=createdBy）、user token 签发/续签。
   *  roles 一律触发时实时解析，不使用创建时的快照 */
  ResolvePrincipal(principal: PrincipalRef): { roles: string[] }
}
```

### 6.4 Token Claims 与判定细则（规范性）

**a) Agent Token 的 claims**（平台签发的短期 JWT，`CallContext` 的线上载体）：

```jsonc
{
  "sub": "user:alice",                  // principal（on-behalf-of 的最终受益人）
  "roles": ["ceo"],                     // IdentityMapper 产物
  "agent_def": "finance",               // 当前 Agent 的 AgentDefinition.name
  "agent_inst": "inst-42",              // 当前实例 id
  "chain": ["inst-7", "inst-42"],       // 派生链（根→当前），RFC 8693 委托语义；
                                        // 允许系统段 "cron:<jobId>"（§0.3、§6.4c 步骤 3）
  "exp": 1700000600, "iat": 1700000000, // 短期（分钟级），实例存续期间由平台自动续签
  "trace": "tr-..."
}
```

无人类受益人的系统任务（cron、singleton 订阅）：`sub` 为 `service:scheduler` 或 `agent:<definition>`，`chain` 照常记录。

**b) Policy.subject 的匹配语义**：

| subject 写法 | 匹配对象 |
|---|---|
| `user:<id>` / `service:<id>` | claims 的 `sub` |
| `role:<name>` | claims 的 `roles` 含该角色 |
| `agent:<definition-name>` | claims 的 `agent_def`（**定义级**——"财务 Agent 这类"） |
| `agent-instance:<id>` | claims 的 `agent_inst`（**实例级**——细粒度临时授权） |
| `*` | 任意 |

**c) 判定算法（`Check` 的规范展开）**：对 `(resource, action)`——

1. 求 principal 许可：以 `sub` + `roles` 匹配的 Policy 集合判定（deny 优先）；
2. 求 Agent 定义上限：`AgentRegistry.Get(agent_def).grants` 是否覆盖该 `(resource, action)`；claims 无 `agent_*` 段（纯人类/服务调用，见 §6.5b）时跳过 2/3；
3. 沿 `chain` 逐个链段重复步骤 2：实例 ID 段取其 `agent_def.grants`；**系统段 `cron:<jobId>`**——job 的 `action.kind === 'script'` 时取 `Scheduler.Get(jobId).action.grants` 作为该环上限；`kind` 为 `'agent'` / `'publish'` 时该段**不追加上限**（这两类动作没有 `grants` 字段，其衰减由后续链段——agent 定义上限、事件出站鉴权——承担）；job 已删除或禁用 → 该环视为空集 → deny；
4. 全部环节允许才 `allow`——即"只衰减"公式 `P(principal) ∩ P(agent) ∩ P(ancestors)` 的可执行形式。
   实现可用 KV 缓存各段结果；任何 Policy/grants 变更使相关缓存失效。

**d) 工具动作映射**：`ToolSpec.scope` 存在时，`Check` 的 `action` = 该 scope 字符串（如 `finance.read`）；不存在时 `action` = `"invoke"`。Policy 作者由此可以按 scope 精细授权，也可以用 `actions: ["invoke"]` 粗粒度放行整个工具。

### 6.5 User Token 与引导（规范性）

人类直接调用平台（Dashboard、直连 Platform API）不经过 Agent，认证与授权如下：

**a) 登录与签发**：Dashboard 经 OAuth 2.1（`workers-oauth-provider`，可桥接上游 IdP：Google/GitHub/企业 SSO）完成登录，平台签发 **user token**——claims 仅含 `sub`（`user:<id>`）、`roles`（`IdentityMapper.ResolvePrincipal` 实时解析）、`exp`/`iat`/`trace`，**无 `agent_*` 与 `chain` 段**。§11.3 的 "Bearer" 即 Agent Token 或 user token 二者之一。

**b) 判定路径**：user token 调用时 `CallContext.agent` 缺省，判定算法（§6.4c）只执行步骤 1（`P(principal)`），无衰减环节——人类的权限就是 Policy 赋予的权限。

**c) 引导（bootstrap）**：部署时以配置（环境变量/wrangler secret）声明初始 admin principal；平台内置一条种子 Policy `{ subject: "role:admin", resource: "*", actions: ["*"], effect: "allow" }` 并将初始 principal 绑定 `admin` 角色——由此 Case 5/6 的 "admin 登录 Dashboard" 在默认拒绝模型下可完成第一次授权，后续角色/Policy 全部经 `PolicyStore` 管理。

**d) CLI 设备授权（规范性补充，2026-07-02）**：`watt login` 走 **RFC 8628 Device Authorization Grant** 的最小子集，端点挂平台根：

- `POST /oauth/device/authorize` → `{ device_code, user_code, verification_uri, expires_in, interval }`（无认证；user_code 8 位大写字母数字，`expires_in` 默认 600s，`interval` 默认 5s）；
- 人类在 `verification_uri`（Dashboard 页面；Dashboard 未上线前允许 admin 用已有 token 调 `POST /oauth/device/approve` `{ user_code, principal }` 代替）完成确认；
- `POST /oauth/token` `{ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code }` → 未确认 `{ error: "authorization_pending" }`（HTTP 400，RFC 8628 §3.5 形状，此处遵循 OAuth 错误形状而非 WattError——OAuth 端点整体在 WattError 契约之外）；已确认 → `{ access_token: <user token>, token_type: "Bearer", expires_in }`。
- **device_code 一次性使用（2026-07-02 补充，对齐 RFC 8628 单次授权语义）**：换取成功后 grant 即被消费（存储删除），同一 `device_code` 再次请求 → `{ error: "invalid_grant" }`。`user_code` 匹配对大小写鲁棒（服务端归一化为大写再查）。
- 非交互环境（CI/loop）不走 device flow：直接以 `WATT_TOKEN` 环境变量提供 token（本地用平台私钥离线签发）。

---

## §7. Scheduler

```ts
interface Scheduler {
  List(opts?: ListOptions): Page<CronJob>
  Get(jobId: string): CronJob
  Write(job: CronJob): CronJob
  Update(jobId: string, patch: Partial<CronJob>): CronJob
  /** 立即手动触发一次（调试/补跑），不影响原计划。返回本次 cron.fired 的 eventId */
  Trigger(jobId: string): { eventId: string }
  Delete(jobId: string): void
}

interface CronJob {
  id: string
  description: string
  schedule: string                      // cron 表达式（分钟级，UTC）或 ISO 时刻（一次性）
  enabled: boolean
  /** 到点执行的动作。触发与完成分别留痕两个事件：
   *  cron.fired（触发时，payload={jobId, scheduledAt, actionKind}）
   *  cron.completed（执行结束，payload 含结果/错误；script 与 agent 动作必发） */
  action:
    | { kind: 'publish',                // 纯发事件：做什么由订阅决定
        event: { type: string, payload?: unknown, session?: string } }
    | { kind: 'agent',                  // 调用 Agent：等价于 Spawn/Send + input
        definition: string, input?: unknown,
        instanceBy?: 'singleton' | 'event' }
    | { kind: 'script',                 // 执行脚本（Case 6 的 "Agent 写脚本"）：
        scriptRef: URI,                 //   脚本存为 Context 条目（context://automations/...），
        grants: { resources: URI[], actions: string[] }[] }
                                        //   运行时注入的平台访问权限（如 platform://metrics 的
                                        //   read + event://webhook/* 的 write，见 §0.1）
  createdBy: PrincipalRef               // 审计（Case 6 中是 manage/cron 替 admin 创建）
}
```

**script 动作的执行语义（规范性）**：脚本是运行时数据而非部署产物——这正是 Case 6 "Manage Agent 写脚本、发布定时任务"与 `TaskManager.ListDefinitions`（模板 = 代码部署产物）的分界。规则：

1. 脚本内容经 `ContextProvider.Write` 存入 `context://automations/<id>`（可审计、可版本、可由 Dashboard 查看）；
2. 到点后平台在**一次性隔离环境**（Cloudflare Worker isolate，Code Mode 模式，见 Reference §1.4）中执行脚本，只注入 `grants` 声明的平台接口绑定（如本例：`platform://metrics` 的 read + `event://webhook/*` 的 write）——脚本拿不到任何未声明的能力，凭证不进脚本运行时；
3. 脚本对平台的每次调用照常过 `Authorizer.Check`（principal = `createdBy`，roles 由 `IdentityMapper.ResolvePrincipal` 触发时实时解析，链上追加 `cron:<jobId>` 系统段，其上限即本 job 的 `grants`，见 §6.4c 步骤 3），权限只能衰减。`Write` 时平台**不做** grants ≤ createdBy 的静态校验——校验推迟到每次运行时判定（createdBy 权限被收窄后 job 自然失效，不产生僵尸授权）；
4. 触发时留痕 `cron.fired`；执行结束（成功/失败）留痕 `cron.completed`（payload 含返回值/错误摘要），Dashboard 可查。

---

## §8. Task

```ts
interface TaskManager {
  List(opts?: ListOptions): Page<TaskInfo>          // filter: state/definition/时间
  Get(taskId: string): TaskDetail
  /** 列举可用的 workflow 定义。当前唯一的 kind 是 'deployed'（代码部署产物，
   *  Cloudflare Workflows 定义，不支持运行时注册）——本接口只读，
   *  供 Dashboard "User → Agent Workflow" 视图展示。
   *  kind 是开放枚举：为未来的动态编排预留 'script'（运行时提交的编排脚本，见 §8.1），
   *  调用方必须忽略未知 kind */
  ListDefinitions(opts?: ListOptions): Page<{ name: string, kind: 'deployed' | string,
                                              description: string, checkpoints: string[] }>
  /** 启动任务：definition 是**不透明引用**（当前解析为已部署模板名；
   *  未来可解析为其他 kind 的定义，调用方无需感知差异） */
  Write(req: { definition: string, input?: unknown, taskId?: string }): TaskInfo
  Update(taskId: string, patch: { note?: string }): TaskInfo   // 元信息；执行状态由引擎驱动
  Cancel(taskId: string, reason?: string): void
  /** 向 waiting_human / waiting_event 的任务投递信号（人类确认、外部完成通知） */
  Signal(taskId: string, signal: { checkpoint: string, decision: 'approve' | 'reject' | 'custom', payload?: unknown }): void
}

interface TaskInfo {
  taskId: string
  definition: string                    // "auto-delivery" | "deep-research"
  state: 'pending' | 'running' | 'waiting_human' | 'waiting_event'
       | 'done' | 'failed' | 'cancelled'
  currentStep?: string
  createdBy: PrincipalRef
  createdAt: Timestamp
  updatedAt: Timestamp
}

interface TaskDetail extends TaskInfo {
  steps: { name: string, state: string, startedAt?: Timestamp, output?: unknown }[]
  pendingCheckpoint?: {                 // waiting_human 时存在
    checkpoint: string                  // "confirm-release"（Case 1 的上线确认）
    prompt: string                      // 给人类看的说明
    requestedAt: Timestamp
  }
  artifacts: URI[]                      // 产物（context:// 引用）
}
```

### 8.1 预留扩展点：动态编排（Dynamic Orchestration，非规范性）

> 本节**不是**当前版本的一部分——它记录一个已论证的演进方向（Reference §5 的脚本式多 Agent 编排），并说明现有契约中为它预留的缝，保证将来加入时是**纯增量（additive-only）**、不破坏任何既有接口。

未来若引入"运行时提交编排脚本"（模型现场生成 `agent()`/`pipeline()`/`parallel()` 风格的 DSL 并立即执行），落点如下，全部是在开放枚举/可选字段上做加法：

| 预留缝（当前版本已存在） | 未来的加法 |
|---|---|
| `ListDefinitions` 的 `kind: 'deployed' \| string` 开放枚举 | 新增 `kind: 'script'`：运行时提交的编排定义 |
| `Write.definition` 是不透明引用 | 新增可选入参 `script?: { source: URI \| string, grants: ... }`——与 `definition` 互斥，语义与 cron `script` 动作（§7）同源：脚本存 `context://orchestrations/<id>`、一次性 isolate 执行、grants 注入、每次派生照常过 Auth |
| 编排原语 = 平台既有接口 | 脚本内注入的 `agent()` ≡ `Spawn({expect})`、结果收集 ≡ §3.4 完成协议、`schema` ≡ `ExpectSpec.schema`——**不需要新协议**，DSL 只是这些接口的语法糖 |
| `chain` 允许系统段（§0.3） | 新增 `orchestration:<taskId>` 系统段，权限上限 = 该脚本的 grants（判定规则与 §6.4c 步骤 3 的 cron 段同构） |
| Task 状态机 | 复用现有 7 态，无需扩展 |

设计约束（将来实现时必须遵守）：a) 脚本决定论要求与 §7 script 一致（Workflows 重放语义）；b) 派生的每个子 Agent 仍是标准 `AgentInstanceInfo`，派生树/审计/Observability 零改动即可覆盖；c) 现有 `deployed` 模板的行为与接口签名不得改变。

---

## §9. Model Provider

```ts
interface ModelProviderRegistry {
  List(opts?: ListOptions): Page<ModelProvider>
  Get(providerId: string): ModelProvider
  Write(provider: ModelProvider): ModelProvider           // Case 5: 增加新渠道
  Update(providerId: string, patch: Partial<ModelProvider>): ModelProvider  // Case 5: 切默认
}

interface ModelProvider {
  id: string                            // "openrouter-main"
  vendor: string                        // "openai" | "anthropic" | "workers-ai" | "openrouter" | ...
  models: string[]                      // 该渠道可服务的模型名
  priority: number                      // 路由排序
  default: boolean                      // 全局默认渠道（同时只有一个，Write/Update 时由实现保证）
  secretRef: string                     // 密钥引用（Secrets），永不回显
  enabled: boolean
}

interface ModelRouter {
  /** 平台内部接口：解析一次模型请求应走的渠道（考虑偏好、fallback、健康度）。
   *  endpoint 是实际的网络地址（AI Gateway 的 https URL），不是 §0.1 的资源 URI */
  Route(req: { model: string, agent?: string }): { provider: string, model: string, endpoint: string }
}
```

---

## §10. Observability

```ts
interface Metrics {
  Query(q: MetricQuery): MetricSeries[]
}

interface MetricQuery {
  metric: 'tokens' | 'cost' | 'cache_hit_rate' | 'agent_instances' | 'tasks'
        | 'events' | 'tool_calls' | 'authz_denials'
  range: { from: Timestamp, to: Timestamp }        // Case 5: 最近 7 天
  groupBy?: ('provider' | 'model' | 'agent' | 'channel' | 'day' | 'hour')[]
  filter?: Record<string, string>
}

interface MetricSeries {
  labels: Record<string, string>        // groupBy 维度取值
  points: { t: Timestamp, v: number }[]
}

interface AuditLog {
  List(opts?: ListOptions): Page<AuditRecord>      // filter: principal/agent/resource/decision
  Get(recordId: string): AuditRecord
}

interface AuditRecord {
  id: string
  at: Timestamp
  context: CallContext                  // 谁、经谁（完整派生链）
  resource: URI
  action: string
  decision: 'allow' | 'deny'
  detail?: unknown
}
```

---

## §11. Plugin System

### 11.1 PluginRegistry

```ts
interface PluginRegistry {
  List(opts?: ListOptions): Page<PluginManifest>
  Get(pluginId: string): PluginManifest
  Write(manifest: PluginManifest): PluginManifest   // 注册：平台验证契约（探活 + ~help）后挂载
  Update(pluginId: string, patch: Partial<PluginManifest>): PluginManifest
}

interface PluginManifest {
  id: string
  kind: 'context-provider' | 'tool-provider' | 'channel-adapter' | 'agent-harness'
  interfaceVersion: string              // 实现的接口版本（如 "context-provider/v1"）
  endpoint: string                      // HTTPS base URL（外部服务），或平台内 Worker 的
                                        // service binding 引用（"binding:<name>"）；
                                        // 不是 §0.1 的资源 URI。传输契约见 §11.4
  auth: { kind: 'platform-token' } | { kind: 'bearer', secretRef: string }
  requiredGrants: { resources: URI[], actions: string[] }[]  // Plugin 回调平台所需权限
  healthPath: string                    // 探活路径
  enabled: boolean
}
```

### 11.2 PluginLifecycle（每个 Plugin 必须实现的元接口）

```ts
interface PluginLifecycle {
  Health(): { healthy: boolean, detail?: string }
  /** 自描述：实现了哪个接口、哪些可选能力（如 ContextProvider 的 Search/Watch/Delete） */
  Describe(): {
    kind: PluginManifest['kind']
    interfaceVersion: string
    capabilities: string[]              // ["search","watch","push"] 等可选能力声明
    listDefaults?: { limit: number, maxLimit: number, filters: string[] }
                                        // List 的分页默认/上限与合法 filter 键；
                                        // 未声明时用 §0.2 的规范默认（50/200）
  }
}
```

**注册响应（规范性）**：`PluginRegistry.Write` 成功后，平台返回注册产物（Plugin 侧凭此完成双向对接）：

```ts
interface PluginRegistration extends PluginManifest {
  platformBaseUrl: string               // 平台 Platform API 的 base（回调入口）
  jwksUrl: string                       // 平台公钥集（验签 platform-token），
                                        //   形如 <platformBaseUrl>/.well-known/jwks.json
  pluginToken: string                   // 回调平台用的 Bearer（scope = requiredGrants），
                                        //   支持经 <platformBaseUrl>/plugin/token 轮换
}
```

### 11.3 传输绑定（Bindings，规范性）

本文所有接口有两种等价的线上形态；**实现任一绑定即视为实现该接口**：

**a) HTBP 绑定（默认，任何环境可用）**

Watt 对 Agent 的全部供给收敛为**一棵 HTBP 树**，由 Tool Gateway（tool-bridge）服务；Tool Layer 与 Context Layer 的消费面直接融入 HTBP，不另设访问协议：

```
/htbp/tools/<mount-path>/...      # 工具子树：ToolRegistry 挂载的全部工具源
/htbp/context/<namespace>/...     # Context 子树：每个 namespace 一个节点，
                                  #   cmd = List / Get / Update / Write（+ 声明的可选能力 Search 等）
/htbp/platform/<module>           # 平台管理与运行时子树：agent / task / scheduler / event / ...
```

- 每个节点响应 `GET .../~help`（全部方法的 Help DSL，方法名即 `cmd` 名）与 `GET .../~skill`（使用指南）；从根 `GET /htbp/~help` 可渐进发现整棵树；
- 方法调用：`POST <节点路径>`，body `{"tool": "<Method>", "arguments": {...}}`；
- 认证：`Authorization: Bearer <platform-issued token>`（Agent Token 或 user token，见 §6）；`List`/`~help` 结果按调用者权限裁剪；
- 错误：HTTP 状态码 + body 为 `WattError`。

示例（Context 四动词经 Context 子树的实际线上形态）：

```
GET  /htbp/context/feedback/bugs/~help
POST /htbp/context/feedback/bugs   {"tool":"List",  "arguments":{"path":""}}
POST /htbp/context/feedback/bugs   {"tool":"Get",   "arguments":{"path":"1234"}}
POST /htbp/context/feedback/bugs   {"tool":"Write", "arguments":{"path":"1235", "entry":{...}}}
POST /htbp/context/feedback/bugs   {"tool":"Update","arguments":{"path":"1235", "patch":{...}}}
```

**b) MCP 绑定**

- 平台以 `McpAgent` 暴露 `watt-platform` MCP server（Streamable HTTP，`/mcp`）；
- 每个接口方法 = 一个 MCP tool，命名 `<module>_<method>`（如 `context_list`、`agent_spawn`）；
- Context 条目同时以 MCP resource（`context://` URI）暴露，支持订阅（对应 `Watch` 能力）；
- 认证走 OAuth 2.1（`workers-oauth-provider`）。

**c) 版本化**

- 接口版本随绑定路径演进：`/htbp/platform/v1/...`；破坏性变更升 major，Plugin 的 `interfaceVersion` 与之对齐；
- `~help` 输出携带 `htbp` 与接口版本头，Agent 侧渐进发现即自动适配。

### 11.4 Plugin 传输契约（平台 → Plugin，规范性）

第三方只依据本节即可实现一个可注册的 Plugin（面向人的 walkthrough 见 [Plugin.md](./Plugin.md)）。设 `base` = manifest 的 `endpoint`：

**a) 方法调用（所有 kind 统一）**——与 §11.3 a) 的 HTBP 调用形态完全一致：

```
POST {base}
Content-Type: application/json
Authorization: Bearer <见 c>
X-Watt-Context: <CallContext JWT，claims 同 §6.4a>     # 平台透传调用上下文（唯一载体，body 不重复）
X-Watt-Trace: <traceId>
X-Watt-Request-Id: <每次逻辑调用唯一；重试时不变，Plugin 以此去重实现幂等>

{"tool": "<Method>", "arguments": { ...方法参数按名传递... }}

→ 200 { ...方法返回值... }
→ 4xx/5xx WattError（§0.2 的 code↔HTTP 映射）；429 或 5xx 且 retryable=true 时平台按指数退避重试
```

`<Method>` 即该 kind 接口的方法名（`List`/`Get`/`Call`/`Verify`/`Decode`/`Encode`/`Send`/`OnEvent`/`Describe`……）；参数对象的字段名与 Proto 签名一致——可选的 `opts?: ListOptions` 作为整体对象传递，**不平铺**（如 `ContextProvider.List` → `{"tool":"List","arguments":{"path":"","opts":{"cursor":null}}}`）。

**b) 元端点（GET）**：

```
GET {base}/~help          # 必须：方法集合的 Help DSL（注册时做契约校验）
GET {base}/~skill         # 推荐：markdown 使用指南
GET {base}/~describe      # 必须：PluginLifecycle.Describe 的 JSON（HTBP 保留段扩展）
GET {base}{healthPath}    # 必须：PluginLifecycle.Health 的 JSON
```

**c) 认证**：`auth.kind='platform-token'` → 平台以自签 JWT 作 Bearer，Plugin 用注册响应给出的 `jwksUrl`（§11.2）取公钥验签；`auth.kind='bearer'` → 使用 manifest `secretRef` 指向的静态密钥。Plugin 回调平台则使用注册响应中的 `pluginToken`（scope = `requiredGrants`），入口为 `platformBaseUrl`。

**d) 大载荷**：单次请求/响应 ≤ 1 MiB；更大内容通过 `{ "$ref": "<预签名 URL 或 context:// URI>" }` 间接传递（与 `ContextEntry.content` 的 `$ref` 约定一致）。

**e) 超时**：平台默认 30s（Channel `Send` 10s）；Plugin 需在超时内响应或返回 `retryable` 错误。长活动作（如容器 harness 的 `OnEvent`）返回 `{accepted:true}` 后异步经 `agent.result` 回传（§3.4）。

---

## 附：接口 ↔ User Case 追溯矩阵

| 接口方法 | 支撑的 Case |
|---|---|
| `ChannelAdapter.Verify/Decode` + `EventBus.Publish` | 1(webhook), 2/3(飞书), 6(出站) |
| `Subscription.instanceBy='session'` | 3（群聊粘性） |
| `AgentRuntime.Spawn`（+ ttl, expect） | 2（N 个 subagent）, 3（临时派生） |
| `AgentRuntime.Send`（expect）+ `agent.result`/`agent.failed`（§3.4） | 1（Triage→Coding→QA→Review 接力推进）, 2（Master fan-in 汇总） |
| `ContextProvider.List/Get`（+ 可选 `Search`） | 1（历史反馈检索）, 3（@时召回：临时 namespace 挂 vector provider 走 Search，条目少时 List 全量） |
| `ContextProvider.Write/Update` | 1（登记 bug、回写结论）, 3（临时记录） |
| `NamespaceMount.ttl` | 3（临时 Context） |
| `ToolProvider.Call` + `Authorizer.Check` | 1（Logs/Trace 查询）, 2（websearch）, 4（财务工具拒绝） |
| `ToolProvider.Call`（git/CI 工具挂载，见 Architecture M4） | 1（推 PR、触发 CI/CD、部署测试环境） |
| `IdentityMapper.Resolve` + 委托链衰减 | 4（A/B 权限差异） |
| `TaskManager.Write` + `Signal` + `task.checkpoint`/`im.action`（§1.1） | 1（上线人类确认）, 2（方案先建 Task 再确认） |
| `ModelProviderRegistry.Write/Update` + `Metrics.Query` | 5（渠道运营） |
| `Scheduler.Write` + `CronJob.action`（publish/agent/script） | 6（"Agent 写脚本"= script 存 context://automations + 一次性 isolate 执行） |
