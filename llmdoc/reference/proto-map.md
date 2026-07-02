# Proto.md 契约检索地图与横切契约

> 实现轮次查接口契约的第一站。真源：`Docs/Proto.md`（~1050 行）。所有接口方法均为异步（返回 `Promise<T>`，文档省略）。模块归属查 [../architecture/modules-and-flows.md](../architecture/modules-and-flows.md)。

## 章节地图（§ → 主题 → 一句话）

| § | 主题 | 一句话 |
|---|---|---|
| §0 | 通用约定 | URI 体系、通用类型、CallContext、CRUD 四动词全局基线 |
| §0.1 | 资源 URI | 一切可授权资源统一 `<scheme>://` URI（context/tool/agent/agent-instance/event/task/cron/model/plugin/platform） |
| §0.2 | 通用类型 | `URI`/`Timestamp`/`Page<T>`/`ListOptions`/`WattError` + HTTP 映射（含 401/501 规范性补充）+ 重试规则 |
| §0.3 | CallContext | principal/roles/agent 链/traceId，传输层隐式携带 |
| §0.4 | CRUD 动词 | Registry 类 = List/Get/Write(upsert)/Update(patch)；Delete 可选；Provider 类由领域定 |
| §1 | Event 信封 | 一切进出平台的消息统一为 `Event`；≤128KB；出站复用信封 `type:"outbound.message"` |
| §1.1 | 规范化事件（HITL） | `task.checkpoint` + `im.action` + 两条内置路由规则闭合人类确认环 |
| §2 | Event Gateway | §2.1 ChannelAdapter（Verify/Decode/Encode/Send，webhook 型 vs push 型）；§2.2 ChannelRegistry；§2.3 EventBus（三类订阅）；§2.4 EventStore |
| §3 | Agent Runtime | §3.1 AgentRegistry（AgentDefinition：runtime light/heavy/external、grants、subscriptions）；§3.2 AgentRuntime（Spawn/Send/... + ExpectSpec）；§3.3 AgentEndpoint（仅 OnEvent+Describe）；§3.4 结果回传协议（规范性） |
| §4 | Context Layer | §4.1 ContextProvider 四动词+可选 Search/Watch/Delete；§4.2 ContextRegistry（NamespaceMount + Resolve + Delete 卸载） |
| §5 | Tool Layer | §5.1 ToolProvider（List/Get/Call；ToolSpec 含 effect/scope/confirm/skill）；§5.2 ToolRegistry（ToolMount + 虚拟化 prefix/rename/hide/describeOverride） |
| §6 | Auth | §6.1 Authorizer（Check/CheckBatch，"只衰减"公式）；§6.2 PolicyStore（deny 优先）；§6.3 IdentityMapper；§6.4 Token claims 与判定细则；§6.5 User Token 与 admin bootstrap（§6.5d CLI device flow） |
| §7 | Scheduler | Cron CRUD + Trigger；action = publish/agent/script |
| §8 | Task | TaskManager + 7 态状态机 + Signal + checkpoint；§8.1 动态编排为**非规范性预留**（当前不实现） |
| §9 | Model Provider | ModelProviderRegistry（渠道 CRUD）+ ModelRouter.Route（内部路由，endpoint 是网络地址非资源 URI） |
| §10 | Observability | Metrics.Query + AuditLog List/Get |
| §11 | Plugin System | §11.1 PluginRegistry（PluginManifest）；§11.2 PluginLifecycle（Health/Describe）；§11.3 传输绑定（HTBP 默认 / MCP）；§11.4 Plugin 传输契约（规范性） |
| 附 | 追溯矩阵 | 接口方法 ↔ User Case 1-6 对应表 |

## 横切契约一：Event 信封（§1）

