# 当前项目状态快照

> 本文档随轮次更新。最后更新：2026-07-04（Round 34 维护轮：飞书群 agent 工具链路线上配置修复，**Phase 0~7 全关门 + Phase 6 ② 已采证——项目全部 Done**）。

## 阶段

- 规格真源：`Docs/{Vision,Architecture,Proto,Plugin,Reference}.md` + `DOD.md`（验收）+ `LOOP.md`（执行契约）。
- **Phase 0~7 全部关门**（0~5 于 R3/7/10/13/18/22；6 于 R27；7 于 R32 六条 E2E 全绿）。**Phase 6 ② @feishu 入站真实群消息已采证**（R33：webhook plugin 主路径，真实群 @watt 收到回复，用户截图 + events/audit 双留痕）→ **DOD §0 五条全局 Done 全部成立，项目全部 Done**，转入维护/可用性迭代。
- **R33 可用性冲刺新增面**（六期并行 + 线上实测增补，详见 PROGRESS Round 33 与 4 个新决策记录）：
  - `packages/plugin-feishu` — 独立 Worker `watt-plugin-feishu`（第一个 watt-plugins/* 实例）：自持 webhook 回调（验签/AES 解密/decode/mentions 展开/Publish）+ §11.4 Encode/Send 面 + 凭据自持；custom domain `watt-feishu.pdjjq.org`。决策见 [../memory/decisions/feishu-plugin-webhook.md](../memory/decisions/feishu-plugin-webhook.md)。
  - gateway `src/event/plugin-sender.ts` — **通用出站分发器**（adapter→`channel-<adapter>`（settings.pluginId 可覆盖）→PluginRegistry→`binding:` service binding / HTTPS §11.4 Send）；**feishu-sender 已删，FEISHU_* 移出 gateway**。决策见 [../memory/decisions/plugin-outbound-dispatcher.md](../memory/decisions/plugin-outbound-dispatcher.md)。
  - htbp 三工具（`harness/htbp-tools.ts`：htbp_help/skill/call，scope 前缀约束 + Check PEP + deny 回喂；tools-proxy 抽取 `tools/tool-invoker.ts`）+ `AgentDefinition.systemPrompt`（Proto §3.1 先行）；spawn 落 toolScopes/systemPrompt 进 state。
  - **SecretStore** — `platform://secret` 四动词永不回显；AES-256-GCM + `WATT_SECRET_ENCRYPTION_KEY`；resolveSecret env 优先→KV 回退链。决策见 [../memory/decisions/secretstore-runtime-keys.md](../memory/decisions/secretstore-runtime-keys.md)。
  - CLI 改名 **`@tokenroll/watt`**（tsup bundle dist/bin.js + `release:cli`；**npm 未真发布**）+ 新命令族 `watt init`（TUI 九步向导）/ `watt setup feishu`（幂等五步）/ `watt secret`（三命令，值走 stdin）。
  - dashboard 三配置视图（SecretsView / ChannelsView（feishu plugin 状态卡）/ ProvidersView（secretRef 下拉））。
  - lurker 接真实 LLM（default provider caller + state.toolScopes 工具 + scratch 上下文进 system）；**re-Spawn 复活 terminated 实例**（Proto §3.2 已补，Send 不复活）；**Authorizer 接 AgentDefLoader**（agent 主体 PEP 误拒系统性收口）。决策见 [../memory/decisions/agent-spawn-revive-and-defloader.md](../memory/decisions/agent-spawn-revive-and-defloader.md)。
- **R33 遗留清单**：npm publish 未真执行（`pnpm release:cli`，@tokenroll org 权限待人工）；`watt init` 真实账户全程未跑（交互式 TUI，建议前缀 watt-init-test）；飞书 app 缺「接收群聊中所有消息」权限（群上下文只累积 @ 消息）；未配 ENCRYPT_KEY（明文+token 校验模式，建议后台生成后 secret put 到 plugin）；admin token 1h 短命且轮换连坐 pluginToken（运维摩擦，可考虑 init 的 7d token 或独立 plugin 签名面）；~~httpbin.org 桩工具不稳~~（**R34 已收口**：test/echo get-uuid 已 remount 到 httpbingo.org/uuid）。
- 历史 backlog：Phase 5（script 能力表已扩 watt.queryMetric，模板 def 已种子化——基本收口，见 doc-gaps #29）；Phase 4 的 13 MINOR + Phase 3 的 14 MINOR + Phase 2 的 17 MINOR + R27 的 19 MINOR + R32 的 16 MINOR，维护态顺手修；实现声明簇见 doc-gaps #25~#28/#31。
- Phase 路线：0 骨架/部署管道 → 1 Auth+Event 信封 → 2 Event Gateway → 3 Context Layer → 4 Tool+Agent Runtime → 5 Task+Scheduler → 6 飞书+Observability+Management → 7 六条 E2E 验收（详见 [../overview/project-overview.md](../overview/project-overview.md)）。
- 上游 tool-bridge：分支 `feat/watt-builtin-and-tool-semantics`（56ab13b，已 push 未开 PR/未合 main）——ToolSpec effect/scope/confirm 语义字段 + builtin 节点类型。Watt 侧以 vendored 方式消费（见下）。

## 源码现状（Round 33 后，测试共 **1233 passed / 1 skipped**：shared 6 + dashboard 18 + core 411 + plugin-feishu 47 + cli 175 + gateway 576+1skip；core 覆盖率 100%，门禁挂 verify）

Phase 6 新增面（R23~R27，详表见 PROGRESS 对应轮）：gateway `src/audit/`（AuditStore + Authorizer wrapper 单点 writeAudit，watt-audit 0001）、`src/metrics/`（usage 表 D1+AE 双写 + Metrics.Query + /htbp/platform/metrics）、`src/plugin/`（PluginRegistry watt-providers 0004 + 内置 webhook/feishu 种子 + Write 注册探活）、`src/agent/manage/`（manage/cron·platform 种子 def + scheduler 工具绑定）、CORS 中间件；core `src/channel/feishu.ts`（WS 事件 decode / 卡片 encode）；cli `channel connect`（WSClient + supervisor 重连，**R33 起降为 dev-only 备用**）、`metrics query`、`plugin register|list|health`、`status` 汇总；**packages/dashboard**（Vite+React Pages SPA：Overview/Agents/Tasks/Cron/Audit + **R33 Secrets/Channels/Providers 配置视图**）。Phase 7 新增面：`scripts/e2e/{lib,index,e2e-1..6}.ts`（`pnpm e2e`；E2E_LLM/E2E_FEISHU 门控）；echo def 种子化；harness 接 default provider（'default' 哨兵）；script watt.queryMetric；模板真实化；lurker/scribe 潜伏 agent；sign-admin-token --extra 多身份。

- `packages/shared` — `WattError`（规范 7 码，裸 body 契约见 [../memory/decisions/bare-watterror-body.md](../memory/decisions/bare-watterror-body.md)）。
- `packages/core`（@watt/core，平台核心纯逻辑，零 Cloudflare 依赖）：
  - `src/authz/` — `authorize()` §6.4c 四步判定 + subject 匹配 + 工具动作映射。
  - `src/event/` — Event 信封（128KB 上限、DedupeStore、normalizeEvent occurredAt 保留语义、eventInputSchema）。
  - `src/auth/` — `jwt.ts`（jose Ed25519）+ `device-flow.ts`（RFC 8628）。
  - `src/eventbus/` — 订阅匹配/instanceKey/inbound/outbound/hmac 纯逻辑（详见 Round 8 记录与 doc-gap #23）。
  - `src/context/` — Context Layer 纯逻辑（types/resolve/ttl/verbs/help，实现声明 doc-gaps #26）。
  - `src/agent/` — `types.ts`（AgentDefinition（**R33 增 systemPrompt**）/SpawnRequest/ExpectSpec/AgentResult/AgentFailed zod）、`correlation.ts`、`routing.ts`（§3.4 六条规则纯判定）、`expect-schema.ts`（JSON Schema 五关键字子集，schema 重试 maxAttempts=3 → invalid_output）、`model-provider.ts`。Spawn 幂等键复用 eventbus resolveInstanceKey。
  - `src/tools/` — `types.ts`（toolMountSchema §5.2：mcp/http/builtin + virtualize 四项）。
  - `src/task/` — `types.ts`（TaskInfo 7 态/TaskDetail/SignalRequest/SchedulerCronJob）、`signal.ts`、`event-names.ts`、`cron.ts`（五段分钟级子集手写解析，toolchain-pitfalls §43）、`checkpoint.ts`。
  - `src/channel/feishu.ts` — 飞书事件 decode / 卡片 encode 纯逻辑（webhook 与 WS 共用）。
- `packages/toolbridge` — **vendored** 上游 `TokenRollAI/tool-bridge` worker 源码 **@56ab13b**（vendor src/worker + ASSETS patch + patch 守卫脚本；升级流程见该包 README.md）。部署为独立 Worker `watt-toolbridge`。
- **`packages/plugin-feishu`（R33 新增）** — 独立 Worker `watt-plugin-feishu`，第一个 watt-plugins/* 实例：`/webhook/event` 自持回调（challenge 握手 + 验签（纯 sha256 拼接非 HMAC，pitfalls §61）+ AES 解密 + decode + mentions 展开 + 以 pluginToken 调平台 Publish）+ §11.4 Encode/Send 面（gateway 经 service binding 调入）+ FEISHU_* 凭据自持。
- `packages/gateway`（Hono Worker，入口 export fetch/queue + 四个 DO 类）：
  - `src/authz/` `src/event/` `src/context/` `src/http/{auth,errors,oauth,routes,context-routes,inbound}` — Phase 1~3 面（详见 doc-gaps #25/#26/#27 与 PROGRESS Round 5~13）。
  - `src/agent/` — `agent-instance.ts`（AgentInstance = Agents SDK Agent 类，DO；**R33：spawn 落 toolScopes/systemPrompt 进 state；re-Spawn 复活 terminated 并按当前 def 重新快照**）、`harness/`（echo + llm；模型调用经 Vercel AI SDK ai@6 + @ai-sdk/anthropic@3，AbortSignal.timeout(60s)；**htbp-tools.ts 三工具 R33**；`lurker.ts` 潜伏 harness R31/**R33 LLM 化**）、`agent-correlation.ts`（直投 waiter + 三态 settle + 超时 alarm 代发）、`agent-registry.ts`、`agent-runtime.ts`（Spawn 幂等 / Send 先查索引防幽灵 / Terminate cascade / ListInstances tree）、`model-provider.ts`（0003，set-default）。**Authorizer 经 AgentDefLoader 惰性播种 claims.agent_def（R33）**。
  - `src/tools/` — `tool-registry.ts`（watt-providers 0001）+ `tool-invoker.ts`（R33 从 tools-proxy 抽取，htbp 工具与代理共用）。
  - `src/task/` — `watt-task-workflow.ts`（WattTaskWorkflow = Workflows WorkflowEntrypoint，deep-research N=3 fan-in + auto-delivery-lite 两模板真实化 R29/30；taskId 即 instanceId 免映射；checkpoint waitForEvent 超时 human 10min/agent 5min）、`task-store.ts`、`task-manager.ts`（七动词）、`task-events.ts`。HITL 闭环：consumer 真实 TaskSignaler + Check(task://,'signal')。
  - `src/scheduler/` — `scheduler-hub.ts`（SchedulerHub = Agents SDK Agent DO）、`actions.ts`（publish/agent/script 三 action 双留痕）、`script-runner.ts`（可注入抽象，[../memory/decisions/scheduler-script-runner.md](../memory/decisions/scheduler-script-runner.md)）、`scheduler-manager.ts`。script 能力面 = watt.publish + watt.queryMetric（R28）。
  - `src/event/plugin-sender.ts`（**R33，替换已删的 feishu-sender**）— 通用出站分发器：adapter→`channel-<adapter>`（settings.pluginId 可覆盖）→PluginRegistry→binding:/HTTPS 双形态 §11.4 Send（platform-token + X-Watt-Request-Id 幂等 + 10s 超时 + retryable 重投）。
  - `src/secret/`（R33）— SecretStore（AES-256-GCM + AAD=名字 + KV_TENANTS `secret:` 前缀）+ `/htbp/platform/secret` 四动词永不回显 + resolveSecret env→KV 回退链（keys.ts JWT 私钥明确排除）。
  - `src/http/tools-proxy.ts` — /htbp/tools 代理：认证→Check PEP→service binding TOOLBRIDGE 转发→call 信封归一化→syncTenantTree。
  - `src/event/agent-deliverer.ts` — consumer agent sink 真实投递；routeResult 三态 peek→deliver→confirm。
  - migrations：`migrations/0001~0002`（watt-policies）、`migrations-events/0001~0002`（watt-events）、`migrations-context/0001`、`migrations-providers/0001~0004`、`migrations-audit/0001`。
- `packages/cli`（包名 **`@tokenroll/watt`**，R33 改名 + tsup bundle）— **十六命令族**：`status` / `login` / `whoami` / `policy` / `audit` / `event` / `channel`（connect 降 dev-only）/ `context` / `tool` / `agent` / `provider` / `task` / `cron` / **`init`（TUI 九步：auth→问答→provision TS 移植→模板渲染→migrations→信任根三 secret→同进程本地签首 admin token→deploy→SecretStore 写可选密钥；`--resume`/`--resign-admin`）** / **`setup feishu`（幂等五步）** / **`secret`（三命令，值走 stdin）**。部署产物随包（build:deploy esbuild 3 worker + 模板 + migrations + dashboard dist；tarball 684K）。token 顺序 `WATT_TOKEN` env > `~/.watt/credentials.json`（0600）。

### 关键契约（Round 18 锁定，后续轮增补）

- **HTBP tools call 请求形状**：工具名走 URL end-path、body 是 `{arguments}` 信封；gateway 代理按 provider 归一化（toolchain-pitfalls §38）。
- **correlation settled 三态**：pending → delivering → settled；投递成功才 settle，失败 rollback + retry。
- **模型调用超时 60s**；**TERMINATED_TTL 7d**；**re-Spawn 复活 terminated（Send 不复活，幽灵防护不变）**。
- http mount 的 providerConfig 必须是上游 HttpEndpointConfig 形状 `{endpoints:[...]}`。
- Context 响应信封形状真源 = gateway 路由测试，CLI 精确解包禁双形态兜底（doc-gap #27⑥）。
- **taskId 即 Workflows instanceId**（[../memory/decisions/task-workflow-instance-id.md](../memory/decisions/task-workflow-instance-id.md)）；Task 状态权威态在 TaskStore 状态表（toolchain-pitfalls §41）。
- **出站分发契约（R33）**：adapter → plugin id `channel-<adapter>`（settings.pluginId 可覆盖）；同账户走 `binding:`，跨账户 HTTPS `{"tool":"Send"}`（[../memory/decisions/plugin-outbound-dispatcher.md](../memory/decisions/plugin-outbound-dispatcher.md)）。
- **密钥引用契约（R33）**：`secretRef` 经 resolveSecret env 优先→SecretStore KV 回退；secret 永不回显。

## 部署现状

- **三 Worker 拓扑（R33）**：`watt-toolbridge` → `watt-plugin-feishu`（channel-adapter plugin，凭据自持；**custom domain `watt-feishu.pdjjq.org`**——workers.dev 境内被干扰，飞书回调必超时）→ `watt-gateway`（service binding `TOOLBRIDGE` + **`FEISHU_PLUGIN`**）。**deploy 顺序必须 toolbridge→plugin-feishu→gateway**（service binding 目标先存在）——`pnpm deploy:all` 已编排 + 内置 secrets 检查。另有 Pages `watt-dashboard`。
- watt-gateway 双 URL：
  - `https://watt-gateway.shuaiqijianhao.workers.dev` — 本机验证首选；本机直连偶发超时，验证命令带 `https_proxy=http://127.0.0.1:7890`，Node 脚本另加 `NODE_USE_ENV_PROXY=1`（toolchain-pitfalls §28）。
  - `https://watt.pdjjq.org` — CF 边缘正常，本机 ISP DNS 污染持续；`.env` 的 `WATT_BASE_URL` 指向它，本机验证脚本勿直接复用。
- secrets（R33 重排）：
  - gateway：`WATT_JWT_PRIVATE_JWK` + `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` + **`WATT_SECRET_ENCRYPTION_KEY`（R33，SecretStore 专用）**。**FEISHU_* 已移出 gateway**。
  - plugin worker（watt-plugin-feishu）：`FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_VERIFICATION_TOKEN` / `WATT_PLUGIN_TOKEN` / `WATT_BASE_URL`。**未配 FEISHU_ENCRYPT_KEY**（`.env` 该值位是注释即空——明文+token 校验模式，pitfalls §59）。
  - put 后 ~15s 传播窗口。
- **运维事实（R33 实测）**：admin token TTL **1h**；`--rotate` 轮换会**连坐 pluginToken**（同一信任根签发——轮换后只需单跑 `watt plugin register channel-feishu` 重签 + 重 put plugin secret，**勿重跑完整 setup feishu**——其③步 def Write 会冲掉部署侧 toolScopes/grants，pitfalls §63）；`sign-admin-token.mjs` 需 `WATT_JWKS_BASE_URL`（jwksBase 已参数化）；**default model provider = kv-relay**（secretRef `LLM_RELAY_KEY` 存 SecretStore KV，回退链线上实证）。
- **运维事实（R34 线上配置修复，零代码改动）**：
  - test/echo 树 `get-uuid` 已换 **`https://httpbingo.org/uuid`**（httpbin.org 不稳，R33 遗留收口）；test/watt 与 finance/e2e4 仍是 postman-echo 不动。
  - 线上 lurker/scribe def 现为 `toolScopes:["test"]` + grants 含 `tool://test`/`tool://test/*`（read,invoke）——**与代码字面（lurker.ts/setup.ts 默认值）不同步**，重跑 setup feishu/e2e-3 会整体冲掉（pitfalls §63）。
  - 两条策略已入库：`lurker-tool-test-root`（agent:lurker/scribe → tool://test）+ `lurker-tool-test-sub`（→ tool://test/*），均 read,invoke allow（两关授权修复，pitfalls §62）。
  - pluginToken 已于 R34 随 admin token `--rotate` 轮换重签并重 put 到 watt-plugin-feishu；**入站 webhook 的新 pluginToken 尚未经真人群消息验证**（R34 遗留，本轮注入走 admin Publish 旁路）。
- **`pnpm deploy:all` 内置五库 migrations**：`d1 migrations apply {watt-policies,watt-events,watt-context,watt-providers,watt-audit} --remote`（幂等）。
- Queue `watt-events` consumer 已绑；DLQ `watt-events-dlq` 已建。
- `scripts/smoke.ts` 内置 5 次重试（toolchain-pitfalls §9）。

## 云资源（已真实创建，`pnpm provision` 幂等可重跑）

| 类型 | 资源 |
|---|---|
| D1 ×5 | `watt-policies`（0001~0002） / `watt-providers`（0001~0004） / `watt-audit`（0001） / `watt-events`（0001~0002） / `watt-context`（0001） |
| KV ×2 | `watt-authz-cache`（判定缓存，未用） / `watt-tenants`（device grant + toolbridge 租户树配置 + **SecretStore `secret:` 前缀，R33**） |
| R2 ×2 | `watt-context-objects` / `watt-artifacts` |
| Queue ×2 | `watt-events`（producer+consumer） / `watt-events-dlq` |
| Vectorize ×1 | `watt-context-index`（1024 维，bge-m3，cosine） |
| Workers AI | AI 绑定（bge-m3 embedding） |
| DO ×5 | `EVENT_ROUTER` / `CONTEXT_REGISTRY` / `AGENT_INSTANCE` / `AGENT_CORRELATION` / `SCHEDULER_HUB` |
| Workflows ×1 | `watt-task`（binding WATT_TASK，class WattTaskWorkflow） |
| Worker Loader | `LOADER`（worker_loaders binding；线上 open beta，DJJ 账户已开通实证） |
| Worker ×3 | `watt-gateway` / `watt-toolbridge` / **`watt-plugin-feishu`（R33，custom domain `watt-feishu.pdjjq.org`）** |
| Analytics Engine | `AE_METRICS`（watt_metrics dataset；本地 no-op 见 pitfalls） |
| Pages ×1 | `watt-dashboard`（https://watt-dashboard-4tn.pages.dev） |

命名/多库/维度决策见 [../memory/decisions/resource-naming-and-provision.md](../memory/decisions/resource-naming-and-provision.md)。

## 本机工具链（已实测，全绿）

| 工具 | 版本/状态 |
|---|---|
| node | v26.4.0 |
| pnpm | 11.9.0 |
| wrangler | 4.107.0（devDependency 锁定，对齐 vitest-pool-workers 0.18 捆绑版本） |
| gh | 已登录账户 `Disdjj`，scopes 含 `repo`（可 clone/push 私有 tool-bridge） |

## 凭据状态（`.env`，已 gitignore；不记录任何秘密值）

- **Cloudflare**：`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` 均存在且 token 有效（Account-scoped，账户 DJJ）。
  - ⚠️ 验证只用 `wrangler whoami`；`/user/tokens/verify` 对 Account API Token 必然误报，勿作判据。
- **模型**：双路径已实测通——① 中转直连 `https://llm.fantacy.live`（Anthropic Messages 格式）；② AI Gateway custom provider（`glm-5.2` / `minimax-m3`）。**当前线上 default provider = kv-relay（secretRef LLM_RELAY_KEY 存 SecretStore KV）**。易错点见 [../reference/external-facts.md](../reference/external-facts.md)。@llm 真实测试每轮每 tag 一次（LOOP 纪律 3）。
- **飞书**：**主路径 = webhook plugin**（[../memory/decisions/feishu-plugin-webhook.md](../memory/decisions/feishu-plugin-webhook.md)；WS `channel connect` 降 dev-only 备用）；入站/出站均已真实采证；`E2E_FEISHU_TEST_CHAT_ID` 已在 `.env`；`FEISHU_ENCRYPT_KEY` **实为空**（值位是注释）。飞书后台需保持"事件发送至开发者服务器"=`https://watt-feishu.pdjjq.org/webhook/event`。
- **空缺项**：`E2E_FEISHU_ADMIN_OPEN_ID` / `E2E_FEISHU_EMPLOYEE_OPEN_ID`（入站身份未映射 → user:anonymous 属 §6.3 正确语义，不阻塞）；`E2E_WEBHOOK_SINK_URL`（可选）；飞书 app「接收群聊中所有消息」权限（缺则 lurker 群上下文只累积 @ 消息）。

## 外部仓库可达性（已用 gh 核实）

- `TokenRollAI/tool-bridge`：私有，可访问，默认分支 `main`；Watt 分支 `feat/watt-builtin-and-tool-semantics`（56ab13b）已 push 未合。
- `TokenRollAI/HTBP`：公开。
- Flue = `withastro/flue`（公开）；`TokenRollAI/flue` **不存在**（[../memory/decisions/flue-attribution.md](../memory/decisions/flue-attribution.md)）。
