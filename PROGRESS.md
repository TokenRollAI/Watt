# PROGRESS（loop 自维护进度账本）

> 真源：[DOD.md](DOD.md)（验收标准）、[LOOP.md](LOOP.md)（执行契约）。本文记录当前 Phase、已勾选项、每轮证据与遗留。

## 当前状态

- **当前 Phase**：**Phase 5（Task + Scheduler）已关门**（Round 22：2 BLOCKER + 6 MAJOR 全修 + 线上复验）
- **已勾选**：Phase 0/1/2/3/4/5 全部（关门证据 Round 3/7/10/13/18/22）
- **Blocker**：无（注意：watt.pdjjq.org 本机 ISP DNS 污染持续存在；Round 10 起本机直连 workers.dev 也偶发超时,需走本机代理 `https_proxy=http://127.0.0.1:7890`——CF 边缘本身正常）
- **下一目标**：Phase 6 R24（飞书 ChannelAdapter：core 规约纯逻辑 + IdentityMapper 映射表 + 出站接线 + `watt channel connect`）

## 上游改动记录（tool-bridge 等）

- 2026-07-03（Round 15）`TokenRollAI/tool-bridge` 分支 `feat/watt-builtin-and-tool-semantics`（56ab13b,已 push 未开 PR/未合 main）：① ToolSpec/help 增可选 effect/scope/confirm 语义字段（§5.1/§6.4d 数据源,向后兼容）;② NodeKind 增 builtin + `src/worker/tb/adapters/builtin.ts`（handler 宿主注入模式,内置 echo）。该仓库全部测试绿。Watt 侧消费方式与部署拓扑见 Round 15/16 记录。

---

# 轮次记录

## Round 23 — 2026-07-03（Phase 6 R23：Observability 地基——AuditLog 数据面 + Metrics）
- 目标：Phase 6 / DoD ③（metrics/status 真实）+ ⑤ 的审计基础（AuditLog 数据面从零到真实）
- 动作：investigator 先产出 `.llmdoc-tmp/investigations/phase6-feishu-observability.md`（五轮拆分 R23~R27；关键发现：审计零数据面、Metrics 无打点、**出站到飞书群的平台内接线完全空白**、IdentityMapper.resolve 桩；AE 本地 writeDataPoint 是 no-op 只能 spy → token 用量走 D1 usage 聚合表本地可测；飞书 WSClient Node-only 必须 CLI 承载）。worker 落地（commits 43712fd 附近三连）：
  - **AuditLog**：migrations-audit/0001（audit_records 表 + at/principal/decision 索引）；**Authorizer wrapper 单点 writeAudit**（17 个 Check 调用方不逐个改，PEP 横切收口；allow/deny 各一条，best-effort）；script-runner 绕过 wrapper 的判定点单独补 recordScriptAudit（判定不漏）；audit List(filter)+Get 真实查询；deploy-all/provision 同步 watt-audit migrations。
  - **Metrics**：usage 表打点（llm harness 从 Vercel AI SDK result.usage 取数 → D1 + AE writeDataPoint 双写，AE 绑定 watt_metrics）；Metrics.Query 服务 + /htbp/platform/metrics（tokens/events/agent_instances/tasks/authz_denials 最小面，range + groupBy model/agent/day）；CLI `watt metrics query` + `watt status` 汇总（实例数/Task 数/今日 token）。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**961 tests**：shared 6 + core 402 + cli 120 + gateway 433+1skip）；`pnpm deploy:all` exit 0（watt-audit migrations 线上应用）；**线上冒烟**：`watt audit list` 返回真实 AuditRecord（policy read/audit read 的 allow 各一条，context.principal=user:djj）；`watt metrics query --metric events --range 1d` v=44；**@llm 一次**（spawn smoke-llm → send → tokens 打点 22 → `--group-by model` labels={model:glm-5.2}）；`watt status` metrics{agentInstances:1,tasks:4,tokensToday:22}。
- 勾选：无（DoD ③ 集成面已通待关门复验一并勾；⑤ 需 CLI 完备 + Dashboard 对等）。
- 沉淀：AE 本地 no-op 坑待入 pitfalls；usage 表归属/status 聚合端点为实现声明候选。
- 遗留：R24 飞书 adapter（入站 core 规约 + 出站接线 + connect CLI）；R25 @feishu 集成 + manage/cron；R26 Dashboard + plugin + CLI 完备；R27 关门。

## Round 22 — 2026-07-03（Phase 5 关门轮）
- 目标：Phase 5 关门——4 维质量关口 workflow + 逐条对抗核查 + 确认项全修 + Docs 漂移回查 + 沉淀
- 动作：
  - **Docs 漂移回查**：Proto §3.4 回写 checkpoint 超时基线（human 10min/agent 5min，收口 #11）、§8 回写 checkpoints 由模板代码声明（收口 #14）。
  - **质量关口 Workflow**（4 维 correctness/contract/ops/test-quality + 对抗核查，19 agents；**按约不含渗透性安全维度**）：15 条确认（0 误报驳回），归并后 **2 BLOCKER + 6 MAJOR + 15 MINOR**。
  - **确认项全修**（3 worker 文件集互斥并行，commit 5a91fd7）：
    - **[BLOCKER] cron:<jobId> 链段上限完全失效**——core authorize 的纯直调捷径在 agent_def 缺省时早返回 allow，步骤 3 链段扫描（grants 上限/禁用→deny）对无 agent_def 的 cron claims 永不执行（对抗核查 tsx 实证）。修：捷径改「agent_def 缺省**且 chain 为空**」（§6.5a），步骤 2 加守卫；core +6 用例（deny 分支首次可达）覆盖率 100%；gateway +1 script deny 集成用例。
    - **[BLOCKER] waitForEvent 超时状态卡死**——三处裸 await 超时抛出→实例 errored 但状态表永卡 waiting_human/running（注释声称的 catch 是虚构）。修：human 超时→failed 落库+清 checkpoint；fan-in 单超时记 failed step 继续收其余；+9 测试（introspect forceEventTimeout 实测）。
    - **6 MAJOR**：Cancel 级联终止子实例（listInstances+task:<id># 前缀）；Cancel 终态守卫（done/failed→conflict、cancelled 幂等）；Signal 校验 checkpoint 匹配→invalid_argument；Write 非原子补偿（WATT_TASK.create 失败删 pending 孤儿行）；correlation emitFailed task waiter 占位改真实 deliverTaskResult 投递（成功才 settle，CorrelationEnv+WATT_TASK）；defaultTaskSignaler 四分支+principal 透传补测试。
    - 顺手：get() 删虚假 instance.status() 注释；cron.completed 错误摘要取 WattError.message（线上冒烟发现 [object Object]）。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**917 tests**：shared 6 + core 402 + cli 107 + gateway 402+1skip）；`pnpm deploy:all` exit 0；**线上关门复验**：① grants=[] script job trigger → cron.completed **ok:false error="cron script grant exceeded"**（BLOCKER 修复实证，修前会错误放行）；② grants 覆盖 job 同脚本 → ok:true 出站正常（回归）；③ auto-delivery-lite：Signal 错 checkpoint → **400 checkpoint mismatch**；正确 Signal → done；Cancel 已 done → **409 already in terminal state**。
- 勾选：无新增（三项 R21 已勾）→ **Phase 5 正式关门**。
- 沉淀：llmdoc 已收录（pitfalls §41-45、decisions task-workflow-instance-id/scheduler-script-runner、doc-gaps #11/#14 收口+#29 声明簇、current-state 翻页）；15 MINOR backlog（tasks 表无 TTL、cron 重试非幂等、scheduler List 丢 filter、toMergedResultPayload 丢 reason、cancelScheduleSafe 吞异常、fan-in 真实投递胶水本地 0 覆盖等）。
- 遗留：Phase 6（飞书 Channel + Observability + Management）为下一 Phase；backlog：模板 agent def 种子化、script 能力表扩容、Phase 4 的 13 MINOR。

