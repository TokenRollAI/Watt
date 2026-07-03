# 文档缺口清单（doc-gaps）

> 归并自 bootstrap 阶段五份调查报告（`.llmdoc-tmp/investigations/`）。优先级：P1 = 应修 Docs（影响执行正确性/会踩坑）；P2 = 应修 Docs（一致性/完整性）；P3 = 记录即可（已知留白/实现自由/非 MVP）。处理后请更新状态列。

## P1 — 需修 Docs（易踩坑）

| # | 缺口 | 位置 | 处置 | 状态 |
|---|---|---|---|---|
| 1 | **Flue 归属勘误**：早期讨论误将 Flue 归为 TokenRollAI，实为 `withastro/flue`；`TokenRollAI/flue` 不存在 | Docs/Reference.md | **已核实无需回写**：Reference.md §1 已含勘误声明（"早期讨论曾误将 flue 归于 TokenRollAI…本文以 withastro/flue 为准"）；LOOP/DOD/Architecture 等仅提 "Flue" 名称、无错误归属。决策记录 [decisions/flue-attribution.md](decisions/flue-attribution.md) | ✅ 已解决（2026-07-02 Round 1 间隙核实） |
| 2 | **Cloudflare 凭据验证判据**：token 为 Account-scoped，`/user/tokens/verify` 会误报 Invalid，脚本用它作健康检查会误判凭据失效阻塞 Phase 0 | DOD.md §9 | **已回写**：DOD §9 已知外部前置补一行"凭据验证判据"。同时在 must/current-state.md 有记录 | ✅ 已回写（2026-07-02） |

## P2 — 需修 Docs（一致性/完整性）

| # | 缺口 | 位置 | 处置 | 状态 |
|---|---|---|---|---|
| 3 | Architecture §0 概览表 M10 落地只写 "Pages + Agent 实例"，遗漏第三入口 Watt CLI（正文与附B 均有） | Docs/Architecture.md §0 | 需修 Docs：§0 表补 CLI 或加注"见 M10 正文" | 待回写 |
| 4 | M10 命令表自称"节选"，无完整 CLI 命令真源；DOD 靠各 Phase 分散验收。核对策略：M10 命令族为上界、DOD 为下界 | Docs/Architecture.md M10 | 需修 Docs：补一份完整 `watt` 命令↔Proto 接口映射表 | 待回写 |
| 5 | Reference.md 未覆盖 4 个实现层 npm 依赖（`@larksuiteoapi/node-sdk`/`jose`/`Hono`/`zod`）的落点定义 | Docs（实现层文档） | 需修 Docs（实现层补齐；Reference 可不改）。当前落点已记 reference/external-facts.md | 待回写 |
| 6 | **Proto §6.4c 步骤 2 交叉引用错位**：正文写"见 e"，但 §6.4 只有 a–d；纯人类判定实际在 §6.5b | Docs/Proto.md §6.4c | 需修 Docs：改引用为 §6.5b | ✅ 已回写（2026-07-02：§6.4c 步骤 2 改"见 §6.5b"） |
| 7 | **cron grants 疑似矛盾**：`CronJob.action` 仅 `script` 分支有 `grants`，但 §6.4c 步骤 3 要求系统段 `cron:<jobId>` 取 `action.grants` 作上限——`kind:'agent'`/`'publish'` 的 job 缺省行为（空集 deny？不追加段？）未定义 | Docs/Proto.md §6.4c / §7 | 需修 Docs：明确非 script 动作的系统段规则 | ✅ 已回写（2026-07-02：§6.4c 步骤 3 明确 script 取 grants、agent/publish 不追加上限、禁用/删除→deny） |
| 17 | **inbound 占位错误码超出 WattError 7 码**（Round 1，需决策）：gateway 占位曾返回 501 + 规范外 code `unimplemented` | Docs/Proto.md §0.2 / packages/gateway | 已决策：7 码不扩容；Proto §0.2 增补"未认证 401→permission_denied""未实现 501→unavailable"两条规范性补充；实现与测试同步改为 `unavailable`，verify 绿 + 部署后 curl 验证 501/unavailable | ✅ 已解决（2026-07-02） |

## P3 — 仅记录（已知留白/实现自由/非 MVP）