字段：`id`（平台生成全局唯一）、`source: EventSource`（`kind` = im/webhook/email/cron/agent/system，可选 `channel`/`ref`）、`type`（开放集合点分命名：`im.message`/`im.mention`/`im.action`/`im.bot_joined`/`webhook.received`/`cron.fired`/`cron.completed`/`agent.message`/`agent.result`/`agent.failed`/`task.checkpoint`/`email.received`）、`session?`（会话粘性键 `"<channel>:<scope>:<id>"`，由 Decode 生成）、`principal?`（平台补齐）、`channelUser?{channel,userId}`、`dedupeKey?`（支持重投的渠道 Decode 必填）、`payload: unknown`、`raw?`（审计用可截断）、`occurredAt`、`traceId`。

- **尺寸**：序列化总尺寸 ≤128 KB（对齐 Queues 上限）。超限大内容先落 Context/R2，payload 以 `{ "$ref": "<context:// URI 或预签名 URL>" }` 引用；raw 超限强制截断并在 metadata 标 `truncated`。
- **去重**：相同 `dedupeKey` 的重复 Publish 在时间窗内幂等返回原 `eventId`（窗长未定量，见 doc-gaps）。
- **出站**：`type:"outbound.message"`，payload = `OutboundMessage{channel,target,content:MessageContent,replyTo?}`；`MessageContent{text?(Markdown 子集)/blocks?/actions?:ActionButton[]}`；`ActionButton{id,label,signal?}`——signal 存在则点击后平台自动转 `TaskManager.Signal`。

### HITL 规范化事件（§1.1）

- `task.checkpoint`（`TaskCheckpointPayload{taskId/checkpoint/prompt/options(approve|reject|custom)[]/notify{channel,target}}`）：Task 进入 `waiting_human` 时由引擎 Publish。
- `im.action`（`ImActionPayload{actionId/signal?}`）：用户点按钮时 Decode 产出。
- 内置路由规则（system subscriber，不占用户订阅表）：① `task.checkpoint` → 按 notify 构造带 actions 卡片出站；② `im.action` 且有 signal → 校验 `Check(context, task://<taskId>, 'signal')` 后调 `TaskManager.Signal(taskId,{checkpoint,decision})`。

## 横切契约二：CallContext（§0.3）

```
CallContext {
  principal: PrincipalRef   // 最终受益人；无人类受益人的系统任务允许 agent:/service: 作 principal
  roles: string[]           // IdentityMapper.Resolve 产物
  agent?: AgentChainRef     // { instanceId; chain: string[] } chain 为根→当前链段（实例 ID 或系统段 "cron:<jobId>"）
  traceId: string
}
PrincipalRef = "user:alice" | "service:ci" | "agent:finance"（定义级）
```

要点：实例身份走 claims 的 `agent_inst`，**不作 principal**。HTTP 绑定下 CallContext 一律只经 `X-Watt-Context` 头承载，body 不重复；冲突以 header 为准（§3.3、§11.4a）。

## 横切契约三：Authorizer.Check 判定算法（§6.4c，逐条）

判定公式（§6.1）：`allow = P(principal) ∩ P(agent 定义 grants) ∩ P(链上每个祖先)`；权限只能沿派生链**衰减**。

对 `(resource, action)` 四步：
1. **求 principal 许可**：以 claims 的 `sub` + `roles` 匹配的 Policy 集判定（**deny 优先**）。
2. **求 Agent 定义上限**：`AgentRegistry.Get(agent_def).grants` 是否覆盖；claims 无 `agent_*` 段（纯人类/服务调用，**见 §6.5b**——原文错引"见 e"已于 2026-07-02 修正）时**跳过步骤 2/3**。
3. **沿 chain 逐段重复步骤 2**：实例 ID 段取其 `agent_def.grants`；系统段 `cron:<jobId>` 规则（2026-07-02 回写明确）——`action.kind='script'` 取 `action.grants`；**`kind='agent'`/`'publish'` 不追加上限段**；job 已禁用/删除 → 该环空集 → **deny**。
4. **全部环节允许才 allow**。实现可用 KV 缓存各段结果；Policy/grants 变更使缓存失效。

