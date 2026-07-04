# Plugin

> 本文是 Watt Plugin 的编写指南：一个 Plugin 是什么、能提供什么能力、必须实现哪些契约、如何注册与调试。接口的规范性定义在 [Proto.md](./Proto.md)（本文引用其章节号）；Plugin 在整体架构中的位置见 [Architecture.md](./Architecture.md) M11。

## 1. 一句话定义

**Watt Plugin = 实现了某一层纯接口的、可注册的部署单元。**

平台的每个扩展点就是一层的一个接口；你不需要理解 Watt 的内部实现，只需要：

1. 挑一个 Plugin 类型（即挑一个接口）；
2. 用任意语言/托管方式实现该接口的 HTTP 契约；
3. 向 `PluginRegistry` 注册一份 manifest。

## 2. Plugin 能提供什么能力

| 类型（`kind`） | 实现的接口 | 给平台带来什么 | 典型例子 |
|---|---|---|---|
| `context-provider` | `ContextProvider`：**List / Get / Update / Write**（+ 可选 Search / Watch / Delete），Proto §4.1 | 一种新的上下文来源，挂载为 `context://<namespace>`，Agent 经 `/htbp/context/...` 读写 | 飞书文档、mem0、Notion、内部 Wiki |
| `tool-provider` | `ToolProvider`：**List / Get / Call**，Proto §5.1 | 一批新工具，挂载到 HTBP 工具树 `/htbp/tools/<path>` | 上游 MCP server、内部订单系统 API、CI 触发器 |
| `channel-adapter` | `ChannelAdapter`：**Verify / Decode / Encode / Send**（webhook 型；push 型长连接渠道可豁免 Verify/Decode，capabilities 声明 `push`，见 Proto §2.1 接入模式），Proto §2.1 | 一种新的事件渠道（入站+出站） | 飞书、钉钉、Slack、Telegram、Email |
| `agent-harness` | `AgentEndpoint`：**OnEvent / Describe**，Proto §3.3 | 一种新的 Agent 运行方式接入平台 | Flue、Claude Agent SDK 容器、自研 loop |

> 配置型扩展（新增模型渠道）不是 Plugin——那只是 `ModelProviderRegistry.Write` 的一条数据（Proto §9）。

**能力边界**：Plugin 只能做两件事——(a) 响应平台对上述接口的调用；(b) 用平台签发的 plugin token 回调平台接口（如 ChannelAdapter 把入站消息 `EventBus.Publish` 进来）。Plugin 拿不到其 manifest 中未声明的任何权限。

## 3. 通用契约（所有类型必须实现）

> 本节是导读；**规范性传输契约**（请求 envelope、`X-Watt-Context` 上下文头、重试/超时/大载荷规则）以 Proto §11.4 为准。

### 3.1 PluginLifecycle（Proto §11.2）

```
GET  <endpoint>/<healthPath>      → { "healthy": true }
GET  <endpoint>/~describe         → { "kind": "context-provider",
                                      "interfaceVersion": "context-provider/v1",
                                      "capabilities": ["search"] }
```

- `Describe.capabilities` 声明可选能力（如 ContextProvider 的 `search`/`watch`/`delete`）；未声明的可选方法平台永远不会调用。
- 平台周期性探活；连续失败会将 Plugin 标记为 unhealthy 并在 Dashboard 告警，但不会自动注销。

### 3.2 HTBP 自描述

Plugin 的 endpoint 本身就是一棵最小的 HTBP 树（见 Reference §2.1）：

```
GET  <endpoint>/~help     # 必须：接口全部方法的 Help DSL（方法名即 cmd 名）
GET  <endpoint>/~skill    # 推荐：markdown 使用指南（多步流程、危险操作、错误恢复）
POST <endpoint>           # 方法调用：body {"tool":"<Method>","arguments":{...}}
```

注册时平台会抓取 `~help` 做**契约校验**：方法集合与 `interfaceVersion` 声明的接口不符则拒绝挂载。这也意味着——写好 `~help`，你的 Plugin 就同时对人类（Dashboard 展示）和 LLM（Manage Agent 理解）自解释。

### 3.3 认证（双向）