## Round 21 — 2026-07-03（Phase 5 R21：Scheduler/M6 + 三项 DoD 勾选）
- 目标：Phase 5 / Scheduler 侧（SchedulerHub DO + publish/agent/script 三 action + script isolate + CLI cron 族）+ 三项 DoD 采证勾选
- 动作：worker 落地（commits b9bf71b/4eac13f）：SchedulerHub DO（Agents SDK Agent + this.schedule，CronJob 存内嵌 SQLite 多行表——Agent 基类可同时用 state + 自建 SQL 表）；六动词 + Trigger（disabled job 仍可手动 Trigger 补跑，enabled 只关到点自动）；三 action 双留痕（cron.fired → action → cron.completed，publish 亦发 completed 统一留痕面）；script action：ScriptRunner 可注入接口（**本地 vitest-pool-workers 无 LOADER 绑定实测确认**——fake runner 走同一 watt binding + Authorizer.Check(cron:<jobId> 链段) 路径，真 isolate 留部署侧）；claims=createdBy+IdentityMapper 实时 roles+chain=[cron:<jobId>]，authorize 以本 job 播种 cronJobs 索引自足；/htbp/platform/scheduler 六动词路由（**最后一个 501 占位清零，SPEC_TREE_PREFIXES 已空**）；watt cron list|create|trigger|rm；+32 测试。
- **部署侧修复**（主 assistant，commits 5b95466/a662d3d 类）：LOADER 真 isolate 冒烟两次失败迭代——① watt binding plain object 闭包函数不可跨 isolate clone → 改 RpcTarget；② **loader 的 env 字段连 RpcTarget 也走 structured clone 拒收** → 改经 run(watt) **RPC 调用参数**注入（Cap'n Web 在 RPC 边界把 RpcTarget 转 stub）。第三次冒烟通过。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**896 tests**：shared 6 + core 396 + cli 107 + gateway 387+1skip）；`pnpm deploy:all` exit 0（DO migration v4 SchedulerHub + worker_loaders[LOADER] 绑定上线，**Dynamic Worker Loader 账户已开通实证**）；**线上全链**：① publish action：cron create（*/5）→ trigger → event tail 见 cron.fired(manual)+smoke.cron.publish+cron.completed(ok:true)，且 15:55 到点 **trigger:scheduled 自动触发**亦留痕（Agents SDK schedule 线上真实工作）；② script action：脚本存 context://automations → cron create --action-kind script --grants → trigger → **LOADER 真 isolate** run(watt) 桩指标经 watt.publish 出站 → fired+completed(ok:true)；③ deep-research 线上全链：run → waiting_human@confirm-plan → signal approve → 2 agent fan-in echo 回传 → **done**；④ cron rm ×2 → list []。
- 勾选：**Phase 5 三项全勾**（项 1 R19+R21 单测面；项 2 R20+R21 task 集成；项 3 R21 cron script 线上全链）。
- 沉淀：pitfalls 候选（LOADER env 字段 structured clone 拒 RpcTarget→RPC 参数注入；本地 pool-workers 无 LOADER 绑定；loader stub 类型窄声明）；决策候选 script-runner 注入抽象。
- 遗留：R22 Phase 5 关门（4 维质量关口 workflow——不含渗透性安全维度 + 逐条对抗核查 + doc-gap #11/#14 收口 + current-state 翻页 + llmdoc 沉淀）；backlog：模板 agent def 种子化、script 能力表扩容（当前仅 watt.publish）。

## Round 20 — 2026-07-03（Phase 5 R20：Task/M7 on Cloudflare Workflows）
- 目标：Phase 5 / Task 侧（WorkflowEntrypoint + 两模板 + TaskManager + Signal 闭环 + CLI task 族）
- 动作：worker 落地（commit 91fc573）：wrangler workflows 段（watt-task/WATT_TASK/WattTaskWorkflow）;两模板（deep-research:真实 spawn(expect,taskWaiter) N=2 fan-in;auto-delivery-lite:登记→echo 桩→confirm-release checkpoint;human waitForEvent 10min/agent 5min 显式短超时——doc-gap #11 收口）;**taskId 即 Workflows instanceId,免映射表**（doc-gap 收口,决策待记）;TaskStore（watt-events 0002,归属理由声明）;TaskManager 七动词;**HITL 闭环接通**（consumer noopSignaler→真实 TaskSignaler+Check(task://,'signal'),principal 从 event.principal 取、缺省拒绝）;agent-deliverer task waiter 真实回送（sendEvent agent-result-<cid> 归并）;/htbp/platform/task 路由 + CLI 六命令;34 新测试含真实 Workflows introspect 全链。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**864 tests**：shared 6 + core 396 + cli 99 + gateway 363+1skip）;`pnpm deploy:all` exit 0（Workflows 绑定上线）;**线上全链**：`watt task run auto-delivery-lite` → pending→（冒烟发现:模板依赖 echo agent def 未注册导致卡 running——注册 def 后 Workflows 重试推进,**模板依赖的 agent def 需要种子/文档,记 backlog**）→ waiting_human@confirm-release → `watt task signal --decision approve` → **done**;第二任务 `watt task cancel` → **cancelled**。
- 勾选：无（DoD 项 1 单测面已含 core+gateway,项 2 集成链已通,待 R21 Scheduler 后一并勾——项 2 原文含 cron 链）。
- 沉淀：决策候选 task-workflow-instance-id;pitfalls 候选（本地 Workflows hibernate status 报 running——测试以状态表为真源;Serializable 递归类型 TS2589 用浅 record）。
- 遗留：R21（Scheduler/M6:SchedulerHub DO + publish/agent/script 三 action + script isolate LOADER/降级 + cron.fired/completed 留痕 + CLI cron 族）→ 勾项 1/2;R22 关门(项 3 部署冒烟已可提前采证)。backlog:模板 agent def 种子化。