补充规则：
- **subject 匹配（§6.4b）**：`user:/service:<id>`→claims.sub；`role:<name>`→claims.roles 含之；`agent:<def>`→claims.agent_def；`agent-instance:<id>`→claims.agent_inst；`*`→任意。
- **工具动作映射（§6.4d）**：`ToolSpec.scope` 存在则 action = 该 scope 字符串（如 `finance.read`）；否则 action = `"invoke"`。
- **user token（§6.5b）**：`CallContext.agent` 缺省时只执行步骤 1。
- **AccessDecision**：`allow` + `reason?`（deny 时可读解释）+ `obligations?:('require_confirm'|'audit_verbose')[]`。

### CLI 设备授权（§6.5d，2026-07-02 规范性补充）

`watt login` 走 RFC 8628 Device Authorization Grant 最小子集，三端点挂平台根：

- `POST /oauth/device/authorize`（无认证）→ `{device_code, user_code, verification_uri, expires_in(默认 600s), interval(默认 5s)}`；user_code 8 位大写字母数字。
- 确认：Dashboard 页面；Dashboard 未上线前允许 admin 用已有 token 调 `POST /oauth/device/approve` `{user_code, principal}` 代替。
- `POST /oauth/token` `{grant_type:"urn:ietf:params:oauth:grant-type:device_code", device_code}` → 未确认 `{error:"authorization_pending"}`（HTTP 400，RFC 8628 §3.5 形状）；已确认 → `{access_token, token_type:"Bearer", expires_in}`。
- **错误形状豁免**：OAuth 端点整体在 WattError 契约之外，遵循 RFC 裸 OAuth 错误形状（approve 是平台管理动作，**仍走 WattError**——边界见 [../memory/decisions/auth-implementation.md](../memory/decisions/auth-implementation.md)）。
- 非交互环境（CI/loop）不走 device flow：直接以 `WATT_TOKEN` 环境变量提供 token（本地用平台私钥离线签发，见 `scripts/sign-admin-token.mjs`）。

## 横切契约四：WattError（§0.2）

7 码：`not_found`/`permission_denied`/`invalid_argument`/`conflict`/`unavailable`/`rate_limited`/`internal`。字段 `code`/`message`（面向 LLM/人）/`retryable:boolean`。

HTTP 映射（规范性）：not_found→404、permission_denied→403、invalid_argument→400、conflict→409、rate_limited→429、unavailable→503、internal→500。

规范性补充（2026-07-02 Phase 0 关门回写 §0.2）：
- **未认证 401 → code `permission_denied`**（裸 WattError body）。
- **未实现 501 → code `unavailable`**（裸 WattError body）。
- 7 码不扩容，401/501 复用现有码。决策见 [../memory/decisions/bare-watterror-body.md](../memory/decisions/bare-watterror-body.md)。

**错误 body 形状（§11.3）**：HTTP 错误响应 body 就是**裸 WattError 对象**（`{code,message,retryable}`），**没有 `{error:...}` 信封**。

重试约束：`retryable=true` 仅允许出现在 `rate_limited`/`unavailable`/`internal`；平台对 429 与 5xx 且 retryable=true 按指数退避重试。

## §3.4 结果回传协议：六条路由规则

两个事件 payload：
- `agent.result`：`AgentResultPayload{correlationId/instanceId/output(≤1 MiB，更大放 Context 用 artifacts 引)/artifacts?:URI[]}`。
- `agent.failed`：`AgentFailedPayload{correlationId/instanceId/reason('error'|'timeout'|'terminated'|'rejected'|'invalid_output')/error?:WattError}`。

correlationId：由 `Send`/`Spawn` 的 expect 生成或透传；缺省平台生成并回传；字符集 `[A-Za-z0-9_-]`、长度 ≤80，违规 → `invalid_argument`。

