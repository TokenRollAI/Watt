# DOD（Definition of Done）

> 本文是 Watt 实现阶段的**完成标准**：项目分几个 Phase、每个 Phase 在什么条件下算完成、用什么手段验证。它是驱动持续开发 loop 的验收真源——loop 的每一轮都应对照本文判断"当前 Phase 是否闭环、下一步做什么"。
>
> 规格真源：[Docs/Vision.md](Docs/Vision.md)（User Case）、[Docs/Architecture.md](Docs/Architecture.md)（模块）、[Docs/Proto.md](Docs/Proto.md)（接口契约）、[Docs/Plugin.md](Docs/Plugin.md)（插件契约）、[Docs/Reference.md](Docs/Reference.md)（平台事实）。**实现与文档冲突时，以 Docs 为准；发现 Docs 自身错误时，先修 Docs 再写码。**

## 0. 全局完成定义

整个项目 Done = 以下五条同时成立：

1. **六个 User Case 的 E2E 全部通过**（§9 的 E2E-1 ~ E2E-6，跑在真实 Cloudflare + 真实飞书上）；
2. **每个 Phase 的 DoD 清单全部勾选**，且勾选依据是可重跑的命令（测试/脚本），不是人工目测；
3. **`pnpm verify` 一键绿**：typecheck + lint + unit + integration 全过；
4. **从零部署可复现**：新环境按 `.env` + `pnpm deploy:all` 能在 30 分钟内拉起完整平台（附B 引导顺序自动化）；
5. **Watt CLI 覆盖全部管理面**：Architecture M10 命令表中的每条命令可用，且 §9 的六条 E2E 全部以 CLI（`--json`）驱动断言——CLI 既是管理入口也是 DOD 的验证器。

**CLI 增量策略**：`watt` CLI（npm 包 `watt-cli`，Architecture M10）不是独立 Phase，而是**随各 Phase 生长**——每个 Phase 交付其模块对应的子命令，并从 Phase 1 起作为该 Phase 集成验证的默认驱动方式。CLI 是纯 Platform API 客户端：如果某个能力 CLI 做不到而 Dashboard/直接 API 做得到，即视为"存在管理旁路"，违反 M10 的对等原则，算作缺陷。

## 1. 通用验收规则（适用于每个 Phase）

每个 Phase 声明 Done 前，必须满足：

- [ ] **契约一致**：实现的接口签名、错误码、事件 schema 与 Proto.md 对应章节一致；偏离处已回写 Docs 并说明理由。
- [ ] **单元测试**：本 Phase 新增模块的核心逻辑有单测覆盖（判定算法、路由规则、协议编解码这类纯逻辑 **100% 分支覆盖**；I/O 胶水层不强制）；使用 Vitest + `@cloudflare/vitest-pool-workers`（DO/Worker 在真实 workerd 里测）。
- [ ] **集成测试**：本 Phase 的对外行为有至少一条穿透测试（HTTP 进 → 存储/事件出），跑在 `wrangler dev` 或 vitest-pool-workers 环境。
- [ ] **可部署**：`wrangler deploy`（或 `pnpm deploy:all`）成功，部署后冒烟脚本（`scripts/smoke.ts`）通过。
- [ ] **回归不破坏**：此前所有 Phase 的测试仍然全绿。

## 2. Phase 0 — 工程骨架与部署管道

**目标**：拿到一个"能部署、能测试、能回滚"的空平台。

**范围**：monorepo（pnpm workspaces）；`watt-gateway` Worker 骨架（health 路由；`POST /channels/<id>/inbound` 通用入站占位——飞书已决定走 WebSocket push 型，webhook 入口仅为通用 ChannelAdapter 保留）；wrangler.jsonc（DO/D1/KV/R2/Queues 绑定占位）；Vitest 配置；`pnpm verify` / `pnpm deploy:all` / `scripts/smoke.ts`；`.dev.vars` 从 `.env` 生成；**CLI 骨架**（`packages/cli`：命令框架、`--json` 全局开关、`WATT_BASE_URL`/`WATT_TOKEN` 读取、`watt status` 打 healthz）。