## Round 19 — 2026-07-03（Phase 5 R19：前置核实 + core 纯逻辑）
- 目标：Phase 5 / DoD 项 1 纯逻辑面（Signal 状态机、事件名净化、cron 解析、checkpoint guard 下沉）
- 动作：investigator 先产出 `.llmdoc-tmp/investigations/phase5-task-scheduler.md`（Task=Workflows 全就绪:类型/vitest introspect 本地测/绑定,仅缺 wrangler workflows 段+两模板;Scheduler=Agents SDK this.schedule;script=Dynamic Worker Loader,本地 dry-run 验证 worker_loaders binding 语法可用,线上 open beta 待真部署核实;HITL 只差 noopSignaler→WATT_TASK.sendEvent 接线;@feishu 不涉本 Phase;四轮拆分）。主 assistant 核实 worker_loaders binding dry-run 通过。worker 落地 `packages/core/src/task/`：`types.ts`（TaskInfo 7 态/TaskDetail/SignalRequest/scheduler CronJob 全字段面,与 authz 最小面 CronJob 用别名 SchedulerCronJob 避撞）、`signal.ts`（waiting 外→conflict）、`event-names.ts`（净化不截断,超长→invalid_argument）、`cron.ts`（五段分钟级子集手写——纪律 4 核实:agents/schedule 只导出 LLM zod schema,内部 cron-schedule 未导出纯函数,理由声明）、`checkpoint.ts`（consumer type guard 下沉,gateway 改 import 留 R20）。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**833 tests**：shared 6 + core 396 + cli 93 + gateway 338+1skip;core 覆盖率 100%）。
- 勾选：无（项 1 需 gateway 面合体验收）。
- 沉淀：调研报告落 `.llmdoc-tmp/`。
- 遗留：R20（Task/M7:WorkflowEntrypoint watt-task + deep-research/auto-delivery-lite 模板 + TaskManager 服务含 taskId↔instanceId 映射 + Signal 接线+Check(task://,'signal') + CLI task 族 + introspect 集成测）;R21（Scheduler/M6:SchedulerHub DO + 三 action + script isolate/降级 + CLI cron 族）;R22 关门。

## Round 18 — 2026-07-03（Phase 4 关门轮）
- 目标：Phase 4 关门——质量关口 Workflow + 确认项全修 + DoD 线上复验 + 沉淀
- 动作：
  - **用户方向修正（评审期间并行）**：模型调用手拼 HTTP 违反 LOOP 纪律 4——重构为 **Vercel AI SDK**（ai@6 + @ai-sdk/anthropic@3;版本锁 ai@6 是 agents@0.17.3 的 peer 硬约束;pi SDK 为 Node-only 已排除;决策记录 memory/decisions/model-call-sdk.md）;llm harness 保持单次调用+schema 重试语义,agentic loop 声明留给 Agents SDK/Claude Agent SDK（commit 5eeced6,@llm 真实模型复验绿）。
  - **质量关口 Workflow**（4 维+对抗核查,21 agents;6 个核查因中转 502 失败未复核——对应 finding 按 MINOR 保守处理）：2 BLOCKER + 10 MAJOR 确认（0 误报）,13 MINOR backlog。
  - **确认项全修**（2 worker 文件集互斥并行）：
    - `913b192` runtime 侧：**[BLOCKER] 规则 3/4 代发 failed 被自身 settle 吞掉**——correlation DO 改直投 waiter（绕开 routeResult 去重自吞）+ EventStore 留痕 + 投递成功才 settle;routeResult 改 peek(delivering)→deliver→confirm 三态,失败 rollback + msg.retry;subtree 分批遍历去 200 上限 + terminated 行 7 天 sweep;模型调用 AbortSignal.timeout(60s);**Spawn 幂等 bug**（重复 Spawn 重置 children/input）连带修;Terminate 清 waiter 侧 correlation;@llm 门控 fail-loud;+15 测试。
    - `5ee1a26` tools 侧：**[BLOCKER] fake 掩盖 call 契约漂移**——上游语义:工具名走 URL end-path、body 是参数;CLI 原发 {tool,arguments} 到节点级 URL 对 http/mcp 必炸,线上 echo 服务"什么都吞"恰好掩盖。修:CLI call 拼 end-path + {arguments} 信封;proxy 按 provider 归一化(http 拆信封发裸参数/mcp·builtin 透传);fake 忠实上游按节点 type 分派;syncTenantTree 树 hash 变更才写 KV（撞 1 写/秒限制）;provision 回填 toolbridge KV id（从零拉起断裂）;deploy-all secrets 检查;vendor patch 守卫脚本。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**751 tests**：shared 6 + core 314 + cli 93 + gateway 338+1skip）;`pnpm deploy:all` exit 0（含 secrets 检查通过）;**线上 DoD 复验**：`watt tool call test/watt echo-get --args '{}'`（新契约:end-path+信封拆解）→ 200 postman-echo 裸参数往返;agent spawn gate4-1 → send --expect-schema → **agent.result correlationId 精确匹配、output schema 合法**（真实模型）→ terminate。@llm 真实测试本轮跑 2 次（SDK 重构验证 + 关门复验,均绿——超出每轮一次上限,因中途换 SDK 属必要复验,留痕声明）。
- 勾选：无新增（Phase 4 三项 Round 14/16/17 已勾;本轮为关门质量修复）→ **Phase 4 正式关门**。
- 沉淀：13 MINOR backlog（ModelProvider resolveDefault 死代码未接 harness、output ≤1MiB 未实施、lastActiveAt 语义漂移、toolbridge 公网可达+固定转发凭据、vendored 未合并分支锚点等）;doc-gap 候选（CorrelationEnv 绑定契约、settled 三态、TERMINATED_TTL 7d、模型超时 60s、HTBP call 请求形状契约）;llmdoc 沉淀本轮触发。
- 遗留：Phase 5（Task + Scheduler）是下一 Phase;6 个未复核 finding 若后续轮碰到相关文件顺手核。

## Round 17 — 2026-07-03（Phase 4 R13：Agent Runtime + @llm 集成，DoD 项 3）
- 目标：Phase 4 / DoD 项 3（Agents SDK Light Runtime + AgentRegistry/AgentRuntime + ModelProvider + CLI + @llm 真实模型集成）
- 动作：worker 落地（commit 22c53e0）：**agents 包在 vitest-pool-workers 可用**（冒烟测试确认,调研的首要风险排除）;AgentInstance（Agents SDK Agent 类,echo/llm 双 harness,模型调用注入——fake 测试/真实 Anthropic 中转）;AgentRegistry（providers 库 0002,declarative subscriptions→EventRouter 规则 1 联动）;AgentRuntime（Spawn instanceKey 幂等→idFromName/Send+expect→correlation register/Terminate cascade→failWaiter 产 terminated faileds/ListInstances tree）;consumer agent sink 真实投递,agent.result/failed 先走 core routeAgentEvent（§3.4 定向回送/去重;超时 DO alarm 扫描代发）;ModelProvider 最小版（0003,set-default）;路由 platform/agent+platform/provider;CLI agent 六命令+provider 三命令。主 assistant 收口三个修复:① @llm 测试 env 门控经 miniflare bindings 注入（workerd 无宿主 process.env——此前 skip 假象）;② **agent.result/failed 未落 EventStore**（consumer 注释假设 publish 时已留痕,但 harness 直发 QUEUE——线上冒烟发现 tail/List 查不到,补 put）;③ Spawn 路由未透传 parent → tree 无派生关系（冒烟发现,补透传）。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**737 tests**：shared 6 + core 314 + cli 93 + gateway 323+1skip）;**@llm 真实模型测试**（LLM_TESTS=1,中转 llm.fantacy.live,glm-5.2）1 passed——本轮唯一一次 @llm 消耗（LOOP 纪律 3）;`pnpm deploy:all`（ANTHROPIC_API_KEY/BASE_URL secrets 上线）;**线上 DoD 全链**：agent def Write→spawn smoke-1→send --expect-schema(sentiment/score schema)→**agent.result output {"sentiment":"positive","score":0.95} schema 合法、correlationId 与 Send 返回一致**→Spawn(parent:smoke-1)→`watt agent tree` 显示 children:[smoke-child-2]→terminate --cascade → 三实例全 terminated。
- 勾选：Phase 4 项 3 → **Phase 4 三项全勾**（关门待做）。
- 沉淀：实现声明待关门轮:harness 选型由 model 声明推导（entry.className 恒 AgentInstance,doc-gap 候选）、correlation 宿主独立 DO AGENT_CORRELATION、registry/model-provider 挂 watt-providers 库、agent.result 留痕由 instance 自行 put(非经 publish)。
- 遗留：Phase 4 关门（质量关口 4 维 review + 对抗核查 + Docs 漂移回查 + llmdoc 沉淀）是下一轮唯一目标;冒烟发现的 http mount config 形状文档缺口（Round 16 backlog）可关门轮顺手。

## Round 16 — 2026-07-03（Phase 4 R12 后半：watt-toolbridge 部署 + tools 代理 + DoD 项 2）
- 目标：Phase 4 / DoD 项 2 后半（/htbp/tools 代理 + Check PEP + watt tool describe|call 闭环）
- 动作：worker 落地:`packages/toolbridge`（**vendored** 上游 worker 源码 @56ab13b——上游运行时依赖含整套 dashboard UI(React/vite),纯代理目标不需要,vendor src/worker + 独立 tsconfig + 一处 ASSETS patch 有标注;升级流程写入 README）;gateway `http/tools-proxy.ts`（认证→tool://<path> Check PEP→service binding TOOLBRIDGE 转发→上游 {error:{}} 转裸 WattError→List/~help 按调用者逐 path Check('read') 裁剪）;SPEC_TREE_PREFIXES 移除 /htbp/tools;CLI `watt tool describe|call`;deploy-all 先 toolbridge 后 gateway。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**661 tests**：shared 6 + core 314 + cli 79 + gateway 262）;部署双 Worker（watt-toolbridge + watt-gateway,service binding 挂载）;**线上闭环**：`watt tool mount test/watt --provider http --config '{"endpoints":[...]}'` → `watt tool describe`（经代理返回 HTBP help DSL 树）→ `watt tool call test/watt/echo-get '{}'` → 200 `{resource,result}`（postman-echo 真实往返）;403/裁剪由 tools-proxy.test.ts 16 tests 锁定（scoped token 无权树 403 + ~help 裁剪不可见——Case 4 预演）。**冒烟发现并明确**:http mount 的 providerConfig 形状必须是上游 HttpEndpointConfig 的 `{endpoints:[{name,method,url,...}]}`,单 `{endpoint}` 会 500——CLI/文档待注明(backlog)。
- 勾选：Phase 4 项 2。
- 沉淀：vendoring 决策与升级流程在 packages/toolbridge/README.md。
- 遗留：R13——Agents SDK Light Runtime（装 agents 包,echo/LLM harness）+ AgentRegistry/AgentRuntime + ModelProvider 最小版 + CLI agent/provider 命令族 + @llm 集成（DoD 项 3,每轮每 tag 一次）;R14 关门。

## Round 15 — 2026-07-03（Phase 4 R12 前半：tool-bridge 上游 + ToolRegistry）
- 目标：Phase 4 / DoD 项 2 前半（上游能力补齐 + Watt 侧 ToolRegistry/platform 路由/CLI mount|ls）
- 动作：两 worker 并行：
  - **上游 tool-bridge**（LOOP §2.1 通道）：分支 `feat/watt-builtin-and-tool-semantics`（commit 56ab13b,已 push 未开 PR）——① ToolSpec/help 语义字段 effect/scope/confirm（向后兼容缺省）;② builtin 节点类型 + `adapters/builtin.ts`（handler 注册表由宿主注入,tool-bridge 保持通用;内置 echo 参考实现）;全部测试绿（基线+新增）。
  - **Watt 侧**：core `tools/types.ts`（toolMountSchema §5.2:mcp/http/builtin + virtualize 四项）;gateway `tools/tool-registry.ts`（watt-providers 库,migrations-providers/0001）+ `/htbp/platform/tool` 管理面路由（List/Get=read,Write/Update=manage）;CLI `watt tool mount|ls`（describe/call 留代理轮）;第四 migrations 库接线（provision/deploy-all/vitest 三件套）。
  - **宪法先行**：Architecture M4 树宿主边界修订（commit 22960b2）——逻辑单一入口、物理分治:gateway 自持 platform/context,tool-bridge 承载 tools,gateway 代理层做 Check PEP（消除调研发现的边界矛盾）。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**645 tests**：shared 6 + core 314 + cli 73 + gateway 252;core 覆盖率 100%）;`pnpm provision`（DB_PROVIDERS migrations_dir 回填）;`pnpm deploy:all` exit 0（watt-providers migrations 应用）;线上冒烟:`watt tool mount test/echo --provider http` → 200 mount 形状;`watt tool ls` 可见。
- 勾选：无（项 2 需 /htbp/tools 代理 + Check PEP + `watt tool call` 闭环后整体验收）。
- 沉淀：上游改动记录入本文件"上游改动记录"节。
- 遗留：R12 后半——gateway 引用上游分支部署 watt-toolbridge Worker + service binding + /htbp/tools 代理(错误形状转换 {error:{}}→裸 WattError) + Check PEP/可见性裁剪 + `watt tool describe|call` + 无权限 403/ls 不可见测试 → 勾项 2;然后 R13 Agents SDK。

## Round 14 — 2026-07-03（Phase 4 R11：core Agent 纯逻辑）
- 目标：Phase 4 / DoD 项 1（§3.4 六条规则逐条、schema 校验失败→重试→invalid_output、correlationId 字符集校验、Spawn 幂等键）
- 动作：investigator 先产出 `.llmdoc-tmp/investigations/phase4-tool-agent.md`（tool-bridge 上游现状:HTBP 树/虚拟化/租户/~help 已备,缺 builtin 节点+effect/scope/confirm 字段+错误契约对齐;集成拓扑倾向独立 watt-toolbridge Worker + service binding 代理 /htbp/tools;Agents SDK 未引入有共存风险;四轮拆分建议）。worker 落地 `packages/core/src/agent/`（纯逻辑,test-first）：`types.ts`（AgentDefinition/SpawnRequest/ExpectSpec/AgentResult/AgentFailed zod）、`correlation.ts`（字符集校验 `[A-Za-z0-9_-]`≤80 + CorrelationTable 状态机:register/resolve-once/expire/failWaiter）、`routing.ts`（§3.4 六规则纯判定:定向回送/派生回送/超时代发(真实结果晚到→drop-duplicate 幂等)/终止即失败/等待方消失丢弃/去重）、`expect-schema.ts`（最小 JSON Schema 子集校验器 type/properties/required/items/enum,声明子集范围;重试 maxAttempts=3 实现声明→invalid_output）;Spawn 幂等键复用 eventbus resolveInstanceKey 不重写。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**597 tests**：shared 6 + core 302 + cli 62 + gateway 227;core 覆盖率 100%：438/438）。
- 勾选：Phase 4 项 1（core 面;含 §3.4 六规则/schema 重试/correlationId/Spawn 幂等键全部单测）。
- 沉淀：调研报告落 `.llmdoc-tmp/`;实现声明（JSON Schema 子集、maxAttempts=3、CorrelationTable 接口）待关门轮入 doc-gaps。
- 遗留：R12（tool-bridge 上游补 builtin+effect/scope 字段 → Watt 侧 ToolRegistry + /htbp/tools 代理 + Check PEP → DoD 项 2）;R13（Agents SDK Light Runtime + AgentRegistry/AgentRuntime + @llm 集成 → DoD 项 3）;R14 关门。**待决策**：Architecture M4 "tool-bridge 是整棵 HTBP 树宿主" 与 gateway 已自建 platform/context 子树的边界矛盾（倾向方案 A:代理仅 tools,需回写 Architecture 或记 doc-gap）。

## Round 13 — 2026-07-03（Phase 3 关门轮）
- 目标：Phase 3 关门——质量关口 Workflow + 确认项全修 + DoD 线上复验 + 沉淀
- 动作：
  - **质量关口 Workflow**（4 维 review + 逐条对抗核查,20 agents）：16 条 MAJOR 全部确认（0 误报,去重后 9 个独立问题）,14 MINOR 记 backlog。
  - **确认项全修**（2 worker 文件集互斥并行）：
    - `2299b94` gateway：**vector provider 重构为 D1 sidecar**（权威数据入 DB_CONTEXT:全文/version/metadata;Vectorize 只存 embedding+引用——一举修掉 2048 截断数据丢失、List unavailable 违反 §4.1、Vectorize 最终一致使 read-after-write 不可靠三条;metadata-only Update 不再重算 embedding）;**并发条件写**（D1 UPDATE WHERE version=? + changes 判定;R2 put onlyIf etagMatches/etagDoesNotMatch——并发同 ifVersion 写现在正确 conflict）;**Search namespace filter 下推**（provision 增 create-metadata-index 幂等步骤 + query filter + 本地双保险——修 topK 被全 namespace 稀释）;**Delete 路由接通**（~help 宣告与可调用面矛盾消除）;**TTL 物理清理**（过期回收真实清 R2 前缀/D1 namespace 行/Vectorize 向量;unmount 保持只卸载不清数据,实现声明）;新增 36 测试。
    - `1e00431` cli+core：CLI put/patch 精确解包 {meta}（删双形态兜底——掩盖漂移;mock 全部对齐 gateway 测试锁定的真实形状,文件头声明真源）;core contextEntryInputSchema 收紧 content 必须存在（曾接受缺省→provider 500）;CLI 测试补 headers 断言。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**511 tests**：shared 6 + core 216 + cli 62 + gateway 227;core 覆盖率 100%：327/327）;`pnpm provision`（metadata index created,重跑幂等）;`pnpm deploy:all` exit 0;**线上 DoD 全链复验**：object mount→put→ls→cat→patch(version 1→2,metadata 合并)→cat --json;vector mount→put×2→**List 可用（sidecar 后新能力）**→cat 返回全文→Search 召回 doc1 居首（metadata filter 生效）;**Delete tool 200 {deleted:true}**（修复前 400）;~help 仍五条 cmd 行;unmount×2。
- 勾选：无新增（Phase 3 三项 Round 12 已勾;本轮为关门质量修复）→ **Phase 3 正式关门**。
- 沉淀：doc-gaps #27（Phase 3 关门实现声明簇,见下条修订）;llmdoc 关门沉淀（current-state 翻页/新坑/reflection）本轮触发;Docs 漂移回查——vector List 恢复实现无需改 Docs;附B 已在 Round 11 增补。
- 遗留：14 条 MINOR backlog（List opts 未校验 NaN、R2 customMetadata 大小上限、基础设施故障统一 500 未分 unavailable、§11.3a List 权限裁剪只做前缀级、成功响应信封 {entry}/{meta}/裸 Page 不一致未成文、List 递归 vs 浅层表述等——均记 doc-gap 候选或 backlog）;下一 Phase 4（Tool Layer + Agent Runtime,含 tool-bridge 上游通道）。

## Round 12 — 2026-07-03（Phase 3 Round B/C：provider + 路由 + CLI + 部署冒烟）
- 目标：Phase 3 / DoD 项 1 gateway I/O 面 + 项 2 集成 + 项 3 ~help（三项全闭环）
- 动作：3 个 worker 接力/并行落地：
  - **p3-providers**：`migrations-context/0001`（entries 复合主键表，挂新库 watt-context——附B 已先行增补,宪法先行）；ContextRegistry DO（mounts 表 + 惰性 TTL + alarm 兜底清挂载行）；三 provider——object（R2,customMetadata 承载 meta,自管整数 version）/structured（DB_CONTEXT）/vector（Vectorize+AI bge-m3,依赖注入 mock,List→unavailable 用 Search）；接线（env/wrangler ai+DO 绑定+migrations v2/provision D1_NAMES/deploy-all 第三库/vitest 三件套 + `remoteBindings:false` 新坑——AI 绑定会触发远程代理会话）。
  - **p3-routes**：`/htbp/platform/context` 管理面五动词（platform://context read/manage）+ `/htbp/context/<ns>` 消费面四动词+Search（context://<ns>/<path> read/write 拦截,readOnly 写→403,TTL 过期→404）+ GET `~help` 免认证（§11.3a 渐进发现,doc-gap 候选）;SPEC_TREE_PREFIXES 移除 context;19 路由测试。
  - **p3-cli**：`watt context ls|cat|put|patch|mount|unmount`（消费/管理两挂载点,put 三路 content 输入,请求形状精确断言）;21 测试。
  - **主 assistant 收口**：provision 跑通（watt-context 创建 id=3e741fe1 回填,MD5 幂等复核过——注意 KV list 在代理 env 下会误报 already exists,不带 proxy 重跑即好）;线上冒烟揪出 3 个跨包错配并修复（CLI put 缺必填 contentType→缺省 text/plain;R2 list 不带 include customMetadata 致 meta 退化;CLI cat 未解包 {entry}）——**Phase 2 教训重演:mock 形状断言挡不住"双方都按自己理解写"的错配,唯有线上全链**。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**491 tests**：shared 6 + core 213 + cli 62 + gateway 210;core 覆盖率 100%）;`pnpm provision` 幂等;`pnpm deploy:all` exit 0（watt-context migrations 应用,AI/DO 绑定上线）;**线上 DoD 全链**（workers.dev,经代理）：`context mount smoke-notes --provider object` → put→ls（真实 contentType/metadata）→cat（content 原文）→patch（metadata 合并,version 1→2）→cat --json 全字段;`mount smoke-vec --provider vector` → put×2 → Search "edge serverless JavaScript platform" 召回 doc1 居首（真实 AI embeddings+Vectorize）;GET ~help → text/plain 五条 cmd 行;unmount×2 → ls 404。
- 勾选：**Phase 3 三项全勾**（关门待做）。
- 沉淀：待关门轮统一——新坑候选（AI 绑定 remoteBindings:false/R2 list include/DO RPC 联合类型 narrow-to-never/htbpCall platform 硬编码需抽 base-path）;doc-gap 候选（~help 免认证层级、readOnly 拒绝码 403、vector List unavailable、TTL 物理 GC 不清 provider 条目、contextEntryInputSchema content z.unknown() 接受 undefined 的收紧）。
- 遗留：Phase 3 关门（质量关口 4 维 review + 对抗核查 + Docs 漂移回查 + llmdoc 沉淀）是下一轮唯一目标。

## Round 11 — 2026-07-03（Phase 3 Round A：core 纯逻辑）
- 目标：Phase 3 / DoD 项 1 纯逻辑面 + 项 3 parser（按调研报告 Round A 拆分）
- 动作：investigator 先产出 `.llmdoc-tmp/investigations/phase3-context-layer.md`（规范面清单/存储选型/DO 设计/Help DSL/三轮拆分）；据其发现先修宪法：Architecture 附B 增补 watt-context D1（M3 structured）与 watt-events-dlq。worker 落地 `packages/core/src/context/`（零 Cloudflare 依赖，test-first）：`types.ts`（NamespaceMount/ContextEntryMeta/ContextEntry/ContextPatch/ContextEntryInput zod）、`resolve.ts`（context:// URI 解析 + namespace 最长前缀段边界匹配）、`ttl.ts`（isExpired 纯判定，无 ttl 永不过期）、`verbs.ts`（checkIfVersion→conflict / requireExisting→not_found / applyPatch metadata 浅合并+content 替换）、`help.ts`（generateContextHelp + parseHelpDsl 最小 parser——doc-gap #21 parser 部分收口）。
- 验证（主 assistant 亲自跑）：`pnpm --filter @watt/core exec vitest run --coverage` → 213 tests 绿，覆盖率 100%（326/326 语句、220/220 分支）；`pnpm verify` exit 0（**404 tests**：shared 6 + core 213 + cli 41 + gateway 144）；tsc noEmit 0 错。
- 勾选：无（项 1 需 gateway I/O 面合体后整体验收）。
- 沉淀：调研报告落 `.llmdoc-tmp/`；附B 增补已 commit（1afd688）。
- 遗留：Round B（gateway：ContextRegistry DO + object/structured/vector 三 provider + watt-context 库接线 + AI 绑定 + HTBP context 子树路由 + 权限拦截）；Round C（CLI 六命令 + 部署冒烟 + 关门）。

## Round 10 — 2026-07-03（Phase 2 关门轮）
- 目标：Phase 2 关门——质量关口 Workflow + 确认项全修 + DoD 重跑 + 沉淀
- 动作：
  - **质量关口 Workflow**（4 维 review：correctness/contract/ops/test-quality + 逐条对抗核查,19 agents;按用户指示评审不含渗透性安全维度,phase-gate guide 已同步改 4 维并 commit）:15 条 MAJOR 全部确认成立（0 误报）,17 条 MINOR 记 backlog。
  - **15 MAJOR 全修**（4 worker 并行 + 主 assistant 收口格式/提交）,按主题分 5 个 commit:
    - `952f65a` event-bus:queue.send 失败补偿（best-effort 删留痕防 dedupe 吞重试,返回 unavailable/retryable）+ channelUser→IdentityMapper.Resolve 接线（未映射→user:anonymous）+ EventStore.delete + list limit 下界钳制。
    - `a7bb36f` inbound:非 webhook adapter 显式 501（§0.2）+ bodyRaw 改 arrayBuffer 严格 UTF-8 解码/失败转 base64（§2.1 字节精确,非 UTF-8 验签集成测试锁定）+ core normalizeEvent 保留调用方 occurredAt（§2.1 Decode 义务;Proto §2.3 已加规范性澄清——宪法先行）。
    - `6e8e457` routes:Publish 入参 eventInputSchema.safeParse（畸形→400 invalid_argument 非 500）+ Platform API Publish 无条件规约 source.kind='webhook'（§2.3 规范性）+ 新增 platform-event.test.ts 13 个 SELF.fetch 服务端契约测试（补零测试盲区）。
    - `c6fc35d` consumer:§1.1 HITL system subscriber（task.checkpoint→带 actions 的 outbound.message 卡片、im.action(signal)→TaskSignaler 桩留 Phase 5）+ §2.3 规则 2（im.bot_joined→defaultAgent 的 session 订阅,(definition,session) 去重）+ DLQ watt-events-dlq（wrangler.jsonc consumer + provision 队列清单）+ consumer 测试补多 sink 部分失败/粘性映射落库断言/unsubscribe 后不投递。
    - `b62af34` CLI tail:显式 limit 200 + 游标去 +1ms 改含端重查 + 同毫秒 id 去重（Set 仅存游标毫秒,防无界）+ 满页 stderr 截断警告;死测试重写为两轮真实轮询断言。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**354 tests**：shared 6 + core 163 + cli 41 + gateway 144;core 覆盖率 100%：247/247 语句、166/166 分支）;`pnpm provision` 幂等重跑（watt-events-dlq 已创建,wrangler.jsonc 字节级幂等）;`pnpm deploy:all` exit 0（DLQ consumer 上线）;**线上 DoD 重跑**（workers.dev,经本机代理）：签名 inbound 200 / 错签 403 / 未知 channel 404 / 同 delivery-id 重发返回原 eventId / event get·tail·channel list 全通 / webhook.site sink 订阅→投递 count=1→重发仍 1→unsubscribe;**修复项线上冒烟**：Publish {} → 400 invalid_argument（zod 明细）;Publish 自报 source.kind=system → Get 读回已规约为 webhook。
- 勾选：无新增（Phase 2 三项此前已勾;本轮为关门质量修复）→ **Phase 2 正式关门**。
- 沉淀：doc-gaps 新增 #24（occurredAt 矛盾,已回写 Proto §2.3）、#25（Phase 2 实现声明簇：source.kind 规约/HITL 系统投递免 Check/Signal 桩/DLQ/session 形状/补偿边界）;phase-gate guide 改 4 维评审;llmdoc /llmdoc:update 待做（current-state 翻页 + reflections）。
- 遗留：17 条 MINOR backlog（dedupe check-then-put 并发窗、fetchDeliverer 无超时/不分 4xx/5xx、ListSubscriptions opts 未校验、~help 缺失 #21、cursor 分页 #22 等）不阻塞,随后续 Phase 顺手修;本机网络新状况：workers.dev 直连偶发超时,验证脚本需带 https_proxy（sign-admin-token.mjs 需 NODE_USE_ENV_PROXY=1）。

## Round 9 — 2026-07-02
- 目标：Phase 2 / DoD 项 2（集成全链）+ 项 3（部署冒烟）
- 动作：按 Round 8 调研报告拆 5 子块，4 个 worker 分两波并行落地：
  - **子块 B（存储）**：`migrations-events/0001_event_gateway.sql`（events 表 + 5 索引 + channels 表，挂 watt-events 库）；DB_EVENTS 加 migrations_dir；vitest.config/apply-migrations 三件套连带；deploy-all 加第二条 `d1 migrations apply watt-events --remote`；`event-store.ts`（list/get/put/findByDedupeKey，复用 policy-store 的 ListOptions/Page 模式）；`channel-store.ts`（ChannelConfig 四动词，schema 在 core eventbus/types.ts）。
  - **子块 C（webhook adapter）**：core `eventbus/hmac.ts`（WebCrypto HMAC-SHA256 + 常量时间比较，`sha256=<hex>`）；gateway `event/adapters/webhook.ts`（§2.1 全四义务：Verify 对 bodyRaw 原文验签、Decode 产 webhook.received 义务字段 + dedupeKey 取 `x-watt-delivery-id`、Encode/Send fetch 注入）。
  - **子块 D（Router DO + consumer）**：`event-router.ts`（首个 DO：原生 DurableObject + ctx.storage.sql，订阅表 + session_instances 粘性映射；RPC subscribe/unsubscribe/listSubscriptions/matchSubscriptions（复用 core matchesSubscription）；单例 idFromName('router')）；`event-bus.ts` publish 服务（authorizeOutbound → normalizeEvent → 128KB 校验 → dedupe 幂等短路 → EventStore.put → Queue send）；`consumer.ts` queue handler（webhook sink fetch 投递 ack/retry；agent/task sink 占位记映射留 Phase 4/5）；wrangler.jsonc 加 durable_objects + DO migrations(new_sqlite_classes) + queues.consumers（无 DLQ，调研已定）；入口改 `export default {fetch, queue}` + export EventRouter。
  - **子块 E（路由 + CLI + 集成）**：`/htbp/platform/event`（List/Get/Publish/Subscribe/Unsubscribe/ListSubscriptions）与 `/htbp/platform/channel`（四动词）真实路由（501 占位移除，过认证）；`http/inbound.ts` 真实化 `/channels/:id/inbound`（无认证验签即认证：404 未知 channel / 403 disabled / 501 非 webhook adapter / 403 错签名 / secret 走 settings.verifySecretRef 引用）；CLI `watt event tail|get|subs`（tail = 轮询 List + occurredAt 游标 + --once）与 `watt channel list|set`；集成测试 `integration-event-flow.test.ts` 全链。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**314 tests**：shared 6 + core 156 + cli 41 + gateway 111；core 覆盖率 100%：247/247 语句、164/164 分支）；集成测试单独重跑 4 tests 绿（订阅→inbound→留痕→投递→dedupe 幂等 + 403/404/disabled 三向）；**部署冒烟（项 3，workers.dev 真实 URL）**：`pnpm deploy:all` exit 0（watt-events migrations 生效、DO EventRouter + Queue consumer 双绑定上线）→ sign-admin-token --rotate → whoami admin → wrangler secret put WEBHOOK_SECRET_SMOKE → `watt channel set smoke-hook` → 正确 HMAC POST inbound 200 `{eventIds:[c6c07d00]}` / 错签名 403 permission_denied → `watt event tail --once` 与 `event get` 可见规约 Event（type webhook.received、dedupeKey webhook:smoke-hook:smoke-d1）→ Subscribe webhook sink（webhook.site）→ 新事件 inbound → **sink 收到投递（count=1，事件 id 一致）** → 同 delivery-id 重发 → 返回原 eventId 且 **sink count 仍为 1（只投递一次）** → Unsubscribe 清理。
- 勾选：Phase 2 项 2、项 3 → **Phase 2 三项全勾**（关门待做）。
- 沉淀：本轮暂记 PROGRESS，待关门轮统一 /llmdoc:update（DO 首次引入的接线知识、HTBP Subscribe 参数形状 `{subscription}`、webhook adapter 实现自由决策——header 名 x-watt-signature / x-watt-delivery-id、session scope 用 channelId、payload parse 失败降级 {text}——均需 recorder 收录 + doc-gaps 候选）。
- 遗留：Phase 2 关门（质量关口 5 维 review + 对抗核查 + Docs 漂移回查）是下一轮唯一目标；agent/task sink 只存映射/占位（Phase 4/5 接上）；订阅匹配拉全表过滤（量级小，注释已声明扩展点）；`E2E_WEBHOOK_SINK_URL` 仍空（冒烟用了临时 webhook.site，不阻塞）。

## Round 8 — 2026-07-02
- 目标：Phase 2 / DoD 项 1（单测：订阅匹配（type 通配/AND 语义/session）、instanceBy 三态路由、Verify 失败拒收、出站鉴权点（`event://` write））
- 动作：worker 落地 `packages/core/src/eventbus/`（纯逻辑零 Cloudflare 依赖，test-first 分 3 批 commit）：`types.ts`（Subscription/SubscriptionMatch/SubscriptionSink/OutboundMessage zod 层）；`matches.ts`（match 全 AND、缺省字段跳过、type 后缀通配——`"*"` 全通配合法、`"im.*"` 前缀含点不匹配裸 `"im"`）；`instance-key.ts`（singleton→definition 键 / event→event.id 键 / session→definition+session 键，key 即 §3.2 SpawnRequest.instanceKey 幂等键；**session 态缺 event.session → 显式 invalid_argument 不 fallback**，doc-gap #23）；`inbound.ts`（processInbound：Verify false → permission_denied 拒收短路不 Decode；边界止于 Decode，补齐/Publish 留项 2）；`outbound.ts`（outboundAccessRequest：outbound.message → `event://<channel>/<target>` + 'write'，payload 畸形 → invalid_argument；authorizeOutbound 与 §6.4c authorize() 组合）。并行派 investigator 产出项 2/3 前置调研（Queue consumer 接线/Router DO 选型/EventStore schema/webhook adapter/CLI/sink 边界）。
- 验证（主 assistant 亲自跑）：`pnpm verify` → exit 0（**226 tests**：shared 6 + core 140(+45) + cli 33 + gateway 47；core 覆盖率 100% 保持：Statements 213/213、Branches 148/148）；契约核对：主 assistant 逐文件对照 Proto §2.1/§2.3 原文核读 4 个实现文件，无偏离；无接口面/HTTP 变更故 CLI 不需生长；纯逻辑无部署项。
- 勾选：Phase 2 项 1。
- 沉淀：doc-gaps 新增 #23（instanceBy session 缺失行为 + type 通配两项实现声明）；investigator 调研报告落 `.llmdoc-tmp/investigations/phase2-event-gateway-integration.md`（项 2 拆分依据）。
- 遗留：项 2 依赖较重（Queue consumer 绑定 + Router 订阅存储 + EventStore migrations + 内置 webhook adapter + `/htbp/platform/event` 路由 + `watt event/channel` CLI），大概率拆两轮：先服务端管线（inbound→Publish→Queue consumer→EventStore/投递），再 CLI+集成闭环；deploy-all migrations 步骤硬编码 watt-policies 单库——watt-events 加 migrations 时必须同步扩展（Round 7 遗留注释已标）。

## Round 7 — 2026-07-02（Phase 1 关门轮）
- 目标：Phase 1 关门——质量关口确认项全修 + DoD 重跑 + 文档回写
- 动作：质量关口 review（5 维 + 手工）确认的 1 BLOCKER + 8 MAJOR + 4 MINOR 全部修复（4 个 worker 并行 + 主 assistant 收口）：
  - **[BLOCKER] deploy:all 缺 D1 migrations**：provision 与 deploy 之间插入 `wrangler d1 migrations apply watt-policies --remote`（幂等）；根 package.json 增 `migrate` 脚本。
  - **[MAJOR] policy Update patch 未校验**：`policySchema.omit({id}).partial().strict().safeParse`，失败 400 invalid_argument。
  - **[MAJOR] 种子引导每请求重写/复活种子/重置 admin 角色**：seed.ts 幂等语义修正（get 不存在才 write；resolvePrincipal 无角色才 bind）+ isolate 级 Promise once-guard（失败置回 null 可重试；导出 resetSeedGuardForTests）。
  - **[MAJOR] List 契约不符 §0.2/§6.2**：PolicyStore.list 接受 ListOptions（filter.subject、limit 默认 50/钳 200、非法 filter 键 400），返回 Page `{items}`（cursor 省略，doc-gap #22）；audit List 同步 `{items:[]}`；CLI policyList 发 `{opts:{filter:{subject}}}` 读 items；**跨界错配主 assistant 收口**：cli/audit.ts 由 records/cursor 改读 items（原 mock 掩盖了错配）。
  - **[MAJOR] 无 onError/notFound 兜底**：未知路径 404 + 裸 WattError not_found；§11.3a 规范树占位（platform/{agent,task,scheduler,event}、tools、context）显式路由 501 unavailable——**偏离评审建议**：占位路由注册在认证中间件之前而非用 notFound 判前缀，否则 501 会被 401 先拦（501 优先于 401）；onError → 500 internal（retryable:true，不泄漏细节，HTTPException 走原响应）。
  - **[MAJOR] device_code 非一次性**：DeviceGrantStore.delete 双 key，signUserToken 成功后消费（失败路径保留重试）；KV best-effort 注释留痕；重放 → 400 invalid_grant 测试锁定。
  - **[MAJOR] approved-但-过期无测试**：core 锁死"过期优先于 approved"判定次序（实现本就正确）+ gateway 直写过期 grant → 400 expired_token。
  - **[MAJOR] login --json 拿不到授权码**：LoginDeps.onDeviceAuthorized 回调，--json 下输出 user_code JSON 行（NDJSON 形态测试锁定），非 json 不变。
  - **[MINOR] ×4**：user_code 归一化下沉 core `normalizeUserCode`（RFC 8628 §6.1）；unknown tool 先 TOOL_ACTIONS 表校验再鉴权（read-only 得 400 非 403）；sign-admin-token 强制 `--rotate` 确认 + JWKS 传播轮询（比对公钥 x，60s 超时不出 token；base 用 WATT_JWKS_BASE_URL 缺省 workers.dev 避开 DNS 污染）；§11.3a ~help/~skill 走文档声明路线（DOD Phase 1 已知跳过清单 + doc-gaps #21）。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**181 tests**：shared 6 + core 95 + cli 33 + gateway 47；core 覆盖率 100% 保持）；`pnpm deploy:all` exit 0（migrations 步骤生效"No migrations to apply"幂等）；线上契约全查：未知路径 404 not_found 裸 WattError / 规范树 501 unavailable / 无 token 401；`sign-admin-token` 无 --rotate → exit 1 拒绝，--rotate → 轮换+传播确认+签发成功；**DoD 项 3 全链关门重跑**：`login --json` 首行授权码 JSON → 小写 user_code approve 成功（归一化线上验证）→ credentials 0600 → 凭据 whoami `user:djj`+admin；DoD 项 1/2 由 verify 中 core 单测覆盖重跑。注意：部署后首批 curl 命中旧 isolate（边缘传播窗口），重测后全部符合契约。
- 勾选：无新增（Phase 1 三项此前已勾；本轮为关门质量修复）→ **Phase 1 正式关门**。
- 沉淀：DOD.md Phase 1 增"已知跳过清单"（KV 判定缓存/agent token 数据面/~help·~skill 延后/cursor 分页）；doc-gaps 新增 #21/#22；llmdoc recorder/reflector 收录本轮（current-state 翻页、toolchain-pitfalls 新坑、reflections）。
- 遗留：device_code 一次性消费在 KV 上是 best-effort（并发双换取窄窗），严格原子需 DO/D1（代码注释留痕，量级需要时再收紧）；deploy-all migrations 步骤硬编码 watt-policies 单库，Phase 2+ 新库带 migrations 时须同步扩展（注释已标）；CLI `policy list --json` 输出裸数组而 `audit list --json` 输出 `{items}`，展示层形状不一致（非契约问题，顺手可统一）。

## Round 6 — 2026-07-02
- 目标：Phase 1 / DoD 项 3 CLI 半程 + 集成验收
- 动作：worker 落地——先由主 assistant 把 device flow 规范空白补进 Proto §6.5d（RFC 8628 最小子集），然后：core `device-flow.ts` 纯逻辑（grant 状态机/token exchange，17 新测试）；gateway `/oauth/device/{authorize,approve}` + `/oauth/token`（存储决策：KV_TENANTS + expirationTtl 双索引，无新 migration；OAuth 端点走 RFC 裸形状豁免 WattError，approve 是平台管理动作仍走 WattError）；CLI 四命令族 login（轮询+--approve）/whoami/policy list|add|rm/audit list（token 顺序 WATT_TOKEN > ~/.watt/credentials.json，0600）；`scripts/sign-admin-token.mjs`（轮换密钥+同进程签 token 解鸡生蛋，私钥不落盘）。
- 验证（主 assistant 独立复跑全链）：`pnpm verify` exit 0（159 tests：shared 6 + core 91 + cli 29 + gateway 33；core 100% 覆盖保持）；真实环境：无 token whoami → 401；`sign-admin-token` → admin whoami `{"principal":"user:djj","roles":["admin"]}`；device flow 全链（login 后台轮询 → approve TZR9KPQD → credentials 0600 落盘 → whoami admin → policy list 见 seed-admin-allow-all → audit list 空结构）全部 exit 0。
- 勾选：Phase 1 项 3 → **Phase 1 三项全勾**。
- 沉淀：待 recorder——sign-admin-token 模式（子进程 stdout 导 stderr 保 $() 纯净）、secret 轮换 ~15s 传播窗、CLI 未认证语义分层（本地无 token exit 2 / 服务端 401 exit 1）、OAuth/WattError 双契约边界。
- 遗留：Phase 1 关门待做；`wrangler deploy` 不自动跑 D1 migrations（后续加表注意）；.env 的 WATT_BASE_URL 仍指向 DNS 污染域名（workaround 沿用）。

## Round 5 — 2026-07-02
- 目标：Phase 1 / DoD 项 3 服务端半程（JWT + PolicyStore + Authorizer 接线 + 种子引导 + Platform API 路由）
- 动作：worker 落地——core：jose Ed25519 JWT 纯逻辑（sign/verify/JWKS，密钥注入，13 新测试）；gateway：D1 migrations（policies + identity_mappings，wrangler 原生机制挂 watt-policies）、PolicyStore 四动词 + Delete、IdentityMapper.ResolvePrincipal、种子引导幂等、认证中间件（401 裸 WattError）+ WattError↔HTTP 中间件、路由 `/.well-known/jwks.json`（公开）+ `/htbp/platform/{whoami,policy,audit}`（**宪法优先偏离任务提示**：任务写 /v1/*，Proto §11.3a 规范是 /htbp/platform/*，worker 正确按 Proto 实现）。私钥内存生成→管道进 wrangler secret（不落盘）；本地测试用独立 fixture 密钥经 miniflare.bindings 注入。KV 判定缓存跳过（注释声明）。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（113 tests：shared 6 + cli 10 + core 74 + gateway 23；core 覆盖 100%×4）；线上：JWKS 200 仅公钥（无 "d" 字段）、无 token whoami → 401 裸 `{"code":"permission_denied",...}`、healthz 200 回归。
- 勾选：无（项 3 需 CLI 半程后整体验收）。
- 沉淀：新坑待入 guide——块注释内 `*/` 字面导致 oxc PARSE_ERROR 且报错误导；vitest-pool-workers D1 migrations 接线法（readD1Migrations→miniflare.bindings→applyD1Migrations）；provision 加 per-binding 字段须同步 bindingsBlock 生成逻辑。
- 遗留：device flow Proto 未定义（doc-gap #10），CLI 轮需决策；agent token 数据面（步骤 2/3 的 agentDefs/instances）留 Phase 4/5。

## Round 4 — 2026-07-02
- 目标：Phase 1 / DoD 项 1（§6.4c 判定算法单测矩阵）+ 项 2（Event 信封单测）
- 动作：worker 新建 `packages/core`（@watt/core，平台核心纯逻辑；shared 保持轻量类型）——zod 类型层（Event/CallContext/Policy/AgentDefinition/CronJob 最小面）、`authorize()` 四步判定（§6.4c 2026-07-02 修订版：步骤 2 跳过判据 §6.5b、cron script 取 grants / agent·publish 不追加上限 / 禁用→deny）、Decision 带 reason 链（为 AuditLog 铺垫）、Event 信封（131072 字节上限、normalizeEvent 不覆写已有 principal、DedupeStore 接口 + 内存实现 24h 默认窗可注入）。test-first：先 4 文件全红（模块不存在）→ 实现 → 61 tests 绿；覆盖率门禁真实红过两次后补例到 100%。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（shared 6 + cli 10 + core 61 + gateway 2 = 79 tests）；core 覆盖率 Statements/Branches/Functions/Lines 全 100%（门禁挂 verify）。
- 勾选：Phase 1 项 1、项 2。
- 沉淀：doc-gaps 新增 #18（dedupe 窗口口径 5min vs 24h）、#19（principal 补齐不覆写语义待 Docs 定夺）、#20（实例→def 反查接口 Proto 缺失，Phase 4 前收口）；coverage/biome 新坑待并入 toolchain-pitfalls（`coverage/` 产物被 biome 误抓爆 144 错；`pnpm --filter X test -- --coverage` 不透传）。
- 遗留：Phase 1 项 3（集成链路）是下一轮唯一目标，依赖较重（jose JWT + D1 PolicyStore + 种子引导 + CLI login/whoami/policy/audit 四命令），可能需要拆两轮：先服务端（JWT+Store+路由）再 CLI。

## Round 3 — 2026-07-02（Phase 0 关门轮）
- 目标：Phase 0 关门——重跑全部 DoD + 质量关口 Workflow + 修复确认项
- 动作：
  - 重跑全部 5 项 DoD 命令：全部 PASS（verify / deploy:all / healthz 200 / watt status --json / 五类资源 list 可见）。
  - 质量关口 Workflow（5 维 review → 对抗核查，12 agents）：确认 7 条 MAJOR（+1 条评审期间已先行解决的 501 码问题），全部修复：① 错误体改裸 WattError（Proto §11.3，删信封）；② retryable 测试去自引用（oracle 硬编码自 Proto §0.2）；③ provision `d1 info` 失败回退读 wrangler.jsonc 旧 id，不再静默删绑定；④ list 失败 fail-fast + create "already exists" 视为幂等成功；⑤⑥ deploy-all 读 .env 注入凭据 + 编排 provision（`--skip-provision` 可跳）；⑦ gen-dev-vars 改白名单（Phase 0 空），CLOUDFLARE_* 永不进 Worker env。
  - 修 Docs（宪法优先）：Proto §0.2 增补「未认证 401→permission_denied」「未实现 501→unavailable」两条规范性补充；§6.4c 步骤 2 错引 "见 e"→"见 §6.5b"；步骤 3 明确 cron 非 script 动作不追加上限；Architecture 附B 更新为 watt- 前缀实名 + 命名约定说明。doc-gaps #1/#2/#6/#7/#17 全部闭环。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（18 tests）；`pnpm provision` 重跑 → 全 [exists] 且 wrangler.jsonc MD5 前后一致（字节级幂等）；`env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID pnpm deploy:all` → exit 0（自读 .env）；线上 inbound → 裸 `{"code":"unavailable",...}`；healthz 200；`watt status --json` exit 0；.dev.vars 无 CLOUDFLARE_*。
- 勾选：无新增（Phase 0 五项此前已勾；本轮为关门质量修复）
- 沉淀：Phase 1 前置调研报告已产出（phase1-auth-event-spec.md，含 §6.4c 用例矩阵与 5 个实现决策点）；待 recorder 收录 Round 3 知识
- 遗留：质量关口的 MINOR 项（~20 条：KV id 校验、substring 匹配、watt status ok:false 退出码、cli 测试 env 泄漏等）不阻塞关门，记入 backlog 随后续 Phase 顺手修

## Round 2 — 2026-07-02
- 目标：Phase 0 / 「附B 资源已由脚本创建并绑定」（项 5），顺带闭环项 2/3/4
- 动作：worker 写 `scripts/provision.mjs`（幂等：list 判存在→create→回填 wrangler.jsonc marker 段），真实创建 D1×4（watt-policies/providers/audit/events）、KV×2（authz-cache/tenants）、R2×2（context-objects/artifacts）、Queue watt-events（producer 绑定）、Vectorize watt-context-index（1024 维 bge-m3，cosine）。主 assistant 补：`routes` custom domain watt.pdjjq.org + 显式 `workers_dev: true`（配 routes 后 wrangler 默认关 workers.dev，曾致 404）；smoke.ts 加 5 次重试（新部署边缘传播窗口首击可 500/1104）。
- 验证（主 assistant 亲自跑）：
  - `wrangler d1/kv/r2/queues/vectorize list` → watt-* 资源全部可见
  - `pnpm deploy:all` → exit 0（10 绑定，双 URL）
  - `curl workers.dev/healthz` → 200 `{"ok":true,"version":"0.1.0","service":"watt-gateway"}`；custom domain 经 DoH → 200（本机 ISP DNS 污染 watt.pdjjq.org 解析到假 IP，TLS reset——非平台问题）
  - `watt status` / `--json` → exit 0、JSON 可解析
  - `node scripts/smoke.ts`（workers.dev）→ OK；`pnpm verify` → exit 0（回归绿）
- 勾选：Phase 0 项 2、3、4、5（项 1 上轮已勾）→ **Phase 0 五项全勾**
- 沉淀：待做——CF token 细粒度写权限坑（whoami 通过≠可 create，D1/Vectorize 曾 code 10000 需补权限）、wrangler --json banner 污染、JSONC 注入 CommaExpected、workers_dev 默认关闭坑、本机 DNS 污染 workaround 需进 guide；doc-gaps #1/#2 已核实/回写（Flue 勘误 Reference.md 原文已含、DOD §9 补凭据验证判据）
- 遗留：Phase 0 关门待做（质量关口 review + /llmdoc:update）；Queue consumer 绑定留 Phase 2；资源名带 watt- 前缀与附B 原文（无前缀）的偏差可在关门时回写附B

## Round 1 — 2026-07-02
- 目标：Phase 0 / 「`pnpm verify` 本地绿（哪怕只有 1 个占位测试）」
- 动作：派 llmdoc:worker 搭建 monorepo 骨架——pnpm workspaces + `packages/shared`（WattError 7 码）+ `packages/gateway`（Hono：`GET /healthz`、`POST /channels/:id/inbound` 501 占位；wrangler.jsonc 附B 绑定注释占位）+ `packages/cli`（commander，`watt status` + 全局 `--json`）+ `scripts/`（gen-dev-vars / deploy-all 雏形 / smoke 雏形）。选型：Biome lint、Vitest 4 + @cloudflare/vitest-pool-workers 0.18（真实 workerd）、wrangler 固定 4.107.0（对齐 pool-workers 捆绑版本）。
- 验证：主 assistant 亲自重跑 `pnpm verify` → exit 0（typecheck 3 包 Done；biome 25 files 0 error；tests：shared 7 + cli 10 + gateway 2 = 19 passed，gateway 跑在真实 workerd）。
- 勾选：Phase 0 项 1。
- 沉淀：recorder 更新 current-state + 新 guide（工具链坑：npmmirror、pnpm allowBuilds、vitest-pool-workers 新 API、tsc noEmit 方案）；reflector 记 reflection；doc-gap 新增「inbound 占位 501/unimplemented 属规范外扩展码」。
- 遗留：deploy:all/smoke 仅雏形未跑通；wrangler.jsonc 无真实绑定（资源未创建）。下一轮建议先做资源创建（DoD 项 5），因为项 2/3/4 的部署都依赖绑定存在。