六条规则：
1. **定向回送**：带 correlationId 的 result/failed 不进通用订阅匹配，直投等待方（Send 调用者的 OnEvent / Task 步骤的 waitForEvent）。
2. **派生自动回送**：`Spawn(expect)` 的子实例结果自动回送父实例。
3. **超时代发**：`expect.timeoutMs` 到期，平台代发 `agent.failed(reason='timeout')`（幂等：真实结果后到则丢弃记审计）；平台不隐式重试。
4. **终止即失败**：等待中实例被 Terminate（含级联），未完成 correlation 代发 `agent.failed(reason='terminated')`。
5. **等待方先消失**：到达的 result/failed 丢弃记审计（EventStore 照常留痕）。
6. **结果去重**：同一 correlationId 首个结果生效，其后丢弃记审计。

`ExpectSpec`（§3.2）：`correlationId?/timeoutMs?/schema?`——schema 为 JSON Schema 约束 output 形状，回送前校验，不符退回子实例重试最多 N 次（N 实现声明），仍失败 → `agent.failed(reason='invalid_output')`。

**Workflows 适配（规范映射）**：Workflows waitForEvent 事件 type 仅 `[A-Za-z0-9_-]`、≤100 字符、禁 `.`。`agent.result`/`agent.failed` 进入 Workflows **归并为同一 type** `agent-result-<correlationId>`，payload 带 `status:'result'|'failed'`；人类确认同理 `task-signal-<checkpoint>`。waitForEvent 默认超时 24h、上限 365 天——Task 引擎在 waiting_human/waiting_event 检查点必须显式设超时并捕获转 checkpoint 超时语义。净化只发生在 Workflows 适配层，平台层保持点分。

## HTBP 树与四动词签名

树三分支（§11.3a）：`/htbp/tools/<mount-path>/...`、`/htbp/context/<namespace>/...`、`/htbp/platform/<module>`（agent/task/scheduler/event/...）。

- 元端点：`GET .../~help`（Help DSL，方法名即 cmd）、`GET .../~skill`（指南）；根 `GET /htbp/~help` 渐进发现整棵树。Plugin 侧另有 `GET {base}/~describe`（必须）与 healthPath（必须，§11.4b）。
- 方法调用：`POST <节点路径>`，body `{"tool":"<Method>","arguments":{...}}`；`opts` 作整体对象传递**不平铺**（§11.4a）。
- 认证：`Authorization: Bearer <Agent Token 或 user token>`；List/~help 按权限裁剪。
- 错误：HTTP 状态码 + body 为**裸 WattError**（无信封，§11.3）。
- MCP 绑定（§11.3b）：`watt-platform` MCP server（Streamable HTTP `/mcp`），方法名 `<module>_<method>`（如 `context_list`、`agent_spawn`）；Context 条目同时以 MCP resource 暴露（对应 Watch）；OAuth 2.1。

**Context 四动词（§4.1 ContextProvider）**：
- `List(path, opts?): Page<ContextEntryMeta>` — namespace 内相对前缀，浅层+分页。
- `Get(path): ContextEntry` — 含内容。
- `Update(path, patch: ContextPatch): ContextEntryMeta` — 部分更新；不存在 → not_found。
- `Write(path, entry: ContextEntryInput): ContextEntryMeta` — 创建或整体替换。
- 可选（capability 声明于 Describe）：`Search?/Watch?/Delete?`。
- 乐观并发经 `ifVersion`，不匹配 → conflict。

**Tool 三动词（§5.1 ToolProvider）**：`List(opts): Page<ToolMeta>`（可见性裁剪由 Tool Gateway 做，Provider 不感知调用者）、`Get(toolName): ToolSpec`（~help 数据源）、`Call(toolName, args): ToolResult{ok/content/error?}`。`ToolMeta{name(虚拟名)/summary/effect:'read'|'write'|'destructive'}`；`ToolSpec` 另含 `inputSchema/outputSchema?/scope?/confirm?/skill?`。