**DoD**：
- [x] `pnpm verify` 本地绿（哪怕只有 1 个占位测试）。（2026-07-02 Round 1：typecheck+lint+test 全绿，19 tests passed，证据见 PROGRESS.md）
- [x] `pnpm deploy:all` 部署到 `CLOUDFLARE_ACCOUNT_ID` 指定账户成功。（2026-07-02 Round 2：exit 0，10 个绑定挂载，workers.dev + custom domain watt.pdjjq.org 双 URL）
- [x] `curl ${WATT_BASE_URL}/healthz` 返回 200 + 版本号。（2026-07-02 Round 2：`{"ok":true,"version":"0.1.0","service":"watt-gateway"}`；注：watt.pdjjq.org 在 CF 边缘 200（DoH 验证），本机 ISP DNS 污染需 DoH/代理，workers.dev URL 直连可用）
- [x] `watt status` 对部署环境返回健康摘要（`--json` 可解析）。（2026-07-02 Round 2：exit 0，`--json` 输出 JSON.parse 通过）
- [x] 附B 清单中的资源（D1/KV/R2/Queues）已由脚本创建并绑定（`wrangler d1 list` 等可见）。（2026-07-02 Round 2：`pnpm provision` 幂等脚本创建 D1×4/KV×2/R2×2/Queue×1/Vectorize×1，各 list 命令均可见，绑定回填 wrangler.jsonc）

## 3. Phase 1 — Auth 内核 + Event 信封（横切地基）

**目标**：Proto §0/§1/§6 落地——一切后续模块都依赖 CallContext 与 Check。

**范围**：Event 信封类型 + 尺寸/去重规则（§1）；JWT 签发/验签（Agent/user/plugin token，§6.4/§6.5）；`Authorizer.Check/CheckBatch`（含 chain 衰减、cron 段、§6.4c 四步算法）；`PolicyStore`（D1）+ KV 判定缓存；种子 Policy 引导（§6.5c）；`IdentityMapper`（含 `ResolvePrincipal`）；WattError↔HTTP 映射中间件；**CLI**：`watt login`（device flow）/ `watt whoami` / `watt policy list|add|rm` / `watt audit list`（audit 的数据面 Phase 6 才完整，此处先通接口）。

**DoD**：
- [x] 判定算法单测覆盖：principal 允许/拒绝、role 匹配、agent 定义上限、链衰减（含 `cron:<jobId>` 段、job 禁用→deny）、user token 无 agent 段路径、deny 优先——**每条 §6.4c 规则至少一个正/反用例**。（2026-07-02 Round 4：@watt/core 49 个 authz 测试，100% 分支覆盖门禁入 verify，红→绿过程留痕 PROGRESS）
- [x] Event 信封单测：>128 KB 拒收、dedupeKey 幂等、`Omit` 字段由平台补齐。（2026-07-02 Round 4：16 个 event 测试含 128KB 边界、时间窗、不覆写已有 principal）
- [x] 集成：种子引导后，`watt login` 完成设备授权 → `watt whoami` 显示 `WATT_ADMIN_PRINCIPAL` + role:admin → `watt policy list` 返回种子 Policy；无 token 调用返回 401。（2026-07-02 Round 6：真实部署环境主 assistant 独立复跑全链——login 轮询→admin approve(user code TZR9KPQD)→credentials 0600→whoami `user:djj`+`admin`→policy list 见 `seed-admin-allow-all`→无 token 401 裸 WattError；证据 PROGRESS Round 6）

**Phase 1 已知跳过清单**（有意延后，非缺陷）：① KV 判定缓存（代码注释已声明，量级需要时再开）；② agent token 数据面（§6.4c 步骤 2/3 的 agentDefs/instances 真实取数）留 Phase 4/5；③ `/htbp/*` 节点的 `~help`/`~skill` 与根渐进发现（§11.3a）统一延后——platform 子树最小 ~help 随 Phase 3 Help DSL parser 落地，通用 ~help 生成归上游 tool-bridge（Phase 4，LOOP §2.1 上游通道）；④ Page<T> 的 cursor 分页（§0.2 可选字段，List 返回 `{items}` 省略之）。