| # | 缺口 | 处置 |
|---|---|---|
| 8 | `E2E_FEISHU_ADMIN_OPEN_ID`/`E2E_FEISHU_EMPLOYEE_OPEN_ID` 空——E2E-4 已明确降级为 API 模拟身份，真实双账号后补 | 仅记录（已接受，不阻塞） |
| 18 | **Event dedupe 时间窗口径不一**（Round 4）：phase1 调研报告建议 5min，实现取 24h（`packages/core/src/event/dedupe.ts`，可注入参数，注释已声明理由：覆盖渠道重投最坏窗）。回写 Docs 时统一口径为 24h 默认 | 待回写 Proto §1（低优先，实现已自声明） |
| 19 | **Event principal 补齐语义**（Round 4）：Proto 未明确平台补齐 principal 时是否覆盖调用方显式传入值。实现选「已有 principal 不覆写，仅缺省且有 channelUser+resolver 时补齐」（`normalizeEvent`）。需 Docs 定夺 | 待回写 Proto §1 |
| 20 | **链段实例→def 解析接口缺失**（Round 4）：§6.4c 步骤 3「实例 ID 段取其 agent_def.grants」，但 Proto 未定义由实例 ID 反查 agent_def 的接口（claims 只带当前段）。实现以注入 `instances: Record<instanceId, defName>` map 建模；真实取数应来自 AgentRuntime 实例目录（Phase 4 落地时定） | 待回写 Proto §3/§6（Phase 4 前须收口） |
| 9 | `OPENAI_API_KEY` 与 `ANTHROPIC_API_KEY` 同 key 复用——E2E-5"新渠道"语义可能不足，待 Phase 6 确认 | 仅记录 |
| 10 | 非交互 CI 如何拿 CLI token（device flow 需人工） | ✅ 已解决（2026-07-02 Round 6：Proto §6.5d 规范性补充——device flow 三端点 + 非交互用 `WATT_TOKEN` env（sign-admin-token.mjs 离线签发），实现与集成验收已通过） |
| 11 | `ExpectSpec.schema` 重试次数 N 无默认上下限（Proto §3.2）；`ExpectSpec.timeoutMs` 缺省值与 Workflows 24h 默认/365 天上限关系未收口（§3.4）；Event `dedupeKey` 去重时间窗无基线（§1/§2.3） | **实现已声明，待回写 Proto §3.4**：schema 重试 maxAttempts=3 已在 #28④ 声明；checkpoint waitForEvent 超时实现声明 **human 10min / agent 5min**（`watt-task-workflow.ts`，显式短超时避开 24h 默认挂起，Round 20 收口）；dedupeKey 时间窗见 #18（24h） |
| 12 | `PrincipalRef` 与 `agent:` 前缀边界含糊（§0.3：`agent:<def>` 可作 principal 时与 `agent` 链字段语义重叠未澄清） | 仅记录 |
| 13 | external harness 走 MCP 的传输绑定半缺口（§3.1 `protocol:'mcp'` vs §11.3/§11.4 未展开 agent-harness 的 MCP 细节） | 仅记录 |
| 14 | `TaskDefinition`/`checkpoints` 声明来源未定义（checkpoint 名由部署的 Workflows 代码定义，属"代码部署产物"边界外，可能有意留白） | ✅ 已解决（2026-07-03 Round 20/21）：checkpoints 由**部署模板代码声明**——`DEPLOYED_TEMPLATES` in `watt-task-workflow.ts`，ListDefinitions kind='deployed' 返回（实现声明+测试锁定），符合"代码部署产物"边界 |
| 15 | `AgentRuntime.Interrupt` 标注为非 MVP（Dashboard 干预预留，六 Case 不依赖）——实现优先级可缓 | 仅记录 |
| 16 | Proto §8.1 动态编排全节为非规范性预留（additive-only）——后续若见相关代码应视为超前实现 | 仅记录 |
| 21 | **HTBP 节点 `~help`/`~skill` 延后**（Phase 1 关门，2026-07-02）：Proto §11.3a 要求每个 HTBP 节点响应 `GET ~help`/`~skill`，Phase 1 的 platform 子树未实现。已决策统一延后：platform 子树最小 ~help 随 Phase 3 Help DSL parser 落地；通用 ~help 生成归上游 tool-bridge（Phase 4，见 loop-contract §2.1 上游通道）。未知路径当前由 gateway notFound 兜底返回 404/501 裸 WattError | 仅记录（有意延后，已入 PROGRESS 关门记录） |
| 22 | **Page<T> cursor 分页延后**（Phase 1 关门，2026-07-02）：§0.2 Page<T> 含可选 cursor；Phase 1 PolicyStore.List 返回 `{items}` 省略 cursor（limit 默认 50、上限 200 已按 §6.2 实现），cursor 分页留待数据量需要时的后续 Phase 补 | 仅记录（cursor 为可选字段，省略不违反契约） |
| 23 | **instanceBy='session' 但 event.session 缺失行为未定义**（Round 8）：Proto §2.3 未定义该组合。实现取显式 `invalid_argument` 错误、不静默 fallback（`packages/core/src/eventbus/instance-key.ts` 注释声明理由），由订阅建立时保证 session 存在。另两项实现声明：type 通配 `"*"` 全通配合法；`"im.*"` 前缀含点故不匹配裸 `"im"` | 待回写 Proto §2.3（低优先，实现已自声明+测试锁定） |
| 24 | **occurredAt 的 §2.3 Omit vs §2.1 Decode 义务矛盾**（Round 10 关门）：§2.3 Publish 参数为 `Omit<Event,'id'\|'traceId'\|'occurredAt'>`（类型上不含 occurredAt），但 §2.1 Decode 义务字段又要求填 occurredAt（渠道侧发生时刻）。已按"调用方已提供则保留、缺省才补接收时刻"实现（core normalizeEvent），并在 Proto §2.3 加规范性澄清（2026-07-03） | ✅ 已回写 Proto §2.3 |
| 25 | **Phase 2 实现声明簇**（Round 10 关门，均已代码注释声明+测试锁定）：① Platform API Publish 无条件规约 `source.kind='webhook'`（Phase 2 无 agent token 豁免面；Phase 4 引入 claims.agent 后由 claims 区分）；② §1.1 system subscriber 的 outbound.message 投递不走出站 Check（系统行为非 Agent 出站）；③ im.action→Signal 桩的权限校验点 Check(task://,'signal') 留 Phase 5 与 TaskManager 一并落地（**已落地**：2026-07-03 Round 20，consumer 换真实 TaskSignaler + Check(task://,'signal')，principal 从 event.principal 取、缺省拒绝）；④ DLQ 命名 `watt-events-dlq`（仅队列存在，consumer/重放工具留 Phase 6 可观测轮）；⑤ webhook adapter session 形状 `webhook:<channelId>:<channelId>`（scope 退化，与 §1 `<channel>:<scope>:<id>` 的对齐留 doc 漂移候选）；⑥ publish 的 queue.send 失败补偿为 best-effort 删留痕（删失败留 console.error，严格原子需 DO/事务）；⑦ im.bot_joined payload 形状 §1.1 未定义，实现按 `{channel:string}` 建模 | 仅记录（Phase 4/5/6 对应项到期收口） |
| 26 | **Phase 3 core context 实现声明簇**（Round 11，均代码注释+测试锁定）：① TTL 边界含等（`nowMs >= expiresMs` 即回收）；② URI 解析：`context://ns` 与尾斜杠均 path=""，空 ns / 非 context scheme → invalid_argument；③ 最长前缀匹配按段边界（`feedback/bugs` 不误配 `feedback/bugsy`）；④ applyPatch：显式 `content:undefined` 视同未提供（允许替换为空串）；⑤ 携带 ifVersion 但条目不存在 → conflict（not_found 由 requireExisting 单独负责）；⑥ ~help 每 cmd 行仅附 `scope <read\|write>` 属性行（q/h/body/returns 等可选项 Round A 未输出） | 仅记录（Proto §4 未明确处的实现取舍） |
| 27 | **Phase 3 关门实现声明簇**（Round 13，均代码注释+测试锁定）：① vector provider = D1 sidecar 架构（权威数据在 DB_CONTEXT entries 表与 structured 同表、以 mounts 唯一键防 namespace 撞名；Vectorize 只存 embedding+引用）；② unmount（Registry.Delete）只卸载不清 provider 数据、TTL 过期才物理清理（§4.2 "到期整个 namespace 回收"语义按此实现，清理 best-effort）；③ ~help 免认证（§11.3a 渐进发现精神，规范未定 ~help 鉴权层级）；④ readOnly mount 写动词拒绝码 = 403 permission_denied；⑤ 并发窗口残余声明：R2 onlyIf 收窄到 put 调用内、head-put 间仍非严格原子；vector 的 Vectorize upsert 与 D1 写非原子（D1 为准，孤儿向量由 namespace filter 掩蔽）；⑥ 成功响应信封：消费面 Get→{entry}、Write/Update→{meta}、List→裸 Page；管理面 Write→{mount}——形状由 gateway 测试锁定，CLI 精确解包（漂移曾三次致线上 bug）；⑦ ~skill 端点仍缺（#21 范围，随 tool-bridge Phase 4） | 仅记录（Phase 4+ 到期收口；⑥ 建议某轮统一信封并回写 Proto §11.3a） |
| 28 | **Phase 4 实现声明簇**（Round 14~18，均代码注释+测试锁定）：① harness 由 model 声明推导（AgentRegistry entry.className 恒 AgentInstance，echo/llm 分派看 model）；② correlation 宿主 = 独立 DO `AGENT_CORRELATION`（AgentCorrelation），代发/回送**直投 waiter**（绕开 routeResult 去重自吞，见 toolchain-pitfalls §39）+ settled 三态（pending/delivering/settled，投递成功才 settle）；③ ToolRegistry/AgentRegistry/ModelProvider 均挂 watt-providers 库（migrations-providers 0001~0003）；④ ExpectSpec.schema 校验 = JSON Schema **五关键字子集**（type/properties/required/items/enum，声明子集范围），重试 **maxAttempts=3** → invalid_output（收口 #11 的实现自由声明）；⑤ 模型调用超时 60s（AbortSignal.timeout）；⑥ terminated 实例行 **TERMINATED_TTL 7d** sweep；⑦ HTBP tools call 请求形状契约：工具名走 URL end-path、body 是 `{arguments}` 信封，代理按 provider 归一化（http 拆信封/mcp·builtin 透传，见 toolchain-pitfalls §38）——建议回写 Proto §5/§11；⑧ ModelProvider resolveDefault 尚未接 harness（死代码，backlog）；⑨ Architecture M4 树宿主边界矛盾**已回写**（commit 22960b2：逻辑单一入口、物理分治——gateway 自持 platform/context，tool-bridge 承载 tools，gateway 代理层做 Check PEP） | 仅记录（⑦ 为 Docs 回写候选；⑧ Phase 5+ 顺手接；⑨ 已解决） |
| 29 | **Phase 5 实现声明簇**（Round 19~21，均代码注释+测试锁定）：① **taskId 即 Workflows instanceId**（Write 时 `WATT_TASK.create({id:taskId})`，Signal/Cancel 经 get(taskId) 直取，免映射表——决策 [decisions/task-workflow-instance-id.md](decisions/task-workflow-instance-id.md)）；② checkpoint waitForEvent 超时 **human 10min / agent 5min**（`watt-task-workflow.ts`，收口 #11），超时按平台代发 failed 语义处理；③ TaskStore 挂 **watt-events** 库（migrations-events/0002，归属理由见 migration 头注释：Task 生命周期与 Event Gateway 紧耦合、providers 是静态定义簇、避免单表新库）；④ **disabled cron job 仍可手动 Trigger**（补跑/调试面；§7 未限，enabled 只关到点自动触发）；⑤ **publish action 亦发 cron.completed**（§7 只要求 script/agent 必发；统一三 action 留痕面）；⑥ script 能力表**最小面 = watt.publish**，每次调用过 platform://event 'manage' Check（cron 链段，上限=job.action.grants——决策 [decisions/scheduler-script-runner.md](decisions/scheduler-script-runner.md)）；⑦ script 的 watt binding 经 **RPC 调用参数**注入而非 loader env（env 字段 structured clone 连 RpcTarget 也拒收，toolchain-pitfalls §44）；⑧ Scheduler Write **不做 grants≤createdBy 静态校验**（§7 推迟运行时判定，运行时每次 Check 兜底） | 仅记录（②为 Proto §3.4 回写候选；后续 Phase 到期收口） |

## 报告事实漂移订正（勿改 Docs）

- `FEISHU_ENCRYPT_KEY`：delivery 报告曾记"空"，followup 复查 `.env` 为非空。以当前 `.env` 为准。
