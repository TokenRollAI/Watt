# 当前项目状态快照

> 本文档随轮次更新。最后更新：2026-07-03（Round 21，Phase 5 三项 DoD 全勾）。

## 阶段

- 规格真源：`Docs/{Vision,Architecture,Proto,Plugin,Reference}.md` + `DOD.md`（验收）+ `LOOP.md`（执行契约）。
- Phase 0~4 已关门（Round 3/7/10/13/18）；**Phase 5（Task + Scheduler）三项 DoD 全勾**（Round 19/20/21，证据 `PROGRESS.md`）——项 1 单测面（core+gateway）、项 2 集成链（Workflows introspect + HITL 闭环 + cron）、项 3 线上全链（task run→waiting_human→signal→done / cancel；cron publish+script 三留痕，LOADER 真 isolate）。
- **下一目标：Round 22 Phase 5 关门**——4 维质量关口 workflow + 逐条对抗核查 + Docs 漂移回查（doc-gap #11 的 Proto §3.4 回写候选）+ PROGRESS 入账。
- Phase 5 遗留 backlog：模板依赖的 agent def 需种子化（冒烟发现 echo def 未注册会卡 running）、script 能力表扩容（当前仅 watt.publish）。实现声明簇见 doc-gaps **#29**；两条决策见 [../memory/decisions/task-workflow-instance-id.md](../memory/decisions/task-workflow-instance-id.md) 与 [../memory/decisions/scheduler-script-runner.md](../memory/decisions/scheduler-script-runner.md)。
- Phase 4 遗留：13 条 MINOR backlog（ModelProvider resolveDefault 死代码未接 harness、output ≤1MiB 未实施、lastActiveAt 语义漂移、toolbridge 公网可达+固定转发凭据、vendored 未合并分支锚点等）不阻塞；Round 18 有 6 个 finding 因中转 502 未复核（按 MINOR 保守处理，碰到相关文件顺手核）；Phase 4 实现声明簇见 doc-gaps **#28**。
- Phase 3 遗留：14 条 MINOR backlog 不阻塞；实现声明簇见 doc-gaps #26/#27。Phase 2 遗留：17 条 MINOR backlog；实现声明簇见 doc-gaps #25。
- Phase 路线：0 骨架/部署管道 → 1 Auth+Event 信封 → 2 Event Gateway → 3 Context Layer → 4 Tool+Agent Runtime → 5 Task+Scheduler → 6 飞书+Observability+Management → 7 六条 E2E 验收（详见 [../overview/project-overview.md](../overview/project-overview.md)）。
- 上游 tool-bridge：分支 `feat/watt-builtin-and-tool-semantics`（56ab13b，已 push 未开 PR/未合 main）——ToolSpec effect/scope/confirm 语义字段 + builtin 节点类型。Watt 侧以 vendored 方式消费（见下）。

## 源码现状（Round 21 后，测试共 896 个：shared 6 + core 396 + cli 107 + gateway 387+1skip（@llm 门控）；core 覆盖率 100%，门禁挂 verify）

- `packages/shared` — `WattError`（规范 7 码，裸 body 契约见 [../memory/decisions/bare-watterror-body.md](../memory/decisions/bare-watterror-body.md)）。
- `packages/core`（@watt/core，平台核心纯逻辑，零 Cloudflare 依赖）：
  - `src/authz/` — `authorize()` §6.4c 四步判定 + subject 匹配 + 工具动作映射。
  - `src/event/` — Event 信封（128KB 上限、DedupeStore、normalizeEvent occurredAt 保留语义、eventInputSchema）。
  - `src/auth/` — `jwt.ts`（jose Ed25519）+ `device-flow.ts`（RFC 8628）。
  - `src/eventbus/` — 订阅匹配/instanceKey/inbound/outbound/hmac 纯逻辑（详见 Round 8 记录与 doc-gap #23）。
  - `src/context/` — Context Layer 纯逻辑（types/resolve/ttl/verbs/help，实现声明 doc-gaps #26）。
  - `src/agent/`（Round 14/17 新增，Agent 纯逻辑）— `types.ts`（AgentDefinition/SpawnRequest/ExpectSpec/AgentResult/AgentFailed zod）、`correlation.ts`（correlationId 字符集 `[A-Za-z0-9_-]`≤80 + CorrelationTable 状态机）、`routing.ts`（**§3.4 六条规则**纯判定：定向回送/派生回送/超时代发/终止即失败/等待方消失丢弃/去重）、`expect-schema.ts`（JSON Schema 五关键字子集校验器 type/properties/required/items/enum，schema 重试 maxAttempts=3 → invalid_output）、`model-provider.ts`（ModelProvider 纯逻辑）。Spawn 幂等键复用 eventbus resolveInstanceKey。
  - `src/tools/` — `types.ts`（toolMountSchema §5.2：mcp/http/builtin + virtualize 四项）。
  - `src/task/`（Round 19 新增，Task+Scheduler 纯逻辑）— `types.ts`（TaskInfo 7 态/TaskDetail/SignalRequest/SchedulerCronJob）、`signal.ts`（waiting 外→conflict）、`event-names.ts`（Workflows 事件名净化：禁 '.'、≤100，超长→invalid_argument）、`cron.ts`（**五段分钟级子集手写解析**——agents/schedule 无纯函数导出，见 toolchain-pitfalls §43）、`checkpoint.ts`（consumer type guard）。