## 24 个接口面清单

| 接口 | 关键方法 | 所属 |
|---|---|---|
| ChannelAdapter | Verify(RawInbound)→bool；Decode(RawInbound)→Partial<Event>[]；Encode(OutboundMessage)→RawOutbound；Send(RawOutbound)→SendReceipt | §2.1（Plugin） |
| ChannelRegistry | List/Get/Write/Update → ChannelConfig | §2.2 |
| EventBus | Publish(Omit<Event,'id'\|'traceId'\|'occurredAt'>)→{eventId}；Subscribe→{subscriptionId}；Unsubscribe；ListSubscriptions | §2.3 |
| EventStore | List(filter type/channel/session/时间)→Page<Event>；Get(eventId) | §2.4 |
| AgentRegistry | List/Get(name)/Write/Update → AgentDefinition | §3.1 |
| AgentRuntime | Spawn(SpawnRequest)→{instance,correlationId?}；Send(id,event,expect?)→{accepted,correlationId?}；Status；Interrupt(非 MVP)；Terminate(id,{cascade?})；ListInstances(opts&{tree?}) | §3.2 |
| AgentEndpoint | OnEvent(event,ctx)→{accepted}；Describe()→{name,harness,capabilities,healthy} | §3.3（Agent 侧最小义务） |
| ContextProvider | List/Get/Update/Write + 可选 Search/Watch/Delete | §4.1（Plugin） |
| ContextRegistry | List/Get(namespace)/Write(mount)/Update/Delete(卸载)/Resolve(uri)→{provider,path} | §4.2 |
| ToolProvider | List→Page<ToolMeta>；Get→ToolSpec；Call→ToolResult | §5.1（Plugin） |
| ToolRegistry | List/Get(mountPath)/Write/Update → ToolMount（含 virtualize） | §5.2 |
| Authorizer | Check(AccessRequest)→AccessDecision；CheckBatch（List 裁剪用） | §6.1 |
| PolicyStore | List/Get/Write/Update → Policy | §6.2 |
| IdentityMapper | Resolve(channel,channelUserId)→{principal,roles}；ResolvePrincipal(principal)→{roles} | §6.3 |
| Scheduler | List/Get/Write/Update/Trigger(jobId)→{eventId}/Delete → CronJob | §7 |
| TaskManager | List/Get→TaskDetail；ListDefinitions；Write({definition,input?,taskId?})→TaskInfo；Update(taskId,{note?})；Cancel；Signal(taskId,{checkpoint,decision,payload?}) | §8 |
| ModelProviderRegistry | List/Get/Write/Update → ModelProvider | §9 |
| ModelRouter | Route({model,agent?})→{provider,model,endpoint}（内部接口） | §9 |
| Metrics | Query(MetricQuery)→MetricSeries[] | §10 |
| AuditLog | List(filter principal/agent/resource/decision)→Page<AuditRecord>；Get | §10 |
| PluginRegistry | List/Get/Write(manifest)→PluginRegistration/Update → PluginManifest | §11.1 |
| PluginLifecycle | Health()→{healthy,detail?}；Describe()→{kind,interfaceVersion,capabilities,listDefaults?} | §11.2 |

注记：Registry 四动词（§0.4）统一适用于 AgentRegistry / ToolRegistry / ChannelRegistry / PolicyStore / Scheduler / ModelProviderRegistry / PluginRegistry / ContextRegistry（后者另有 Delete/Resolve）。

已知契约缺口（ExpectSpec 未定量、dedupeKey 时间窗等）见 [../memory/doc-gaps.md](../memory/doc-gaps.md)。§6.4c 交叉引用错位、cron grants 矛盾、501 错误码三项已于 2026-07-02 回写 Proto 闭环。