| 方向 | 机制 |
|---|---|
| 平台 → Plugin | manifest 中声明：`platform-token`（平台签发的 JWT，Plugin 用平台公钥验签）或 `bearer`（你提供的静态密钥，经 Secrets 引用，不明文入库） |
| Plugin → 平台 | 注册成功后平台签发 **plugin token**，scope 严格等于 manifest 的 `requiredGrants`；调用 `/htbp/platform/...` 时作为 Bearer 携带 |

## 4. 编写步骤（以"飞书文档 Context Provider"为例）

**Step 1 — 实现四动词 + 元接口。** 任意语言、任意托管（推荐 Cloudflare Worker，也可以是你机房里的一个 HTTP 服务）：

```
POST /            {"tool":"List",  "arguments":{"path":"", "opts":{"cursor":null}}}
                  → {"items":[{"uri":"...","contentType":"text/markdown",...}], "cursor":null}
POST /            {"tool":"Get",   "arguments":{"path":"doccnX8..."}}
                  → {"uri":"...","content":"# 会议纪要 ...","version":"7","metadata":{...}}
POST /            {"tool":"Write", "arguments":{"path":"doccnY2...","entry":{...}}}
POST /            {"tool":"Update","arguments":{"path":"doccnY2...","patch":{...}}}
GET  /~help       → Help DSL（四条 cmd）
GET  /~describe   → {"kind":"context-provider","interfaceVersion":"context-provider/v1",
                     "capabilities":["search"]}    # 飞书支持全文检索 → 声明 search
GET  /healthz     → {"healthy":true}
```

动词映射由你决定语义合理即可：这里 `List`=列举知识库节点、`Get`=读文档转 markdown、`Write`=新建文档、`Update`=追加/改写块。飞书 app 凭证保存在 Plugin 自己一侧——平台永远不经手。

**Step 2 — 注册。** 调用 `PluginRegistry.Write`（Proto §11.1），Dashboard 表单或对 manage/platform Agent 说一句话都行：

```jsonc
{
  "id": "feishu-docs",
  "kind": "context-provider",
  "interfaceVersion": "context-provider/v1",
  "endpoint": "https://feishu-docs-provider.example.workers.dev",
  "auth": { "kind": "platform-token" },
  "requiredGrants": [],                 // 纯 Provider 不需要回调平台
  "healthPath": "/healthz",
  "enabled": true
}
```

平台自动执行：探活 → 抓 `~help` 契约校验 → 挂载生效。注册成功的响应是 `PluginRegistration`（Proto §11.2）：除 manifest 外还包含 `platformBaseUrl`（回调入口）、`jwksUrl`（验签 platform-token 的公钥集）与 `pluginToken`（回调平台的 Bearer）——妥善保存后两者。

**Step 3 — 挂载 namespace。** `ContextRegistry.Write`（Proto §4.2）把 Provider 绑定到一个 namespace：

```jsonc
{ "namespace": "docs/feishu", "provider": "feishu-docs" }
```

从此任何 Agent（含纯 HTTP Agent）都能：

```
GET  /htbp/context/docs/feishu/~help
POST /htbp/context/docs/feishu   {"tool":"Get","arguments":{"path":"doccnX8..."}}
```

**Step 4 — 授权。** 默认没有任何 Agent 能访问新 namespace；由 admin 写 Policy（Proto §6.2）：

```jsonc
{ "subject": "agent:triage", "resource": "context://docs/feishu/*",
  "actions": ["read"], "effect": "allow" }
```

其他类型的差异仅在 Step 1 实现的方法集合：`tool-provider` 实现 List/Get/Call 后经 `ToolRegistry.Write` 挂到工具树；`channel-adapter` 实现四方法（或 push 型的 Encode/Send + 自行 Publish）后经 `ChannelRegistry.Write` 启用，并在 manifest 的 `requiredGrants` 里声明 `{ resources: ["event://<channel>/*"], actions: ["write"] }`（对应 `EventBus.Publish` 的鉴权动作，见 Proto §2.3）；`agent-harness` 实现 OnEvent/Describe 后在 `AgentDefinition.entry` 中以 `{kind:'endpoint'}` 引用。

## 5. 部署形态