## 4. Phase 2 — Event Gateway（M1）

**目标**：事件进得来、路由得出去、留得下痕。

**范围**：Ingress Worker（`/channels/<id>/inbound` 分发、直接 API Publish）；`EventBus`（Queues + Router DO：订阅表、session 粘性、三类订阅建立规则）；`EventStore`（D1）；`ChannelRegistry`；内置 webhook ChannelAdapter（验签透传 `bodyRaw`）；§1.1 human-in-the-loop 内置路由（task.checkpoint→出站卡片、im.action→Signal 的桩，Task 侧 Phase 5 接上）；**CLI**：`watt event tail|get|subs` / `watt channel list|set`。

**DoD**：
- [x] 单测：订阅匹配（type 通配/AND 语义/session）、instanceBy 三态路由、Verify 失败拒收、出站鉴权点（`event://` write）。（2026-07-02 Round 8：core 新增 45 测试，`pnpm verify` 226 tests 全绿，覆盖率 100% 保持）
- [x] 集成：POST 一个 webhook → `watt event tail` 可见规约后的 Event → 订阅的 sink 收到投递；同 dedupeKey 重发 → 返回原 eventId 且只投递一次。（2026-07-02 Round 9：`packages/gateway/test/integration-event-flow.test.ts` 全链 4 tests 绿；`pnpm verify` 314 tests）
- [x] 部署后冒烟：真实 URL 上完成上述闭环。（2026-07-02 Round 9：workers.dev 上 channel set → 签名 inbound 200 / 错签名 403 → event tail/get 可见 → webhook.site sink 收到投递 → 同 delivery-id 重发返回原 eventId 且 sink 计数仍为 1）

## 5. Phase 3 — Context Layer（M3）

**目标**：四动词统一读写面 + namespace 挂载。

**范围**：`ContextRegistry`（DO：挂载表、TTL 回收、Resolve）；内置 Provider：object（R2）、structured（D1）、vector（Vectorize + Workers AI embeddings，声明 Search）；HTBP Context 子树（`/htbp/context/<ns>/~help` + 四动词调用）；权限拦截（`context://` read/write）；**CLI**：`watt context ls|cat|put|patch|mount|unmount`。

**DoD**：
- [ ] 单测：四动词语义（Write 幂等 upsert、Update not_found、ifVersion conflict）、TTL 到期回收、URI Resolve。
- [ ] 集成：`watt context mount` 挂 object namespace → 经 CLI 走完 put→ls→cat→patch 全循环（等价 HTBP 四动词）；挂 vector namespace → put 后 Search 能召回。
- [ ] `~help` 输出经 HTBP Help DSL 语法检查（一个最小 parser 断言 cmd 行完整）。

## 6. Phase 4 — Tool Layer + Agent Runtime（M4 + M2）

**目标**：Agent 能被派生、能调工具、能回传结构化结果——平台开始"活"。

**范围**：Tool Gateway（**基于 tool-bridge 集成**——该仓库是用户的私有项目、仍在建设中，缺能力直接改上游（流程见 LOOP.md §2.1），不做平行实现：`/htbp/tools/*` 树、mcp/http/builtin 三种 ToolProvider、调用点 Check、凭证注入）；`ToolRegistry`；`AgentRegistry` + `AgentRuntime`（Spawn/Send/Status/Terminate/ListInstances，DO Light Runtime）；完成协议 §3.4（correlationId 全生命周期、六条路由规则、ExpectSpec.schema 校验重试）；内置 echo/LLM harness（Agents SDK，接 `ANTHROPIC_API_KEY`）；Model Provider 最小版（`ModelProviderRegistry` + 直连路由）；**CLI**：`watt tool ls|describe|call|mount` / `watt agent list|get|spawn|send|terminate|tree` / `watt provider list|add|set-default`。

