# 外部事实：Cloudflare 原语、外部仓库、模型渠道、飞书方案

> 真源：`Docs/Reference.md`（平台原语与外部项目）、`DOD.md` §9（已知外部前置实测）、followup 调查（gh 核实）。

## Cloudflare 原语选型表（Reference §3）

| 原语 | 用于 | 关键事实 |
|---|---|---|
| Agents SDK（`agents` 包） | Agent Runtime 基座（M2） | `Agent<Env,State>` 每实例一 DO（内嵌 SQLite），同名 ID 恒路由同一实例；`routeAgentRequest()`；生命周期钩子 `onStart/onRequest/onConnect/onMessage/onEmail/onStateChanged/...`；`this.schedule()` 持久化调度 |
| Durable Objects | 长驻 Agent/会话协调点 | 全局唯一单线程 + 就地 SQLite（10GB/对象 paid）；Alarms；WS Hibernation；**空闲零计费**（"廉价"依据）。限制：CPU 默认 30s（可配至 5min）、单值 ≤2MB |
| Workflows | Task（M7） | `step.do`（自动重试）、`step.sleep`（≤365 天）、`step.waitForEvent`；步骤 ≤10k，step 输出 ≤1MiB |
| Queues | 事件缓冲 + DLQ（M1） | 消息 ≤128KB（Event 信封上限依据）、5k msg/s/队列 |
| Cron Triggers | Scheduler（M6） | 分钟粒度、UTC；配置传播 ≤15min |
| R2 | Context 对象存储（M3） | S3 兼容，**零出口流量费**，$0.015/GB-月 |
| KV | 判定缓存/租户查找（M5/M4） | 全球最终一致；1 write/s/key |
| D1 | 策略/配置/审计/事件留痕 | Serverless SQLite，30 天 PITR，10GB/库 |
| Vectorize | vector Context Provider（M3） | ≤1536 维、10M 向量/索引 |
| Workers AI / AI Gateway | Model Provider + Observability（M8/M9） | 模型路由、缓存、fallback、token/费用分析 |
| Containers / Sandbox SDK | Heavy Runtime（M2） | `Container` 类以 DO 形式绑定，scale-to-zero，按 10ms 计费 |
| Email Routing / Workers / Service | 邮件渠道 | 入站 `email()` handler；出站需 Email Service onboard 发信域 |
| McpAgent + workers-oauth-provider | MCP 上游接入 | 每 MCP session = 一个 McpAgent = 一个 DO；`serve("/mcp")` Streamable HTTP；OAuth 2.1（DCR + PKCE） |

## 外部仓库归属（gh 已核实，2026-07-03）

| 仓库 | 状态 | 说明 |
|---|---|---|
| `TokenRollAI/tool-bridge` | **私有**，可访问（gh 账户 `Disdjj` 含 repo scope），默认分支 `main` | Tool Layer 参考实现/网关；线上 tool-bridge.fantacy.live；缺能力改上游（LOOP §2.1） |
| `TokenRollAI/HTBP` | 公开，默认分支 `main` | Tool Layer 协议契约（Draft，仅文档）；RFC-0001 在 `docs/rfcs/RFC-0001-htbp-core.md` |
| `withastro/flue` | 公开，"The sandbox agent framework"，Apache-2.0 | **Flue 真身**。Docs（LOOP/DOD/Reference）把 Flue 归为 TokenRollAI **属勘误**；`TokenRollAI/flue` 不存在。决策记录见 [../memory/decisions/flue-attribution.md](../memory/decisions/flue-attribution.md) |

HTBP 与 tool-bridge 二分：HTBP = 协议契约，tool-bridge = 参考实现；"MCP 在上游供给，HTBP 在下游供 Agent 消费"；tool-bridge 的 mount 节点桥接 Context。

## 模型渠道（DOD §9 已实测，两条路径均通）