| 形态 | 适用 | 说明 |
|---|---|---|
| **平台内 Worker（推荐）** | 大多数 Provider/Adapter | 与平台同帐号部署，可直接使用 bindings（R2/D1/KV/Secrets）；冷启动毫秒级、空闲零成本 |
| **外部 HTTP 服务** | 依赖内网资源、非 JS 技术栈 | 任何能被平台 HTTPS 访问的服务；建议自带重试幂等（平台按 `retryable` 重试） |
| **Container** | agent-harness 需要完整 OS 时 | 镜像交给 M2 Heavy Runtime 管理，此时 Plugin 只是 `AgentDefinition.entry.container` 的引用 |

> **首个实例：飞书 channel-adapter plugin（`@watt/plugin-feishu`）。** 飞书作为 Watt 第一个真正独立可发行的 channel-adapter plugin 落地——独立 Worker（`watt-plugin-feishu`）、自包含全部渠道逻辑（验签/解密/decode/encode/send/凭据），与 gateway 零硬编码耦合。它采用 §2.1 的**自持回调型**接入：
> - **入站**：飞书开放平台事件订阅回调 URL 直接指向 plugin 的 `POST /webhook/event`。plugin 自行验签（`sha256(timestamp+nonce+encrypt_key+body)` 比对 `X-Lark-Signature`）+ 解密（AES-256-CBC，key=`sha256(encrypt_key)`，iv=密文前 16 字节）+ decode，再以 pluginToken 调平台 `POST /htbp/platform/event` Publish（`url_verification` challenge 握手在 plugin 侧短路）。支持两种模式：配 `ENCRYPT_KEY` → 验签+解密（推荐）；未配 → 明文 + `VERIFICATION_TOKEN` 比对。
> - **出站**：plugin 实现 §11.4 的 `Encode`/`Send` HTBP 面；平台的通用出站分发器（gateway consumer）对 `outbound.message` 事件调 plugin 的 `Send`（`tenant_access_token` 换取+缓存 + 飞书 REST 投递 + `SendReceipt.retryable` 语义）。
> - **凭据自持**：`FEISHU_APP_ID/SECRET/ENCRYPT_KEY/VERIFICATION_TOKEN` + `WATT_PLUGIN_TOKEN/WATT_BASE_URL` 是 plugin Worker 自己的 secrets——gateway 不再持有任何飞书凭据。
> - **本地开发**：飞书 WSClient（`@larksuiteoapi/node-sdk`，Node-only）长连接经 `watt channel connect` 本地长驻承载，作为 dev-only 路径（生产走 Worker webhook 回调）；两条路径复用同一份 plugin 纯逻辑（decode）。
> - **引导**：`watt setup feishu` 幂等编排注册（plugin register → channel Write → lurker/scribe def Write → policy ×2 → 打印部署/后台指引）。

## 6. 版本与兼容

- `interfaceVersion` 形如 `<kind>/v<major>`；平台对同一 major 保证向后兼容（只增可选字段/可选方法）。
- 破坏性变更 → 新 major 并行提供，旧版本进入弃用期；Plugin 升级 = 更新实现 + `PluginRegistry.Update` 改 `interfaceVersion`。
- Plugin 对未知字段必须忽略（与 HTBP 的"忽略未知行"一致），保证平台先行演进不破坏存量 Plugin。

## 7. 调试清单（发布前自查）

1. `curl <endpoint>/~help` —— Help DSL 是否列全了接口方法、每个 cmd 的参数/返回是否可读；
2. `curl <endpoint>/~describe` —— kind / interfaceVersion / capabilities 与实现一致；
3. 四动词幂等性：`Write` 重放同一 path 结果一致；`Update` 对不存在的 path 返回 `not_found`；
4. 错误形状：所有失败路径返回 `WattError`（Proto §0.2），`retryable` 标注正确；
5. 分页：`List` 超过一页时 `cursor` 往返可用；
6. 鉴权：不带（或带错）token 的请求必须被拒——两种 `auth.kind`（platform-token / bearer）都要求认证；
7. 注册到 staging 后，让 manage/platform Agent "试用一下这个新 Plugin"——LLM 能只靠 `~help`/`~skill` 正确调用，是接口自解释质量的最终验收。