- `packages/toolbridge`（Round 16 新增）— **vendored** 上游 `TokenRollAI/tool-bridge` worker 源码 **@56ab13b**（上游运行时依赖含整套 dashboard UI，纯代理不需要；vendor src/worker + 一处 ASSETS patch 有标注 + **patch 守卫脚本**；升级流程见该包 README.md）。部署为独立 Worker `watt-toolbridge`。
- `packages/gateway`（Hono Worker，入口 export fetch/queue + 四个 DO 类）：
  - `src/authz/` `src/event/` `src/context/` `src/http/{auth,errors,oauth,routes,context-routes,inbound}` — Phase 1~3 面（详见 doc-gaps #25/#26/#27 与 PROGRESS Round 5~13）。
  - `src/agent/`（Round 17/18 新增，Agent Runtime）— `agent-instance.ts`（**AgentInstance = Agents SDK Agent 类**，DO；harness 由 model 声明推导）、`harness/`（echo + llm；**llm 模型调用经 Vercel AI SDK ai@6 + @ai-sdk/anthropic@3，版本锁 agents peer**，见 [../memory/decisions/model-call-sdk.md](../memory/decisions/model-call-sdk.md)；模型调用 AbortSignal.timeout(60s)）、`agent-correlation.ts`（**AgentCorrelation DO：直投 waiter（绕开 routeResult 去重自吞）+ 三态 settle**；超时 alarm 扫描代发）、`agent-registry.ts`（providers 库 0002；declarative subscriptions→EventRouter 规则 1 联动）、`agent-runtime.ts`（Spawn instanceKey 幂等→idFromName / Send+expect→correlation register / Terminate cascade + 清 waiter 侧 correlation / ListInstances tree；terminated 行 7 天 sweep）、`model-provider.ts`（0003，set-default）。
  - `src/tools/tool-registry.ts` — ToolRegistry（watt-providers 库 0001）。
  - `src/task/`（Round 20 新增，Task/M7）— `watt-task-workflow.ts`（**WattTaskWorkflow = Workflows WorkflowEntrypoint**，按 definition 分派 **DEPLOYED_TEMPLATES 两模板**：deep-research 真实 spawn fan-in N=2 / auto-delivery-lite confirm-release checkpoint；**taskId 即 instanceId 免映射**；checkpoint waitForEvent 超时 human 10min/agent 5min；副作用全包 step.do 保重放决定论）、`task-store.ts`（TaskStore 挂 watt-events 0002）、`task-manager.ts`（**七动词**：Write/List/Get/Update/Cancel/Signal/ListDefinitions）、`task-events.ts`（task.checkpoint Publish）。**HITL 闭环**：consumer 真实 TaskSignaler + Check(task://,'signal')；agent-deliverer task waiter 经 sendEvent(agent-result-<cid>) 回送。
  - `src/scheduler/`（Round 21 新增，Scheduler/M6）— `scheduler-hub.ts`（**SchedulerHub = Agents SDK Agent DO** + this.schedule，CronJob 存内嵌 SQLite；六动词+Trigger，disabled 仍可手动补跑）、`actions.ts`（**三 action：publish/agent/script，双留痕 cron.fired→cron.completed**）、`script-runner.ts`（**ScriptRunner 可注入抽象**：生产 LoaderScriptRunner LOADER 真 isolate / 测试 fake 同一 Check 路径；watt binding 经 RPC 参数注入，见 [../memory/decisions/scheduler-script-runner.md](../memory/decisions/scheduler-script-runner.md)）、`scheduler-manager.ts`。**/htbp/platform/scheduler 路由上线后 501 占位清零（SPEC_TREE_PREFIXES 已空）**。
  - `src/http/tools-proxy.ts` — /htbp/tools 代理：认证→`tool://<path>` **Check PEP**→service binding TOOLBRIDGE 转发→上游 `{error:{}}` 转裸 WattError→List/~help 逐 path Check('read') 裁剪；**call 信封归一化**（http 拆信封发裸参数 / mcp·builtin 透传）；**syncTenantTree 树 hash 变更才写 KV**（KV 1 写/秒节流）。
  - `src/event/agent-deliverer.ts`（Round 17/18）— consumer agent sink 真实投递；agent.result/failed 走 core routeAgentEvent；routeResult 三态 peek(delivering)→deliver→confirm，失败 rollback + msg.retry。
  - migrations：`migrations/0001`（watt-policies）、`migrations-events/0001~0002`（watt-events：events/channels + **tasks 表，Round 20**）、`migrations-context/0001`（watt-context）、**`migrations-providers/0001~0003`**（tool_registry / agent_registry / model_providers，watt-providers 库）。
- `packages/cli`（包名 `watt-cli`）— **十三命令族**：`status` / `login` / `whoami` / `policy` / `audit` / `event tail|get|subs` / `channel list|set` / `context ls|cat|put|patch|mount|unmount` / `tool mount|ls|describe|call` / `agent`（六命令）/ `provider`（三命令）/ **`task list|get|run|signal|cancel`（Round 20）** / **`cron list|create|trigger|rm`（Round 21）**。token 顺序 `WATT_TOKEN` env > `~/.watt/credentials.json`（0600）；未认证分层 exit 2/1。

### 关键契约（Round 18 锁定，Round 19~21 增补）

- **HTBP tools call 请求形状**：工具名走 **URL end-path**、body 是 **`{arguments}` 信封**；gateway 代理按 provider 归一化——http 拆信封发裸参数、mcp/builtin 透传（详见 toolchain-pitfalls §38）。
- **correlation settled 三态**：pending → delivering → settled；投递成功才 settle，失败 rollback + retry。
- **模型调用超时 60s**（AbortSignal.timeout）；**TERMINATED_TTL 7d**（terminated 实例行 7 天 sweep）。
- http mount 的 providerConfig 必须是上游 HttpEndpointConfig 形状 `{endpoints:[{name,method,url,...}]}`，单 `{endpoint}` 会 500（Round 16 冒烟实测）。
- Context 响应信封形状真源 = gateway 路由测试，CLI 精确解包禁双形态兜底（doc-gap #27⑥）。
- **taskId 即 Workflows instanceId**（免映射，[../memory/decisions/task-workflow-instance-id.md](../memory/decisions/task-workflow-instance-id.md)）；**checkpoint waitForEvent 超时 human 10min / agent 5min**；Task 状态权威态在 TaskStore 状态表（本地 hibernate 时 instance.status 报 running，toolchain-pitfalls §41）。
- **script 能力面 = watt.publish**，每次过 platform://event manage Check（cron 链段）；watt binding 经 **RPC 参数注入**非 loader env（toolchain-pitfalls §44）。

## 部署现状

- **双 Worker 拓扑**：`watt-toolbridge`（Tool Gateway，无 D1；树配置走共享 KV watt-tenants，由 gateway 代理层写入）+ `watt-gateway`（主 Worker，service binding `TOOLBRIDGE` 指向前者）。**deploy 顺序必须先 toolbridge 后 gateway**（service binding 目标不存在则 gateway deploy 失败）——`pnpm deploy:all` 已编排，且**内置 secrets 检查**。
- watt-gateway 双 URL：
  - `https://watt-gateway.shuaiqijianhao.workers.dev` — 本机验证首选；本机直连偶发超时，验证命令带 `https_proxy=http://127.0.0.1:7890`，Node 脚本另加 `NODE_USE_ENV_PROXY=1`（toolchain-pitfalls §28）。
  - `https://watt.pdjjq.org` — CF 边缘正常，本机 ISP DNS 污染持续；`.env` 的 `WATT_BASE_URL` 指向它，本机验证脚本勿直接复用。
- secrets：`WATT_JWT_PRIVATE_JWK`（轮换用 `scripts/sign-admin-token.mjs --rotate`）+ **`ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`**（Round 17，llm harness 中转直连）。put 后 ~15s 传播窗口。
- **`pnpm deploy:all` 内置四库 migrations**：`d1 migrations apply {watt-policies,watt-events,watt-context,watt-providers} --remote`（幂等）；新库带 migrations 时须同步扩展。
- Queue `watt-events` consumer 已绑；DLQ `watt-events-dlq` 已建（consumer/重放工具留 Phase 6）。
- `scripts/smoke.ts` 内置 5 次重试（边缘传播窗口 + 旧 isolate 首击，toolchain-pitfalls §9）。

## 云资源（已真实创建，`pnpm provision` 幂等可重跑）

| 类型 | 资源 |
|---|---|
| D1 ×5 | `watt-policies`（0001） / `watt-providers`（**0001~0003**：tool/agent/model registry，Round 15/17） / `watt-audit` / `watt-events`（**0001~0002**：events/channels + tasks，Round 20） / `watt-context`（0001） |
| KV ×2 | `watt-authz-cache`（判定缓存，未用） / `watt-tenants`（device grant 存储 + **toolbridge 租户树配置**，provision 回填 toolbridge KV id） |
| R2 ×2 | `watt-context-objects` / `watt-artifacts` |
| Queue ×2 | `watt-events`（producer+consumer） / `watt-events-dlq` |
| Vectorize ×1 | `watt-context-index`（1024 维，bge-m3，cosine；namespace metadata index 已建） |
| Workers AI | AI 绑定（bge-m3 embedding） |
| DO ×5 | `EVENT_ROUTER` / `CONTEXT_REGISTRY` / `AGENT_INSTANCE`（AgentInstance，Round 17） / `AGENT_CORRELATION`（AgentCorrelation，Round 17/18） / **`SCHEDULER_HUB`（SchedulerHub，Round 21，DO migration v4）** |
| Workflows ×1 | **`watt-task`（binding WATT_TASK，class WattTaskWorkflow，Round 20）** |
| Worker Loader | **`LOADER`（worker_loaders binding，Round 21；线上 open beta，DJJ 账户已开通实证）** |
| Worker ×2 | `watt-gateway` / **`watt-toolbridge`（Round 16）** |

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
- **模型**：双路径已实测通——① 中转直连 `https://llm.fantacy.live`（Anthropic Messages 格式；llm harness 已接，Round 17/18 真实模型 DoD 复验通过）；② AI Gateway custom provider（`glm-5.2` / `minimax-m3`）。易错点见 [../reference/external-facts.md](../reference/external-facts.md)。@llm 真实测试每轮每 tag 一次（LOOP 纪律 3）。
- **飞书**：WS 长连接 push 型方案已定（[../memory/decisions/feishu-websocket-channel.md](../memory/decisions/feishu-websocket-channel.md)）；出站发消息已实测；`E2E_FEISHU_TEST_CHAT_ID` 已在 `.env`。
- **空缺项**：`E2E_FEISHU_ADMIN_OPEN_ID` / `E2E_FEISHU_EMPLOYEE_OPEN_ID`（E2E-4 降级为 API 模拟身份，不阻塞）；`E2E_WEBHOOK_SINK_URL`（可选，不阻塞）。

## 外部仓库可达性（已用 gh 核实）

- `TokenRollAI/tool-bridge`：私有，可访问，默认分支 `main`；Watt 分支 `feat/watt-builtin-and-tool-semantics`（56ab13b）已 push 未合。
- `TokenRollAI/HTBP`：公开。
- Flue = `withastro/flue`（公开）；`TokenRollAI/flue` **不存在**（[../memory/decisions/flue-attribution.md](../memory/decisions/flue-attribution.md)）。