**DoD**：
- [ ] 单测：§3.4 六条规则逐条（定向回送、派生回送、超时代发、终止失败、等待方消失丢弃、去重）；schema 校验失败→重试→invalid_output；correlationId 字符集校验；Spawn 幂等键。
- [ ] 集成：`watt tool mount` 注册一个 http ToolProvider → `watt tool call` 成功；无权限 principal 的 token 下 `watt tool call` → 403 且 `watt tool ls` 不可见（Case 4 的机制预演）。
- [ ] 集成：`watt agent spawn` 一个 LLM Agent（真实模型）→ `watt agent send --expect-schema` → 收到 schema 合法的 agent.result → `watt agent tree` 显示派生关系。**这是第一个消耗真实 token 的测试，单独 tag `@llm`，可跳过。**

## 7. Phase 5 — Task + Scheduler（M7 + M6）

**目标**：长任务与定时任务闭环，human-in-the-loop 全链路打通。

**范围**：`TaskManager`（Workflows 适配：事件名净化、result/failed 归并、waitForEvent 超时处理）；`deep-research` 与 `auto-delivery-lite` 两个部署模板；`Scheduler`（DO + `this.schedule`，publish/agent/script 三种 action，script 的 isolate 执行 + grants 注入）；§1.1 闭环接通（checkpoint→卡片→action→Signal→恢复）；**CLI**：`watt task list|get|run|signal|cancel` / `watt cron list|create|trigger|rm`。

**DoD**：
- [ ] 单测：Signal 状态机（waiting 外 Signal→conflict）、事件名净化规则、cron 表达式解析、script grants 注入面（未声明的绑定不存在）。
- [ ] 集成：`watt task run deep-research` → 进入 waiting_human → `watt task signal`（CLI 就是人类确认的命令行路径）→ 恢复执行 → done；`watt task cancel` 后子实例收到 terminated。
- [ ] 集成：`watt cron create --action script`（查询一个桩指标 → Publish 出站事件）→ `watt cron trigger` 立即执行 → `watt event tail` 见 cron.fired + cron.completed。

## 8. Phase 6 — 飞书 Channel + Observability + Management（M1-feishu + M9 + M10）

**目标**：真实 IM 进出 + 可观测 + 对话式管理。

**范围**：飞书 ChannelAdapter（**WebSocket 长连接 push 型**，2026-07-02 决定，不走 webhook：Adapter 用 `@larksuiteoapi/node-sdk` 的 WSClient 自持连接，收事件后自行规约——填 session/channelUser/dedupeKey——并以 plugin token 调 `EventBus.Publish`；capabilities 声明 `push`，Verify/Decode 豁免（Proto §2.1 接入模式）。**宿主注意**：Workers 无法跑 Node WSClient，连接进程落在 Container（Heavy Runtime）或开发期由 CLI 承载——`watt channel connect feishu-main` 在本地起长连接把事件转发进平台，这正是"通过 CLI 创造请求"的实现路径）；Encode/Send 出站含 actions 卡片（走飞书 REST API，出站已实测通）；`IdentityMapper` 飞书映射（open_id→principal+roles）；`Metrics.Query` + `AuditLog`（Analytics Engine + D1，cf-aig-metadata 按 Agent 维度）；`manage/platform` 与 `manage/cron` Agent；Dashboard 最小版（只读视图 + Provider/Cron 写操作，Pages）；**CLI**：`watt channel connect|list|set` / `watt metrics query` / `watt status`（接真实指标）/ `watt audit list`（接真实数据面）/ `watt plugin register|list|health`。