1. **中转直连**：`https://llm.fantacy.live`（Anthropic Messages 格式，用 `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`）。
2. **AI Gateway custom provider**：`https://gateway.ai.cloudflare.com/v1/<ACCOUNT_ID>/watt-gateway/custom-tipsy/messages`；`glm-5.2` 与 `minimax-m3` 均通；请求头需 `cf-aig-authorization`（gateway 开了 authentication）+ `x-api-key`。M8 规范路径直接用 gateway，Case 5 的 analytics/缓存指标有原生数据源。

**模型调用 SDK = Vercel AI SDK**（`ai` + `@ai-sdk/anthropic` 的 `createAnthropic`），非 `@anthropic-ai/sdk`。理由：供应商中立（换 provider 只改工厂）、workerd 兼容。决策记录见 [../memory/decisions/model-call-sdk.md](../memory/decisions/model-call-sdk.md)。gateway 消费面在 `packages/gateway/src/agent/harness/anthropic-caller.ts`（单次 `generateText`，schema 校验重试留 `llm.ts`）。

**custom provider 三个易错点**：
1. 模型 ID 必须**小写**（`glm-5.2`，不是 `GLM-5.2`）。
2. custom provider 调用要加 **`custom-` 前缀**（`custom-tipsy`）。
3. 该 provider 的 base_url **已含 `/v1`**，路径写 `/messages`——写 `/v1/messages` 会 404。

## 飞书渠道方案要点（2026-07-04 R33 更新：webhook plugin 主路径）

- **主路径（R33 定案，Phase 6 ② 采证路径）**：独立 channel-adapter plugin `watt-plugin-feishu`（`packages/plugin-feishu`）自持 webhook 回调——challenge 握手 / 验签 / AES 解密 / decode / mentions 展开，以 pluginToken 调 `EventBus.Publish`；出站 §11.4 Encode/Send 面由 gateway 经 service binding 调入。决策记录：[../memory/decisions/feishu-plugin-webhook.md](../memory/decisions/feishu-plugin-webhook.md)。
- **回调域名境内约束**：workers.dev 境内被干扰，飞书回调 3s 握手必超时——回调面必须挂 custom domain（现为 `watt-feishu.pdjjq.org`；Universal SSL 只盖一级子域，勿用二级）。飞书后台「事件发送至开发者服务器」须保持 `https://watt-feishu.pdjjq.org/webhook/event`。
- **验签事实**：签名 = `sha256(timestamp + nonce + encrypt_key + body)` 纯拼接，**无分隔符、非 HMAC**（toolchain-pitfalls §61）。
- **权限事实**：bot 能否收到**非 @ 的群消息**取决于应用「接收群聊中所有消息」权限——缺则只有 @ 消息可达（lurker 群上下文无法累积）。
- **WS 长连接 push 型降为 dev-only 备用**（`watt channel connect`，`@larksuiteoapi/node-sdk` WSClient 是 Node SDK 不能跑 Workers isolate）；原决策 [../memory/decisions/feishu-websocket-channel.md](../memory/decisions/feishu-websocket-channel.md) 已被取代。
- 出站（Encode/Send 含 actions 卡片，飞书 REST API）已实测通过；测试群 "Tipsy Agent Infra" chat_id 已入 `.env`。

## 实现层 npm 依赖（不在 Reference.md 范围，来自 LOOP 成熟框架表）

`@larksuiteoapi/node-sdk`（飞书）、`jose`（JWT/JWKS）、`Hono`（HTTP 路由）、`zod`（校验/JSON Schema 互转）、`ai` + `@ai-sdk/anthropic`（模型调用；**版本锁 ai@6 + @ai-sdk/anthropic@3**，与 `agents@0.17.3` 的 `ai@^6` peer 一致，勿升 ai@7）、commander/citty/clipanion 择一（CLI）。Reference.md 定位为平台原语层，不覆盖这些库——落点缺口已记入 [../memory/doc-gaps.md](../memory/doc-gaps.md)。