**DoD**：
- [ ] 单测：飞书事件规约全字段义务（push 型下规约逻辑在 Adapter 内，义务同 Decode）、卡片 Encode（actions→signal 载荷）、身份映射缺省 anonymous、WS 断线重连/事件去重（dedupeKey=event_id）。
- [ ] 集成（真实飞书，tag `@feishu`）：`watt channel connect feishu-main` 建立长连接 → 测试群发消息 → 平台收到 im.message 且 principal 正确；平台出站 → 群里可见。
- [ ] `watt metrics query --metric tokens --range 7d` 返回 Phase 4 以来真实的用量数据；`watt status` 汇总实例数/Task 数/今日 token。
- [ ] 对 manage/cron 说"每天 9 点发 token 日报到测试群" → `watt cron list` 可见被正确创建的 CronJob（Case 6 的对话路径）。
- [ ] **CLI 完备性核对**：Architecture M10 命令表的每条命令已实现且 `--json` 输出可解析；抽查三条命令与 Dashboard 同操作的 AuditLog 主体/结果一致（三入口对等的证据）。

## 9. Phase 7 — E2E 验收（最终 DoD）

六条 E2E 跑在**真实部署 + 真实飞书 + 真实模型**上，脚本化（`pnpm e2e`），每条对应一个 User Case。允许 LLM 输出的不确定性——断言的是**协议事实**（事件序列、状态迁移、权限判定、数据落点），不是文本内容。**E2E 脚本以 Watt CLI（`--json`）为默认驱动器**：注入用 `watt`（如 `watt task run`、`watt cron trigger`）、断言用 `watt`（如 `watt event tail --json`、`watt audit list --json`、`watt context cat --json`）——只有 CLI 覆盖不到的动作（真实飞书用户发消息/点按钮）走飞书 API 模拟或人工步骤。

| # | 场景（对应 Vision §3） | 通过判据（全部满足） |
|---|---|---|
| E2E-1 | 自动交付 lite：webhook 反馈 → Triage Agent 查重、登记 bug、（桩）定位 → 通知 Coding Agent（桩容器）→ result 接力 → checkpoint 等人确认 → 飞书卡片点击批准 → 状态置 fixed → 飞书汇报 | ① feedback/bugs 出现新条目且 status 走完 open→fixed；② 接力链上每跳有 agent.result 留痕；③ checkpoint 卡片真实出现在测试群、点击后 Task 恢复；④ 全链路 AuditLog 可回放 |
| E2E-2 | Deep research：测试群提问 → Master 出方案卡片 → 确认 → Spawn 3 个 subagent（websearch 工具）→ fan-in → 群里收到汇总 | ① Task 经历 waiting_human→running→done；② ListInstances(tree) 显示 3 个子实例且结束后回收；③ 3 个 agent.result 均通过 schema 校验；④ 汇总消息送达测试群 |
| E2E-3 | 群聊记录：机器人在群内静默 5 条消息 → 全部入临时 namespace → @机器人提问 → 基于 context 回答 | ① 静默期间零出站消息；② 临时 namespace 有 ≥5 条目且 TTL 生效（过期后 List 为空）；③ @后 30s 内收到回答；④ session 粘性：全程同一 instanceId |
| E2E-4 | 权限控制：admin 与 employee 先后问财务 Agent（挂一个桩财务工具）。**降级说明（2026-07-02）**：真实飞书双账号对照暂缓——先以 API 模拟两个身份（构造带不同 channelUser 的入站事件，IdentityMapper 映射到 admin/anonymous），协议层判定全量验证；真实双账号回归留待机器人可入群后补 | ① admin 身份请求 → 工具被调用、正常回答；② employee/anonymous 身份请求 → Authorizer deny、工具零调用、收到礼貌拒绝；③ 两条 AuditLog 的 decision 分别为 allow/deny 且 chain 完整 |
| E2E-5 | Provider 管理：admin 经 Dashboard/API 查 7 天指标 → Write 新模型渠道 → Update 默认指向 → 下一次 Agent 调用走新渠道 | ① Metrics.Query 返回非空的 tokens/cost 序列；② 新渠道 Write 后 List 可见；③ Update{default:true} 后旧默认自动翻转；④ 随后的 LLM 调用在新渠道留下用量记录 |
| E2E-6 | 定时任务：对 manage/cron 发布"每日 token 用量 → webhook → 飞书群"→ Trigger 补跑验证 | ① CronJob 落库且 action=script、脚本在 context://automations 可读；② Trigger 后测试群收到含真实数字的日报；③ cron.fired/cron.completed 成对留痕；④ 脚本越权调用（未声明的接口）被 deny |

**E2E 通过 = 项目 Done。** 之后进入维护态：新能力（如 §8.1 动态编排）走同样的 Phase→DoD→E2E 流程增量推进。

**已知外部前置（2026-07-02 状态，全部实测）**：
- **Cloudflare 凭据验证判据**：`CLOUDFLARE_API_TOKEN` 是 Account-scoped token，验证一律用 `wrangler whoami`（或 `GET /accounts`）；**勿用 `/user/tokens/verify`**——该端点是 user-scoped，对 Account API Token 必然误报 `Invalid API Token`，不能作为凭据失效的判据。
- **模型渠道 ✅**：两条路径均已验证——a) 中转直连 `https://llm.fantacy.live`（Anthropic Messages 格式）；b) **AI Gateway custom provider**：`https://gateway.ai.cloudflare.com/v1/<ACCOUNT_ID>/watt-gateway/custom-tipsy/messages`，`glm-5.2` 与 `minimax-m3` 都通。三个易错点：模型 ID 必须小写；custom provider 调用要加 `custom-` 前缀；该 provider 的 base_url 已含 `/v1`，路径写 `/messages`（写 `/v1/messages` 会 404）。请求头需 `cf-aig-authorization`（gateway 开了 authentication）+ `x-api-key`。M8 规范路径直接用 gateway，Case 5 的 analytics/缓存指标有原生数据源。
- **飞书 ✅（WebSocket 方案）**：接入方式定为**长连接 push 型**（飞书后台订阅方式选"使用长连接接收事件"，无需 inbound URL）。凭据、机器人激活、测试群（"Tipsy Agent Infra"，chat_id 已入 `.env`）、出站发消息全部实测通过（message_id: `om_x100b6b5c9a5f80acb04e3815478c406`）。实现注意：WSClient 是 Node SDK，不能跑在 Workers isolate——连接进程放 Container，开发期用 `watt channel connect` 在本地承载。webhook 型保留为备用（用户后续可能配置回调 URL）。
- **E2E-4 双账号对照**：仍按前述决定降级为 API 模拟身份，真实双账号后补。

## 10. Loop 运行约定（给持续开发 Agent 的执行契约）

驱动 loop 的 prompt 应遵循：

1. **每轮开场**：读本文 + `PROGRESS.md`（loop 自维护的进度账本：当前 Phase、已勾选项、上轮遗留），确定本轮唯一目标（一个未勾选的 DoD 项）。
2. **实现顺序**：写测试 → 实现 → `pnpm verify` → 勾选 DoD 项并更新 PROGRESS.md。禁止跳过测试直接勾选。
3. **验证凭据**：一切外部验证用 `.env` 中的凭据；`@llm`/`@feishu` tag 的测试消耗真实资源，每轮最多跑一次。
4. **CLI 同步生长**：实现或修改某模块接口时，同轮交付/更新对应的 `watt` 子命令（M10 命令表为清单）；集成验证优先用 CLI 驱动——CLI 跑不通即视为该能力未完成。
5. **卡住即上报**：同一 DoD 项连续 3 轮未闭环，停止重试，在 PROGRESS.md 记录 blocker 并请求人工介入。
6. **Docs 是宪法**：偏离 Proto 的实现必须先改 Docs（并说明理由）再改代码；每完成一个 Phase，回查 Docs 与实现的漂移。
7. **Phase 关门**：宣布 Phase 完成前，重跑该 Phase 全部 DoD 命令 + 全量回归，输出勾选证据（命令 + 结果摘要）到 PROGRESS.md。
