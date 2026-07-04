# PROGRESS（loop 自维护进度账本）

> 真源：[DOD.md](DOD.md)（验收标准）、[LOOP.md](LOOP.md)（执行契约）。本文记录当前 Phase、已勾选项、每轮证据与遗留。

## 当前状态

- **当前 Phase**：**Phase 0~7 全部关门 + R33 可用性冲刺完成**（飞书 plugin 化 / HTBP 工具注入 / SecretStore / CLI npm 化 / watt init 向导 / dashboard 配置页 / lurker LLM 化）
- **已勾选**：Phase 0~7 全部；**Phase 6 ② @feishu 入站真实群消息已采证**（R33：webhook plugin 主路径，真实群 @watt 收到回复，用户截图 + events/audit 双留痕）
- **Blocker**：无。飞书后台需保持"事件发送至开发者服务器"=`https://watt-feishu.pdjjq.org/webhook/event`（workers.dev 境内被干扰不可用）；群上下文累积需飞书应用加 `接收群聊中所有消息` 权限（当前仅 @ 消息可达）
- **下一目标**：npm 真实发布（`pnpm release:cli`，需 @tokenroll org 权限人工确认）；`watt init` 真实账户全程验证（交互式 TUI，建议前缀 watt-init-test）；R33 MINOR backlog（~~httpbin 上游不稳→换可靠桩工具~~ R34 已换 httpbingo、admin token 1h 短命 + 轮换连坐 pluginToken 的运维摩擦）；R34 遗留：真人群内 @watt 验证入站新 pluginToken

## 上游改动记录（tool-bridge 等）

- 2026-07-03（Round 15）`TokenRollAI/tool-bridge` 分支 `feat/watt-builtin-and-tool-semantics`（56ab13b,已 push 未开 PR/未合 main）：① ToolSpec/help 增可选 effect/scope/confirm 语义字段（§5.1/§6.4d 数据源,向后兼容）;② NodeKind 增 builtin + `src/worker/tb/adapters/builtin.ts`（handler 宿主注入模式,内置 echo）。该仓库全部测试绿。Watt 侧消费方式与部署拓扑见 Round 15/16 记录。

---

# 轮次记录

## Round 36 — 2026-07-04（Dashboard 全量重构：RR7 + shadcn 控制台 + CLI 全功能对齐 + Manage 对话）

- 目标：重构 dashboard 为 Cloudflare 友好的现代前端——界面美观 + 功能与 CLI 对齐（含 manage 对话）。
- 动作：
  - **骨架（主 assistant）**：packages/dashboard 原地重建为 React Router 7 framework mode SPA（`ssr:false`，产物仍落 dist/ → gateway assets 同域托管管道零改动）+ Tailwind v4 + shadcn/ui（23 组件，`app/components/ui` 视为 vendored 不 lint）；「电力控制台」主题（暗色优先/炭黑+琥珀/IBM Plex）；16 路由 + Sidebar 五组导航 + 登录页（Root Key 换发/token 粘贴，whoami 验证后放行）+ clientLoader 认证门卫；api 层拆 core/types/platform + domain 文件（barrel export *）。
  - **五视图族并行（5 worker，文件集互斥）**：A=Overview 4 stat 卡+Audit/Events 摘要、Metrics 查询（8 指标+范围+CSS 条形）、Audit 过滤、Events tail 轮询+详情+subs；B=Agents 定义/实例双 Tab+Spawn/Send/Terminate+派生树、**Manage 对话页**（Spawn 建会话→Send{expect}→1.5s 轮询 event List{correlationId} 取 agent.result/failed，70s 兜底，sessionStorage 会话恢复）；C=Tasks 七态+Run/Signal/Cancel、Cron 三型 action（publish/agent/script）+Trigger、Policies+MapIdentity；D=Context/Tools 双栏浏览器（管理面+消费面，call=end-path+{arguments} 信封）；E=Secrets/Channels/Providers/Plugins（通用注册，pluginToken 仅展示一次）/Settings。
  - **gateway 唯一后端改动**：EventStore.List filter 增 `correlationId`（json_extract payload）——Proto §2.4 先行增补（写明动机），+2 测试。manage 对话「零后端改动可跑通但前端筛会漏」由此收口为一等查询路径。
  - **团队级修复（主 assistant）**：.gitignore Python 模板 `lib/` 收窄为 `/lib/`（曾静默吞掉 app/lib 整个 api 层）；platform.ts registerPlugin 形状错误删除（真源 {registration:{...,pluginToken}}，E 在 config.ts 以双证重实现）；biome 配 tailwindDirectives + build/.react-router 排除。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**1292 tests**：shared 6 + dashboard 71 + core 411 + plugin-feishu 47 + gateway 582+1skip + cli 175）；`pnpm build:deploy` RR7 产物正确落 packages/cli/deploy/dashboard/（模板改写逻辑零调整）；`pnpm deploy:all` exit 0；**线上浏览器实测**（chrome-devtools MCP，workers.dev）：14 视图逐页导航全部渲染无 ErrorBoundary、console 零 error；Manage 对话真实跑通（@llm：spawn manage/cron → 「列出当前所有定时任务」→ 模型经 scheduler_list 工具回复「列表为空」，轮询链路+气泡渲染全 OK）；截图证据 .llmdoc-tmp/screens/{overview,agents,manage-chat}.png。
- 勾选：无新增 DoD（维护/可用性迭代轮）；M10 Dashboard 从「5 只读视图+3 配置视图」升级为「16 视图全 CRUD + manage 对话」，与 CLI 十六命令族对齐（init/login/channel connect 三个纯本地命令除外，属预期）。
- 沉淀：llmdoc 更新（current-state dashboard 段 + modules-and-flows M10 + 新决策 dashboard-rr7-stack + pitfalls 增补）；旧 src/ 已删（api 契约测试 18 个迁移并扩展至 71 个）。
- 遗留：`/oauth/root/token` 不在 CORS 白名单（同域托管无碍，跨源 vite dev 时 Root 登录会被拦——开发期用 token 粘贴路径即可）；agent waiter 无 'none' 类（manage 对话每轮 self-waiter 回投多跑一次 LLM，投资回报低暂不做）;Spawn 带 expect 会触发 harness 空跑（view-b 实测发现，建会话已改为不带 expect 规避）。

## Round 35 — 2026-07-04（Root Key 持久引导凭据 + npm 发布/CI/CD + dashboard 单域化）
- 目标：用户三连需求——npm 真实发布 + GitHub CI/CD、dashboard 挂到"一个 domain"、Root Key（仅展示一次）解决登录引导。
- 动作：
  - **npm**：scope 定名 `@tokenroll/watt`（用户拥有 tokenroll org，disdjj=owner；token-roll 弃用）；首发 0.1.0 由用户交互完成（OTP）；`.github/workflows/{ci,release}.yml`（ci=pnpm verify；release=v* tag 触发，OIDC provenance/NPM_TOKEN 双兼容 + tag/版本一致性护栏）。
  - **dashboard 单域化**：Workers Static Assets 挂进 gateway（`assets` 配置 + run_worker_first API 白名单 + SPA fallback）——`watt.pdjjq.org/` = 控制台、`/htbp/*` = API，同源免 CORS 免 base 配置；deploy-all/init 去 Pages 步；根 verify 前置 dashboard build（assets 目录存在性要求）。旧 Pages 项目弃用。
  - **Root Key（Proto §6.5e 新增规范）**：`wrk_`+32B 高熵 key，平台只存 SHA-256 摘要（WATT_ROOT_KEY_HASH）；`POST /oauth/root/token` 换发 admin token（TTL 缺省 7d 钳 30d，成功/失败都写 platform://auth root-exchange 审计）；`scripts/set-root-key.mjs`（明文仅展示一次）+ `watt login --root`（stdin）+ dashboard Settings Root Key 登录 + init 向导集成（收尾仅展示一次，不入 answers 存档）。**与 JWT 轮换解耦——admin token 过期不再需要轮换私钥，pluginToken 连坐链自此消解**（R33/R34 遗留运维摩擦收口）。
  - sign-admin-token 增 `--ttl`；发现并修复：R35 期间的 setup feishu 重跑再次冲掉 R34 def 修复（pitfalls §63 实锤第二次）——已按 R34 终态恢复（toolScopes ['test'] + tool://test 两级 grants）。
- 验证：`pnpm verify` 全绿 **1238 passed / 1 skipped**（gateway 581+1skip 含 oauth-root 4 新测试）；线上：set-root-key → 换发 200 → whoami admin ✓；错误 key 401 invalid_grant ✓；`/` 出 dashboard SPA（workers.dev + custom domain 双 URL）✓；npm `@tokenroll/watt@0.1.0` 已发布（用户 OTP 完成）。
- 勾选：无（维护/可用性轮）。
- 沉淀：Proto §6.5e、llmdoc decision root-key-bootstrap、CI/CD workflows README。
- 遗留：Trusted Publisher 待用户在 npmjs 配置（或 NPM_TOKEN secret）；入站 webhook 新 pluginToken 仍待真人群消息验证（R34 遗留）；setup feishu 的 def Write merge 语义仍未实现（连续两轮踩 §63，优先级上调）。

## Round 34 — 2026-07-04（维护轮：飞书群 agent 工具链路修复——两关授权 + httpbin 桩）

- 目标：修复用户截图报障——真实飞书群 @watt 用工具取 uuid 失败（先「"test" 工具树 permission denied」，后「工具调用 503」）。
- 根因（investigator 报告 `.llmdoc-tmp/investigations/agent-htbp-test-tree-denied.md`，实测修正一处）：
  - **permission denied 是两层授权缺口**：① §6.4c 步骤 1——`agent:lurker/scribe` 主体对 `tool://test` 无任何 allow policy（全库唯一种子是 `role:admin→*→*`）；② 步骤 2——线上 def 的 `grants` 只有 `event://*` write，不含 tool://（报告推断 def 有 `tool://*` 有误，实测第一次修复后暴露 `agent definition grant exceeded`）。另发现线上 def `toolScopes` 已被某次 def 重写冲回 `[]`（运行中实例靠旧快照仍见 test）。
  - **503 = `test/echo` 树 `get-uuid` 指向 `https://httpbin.org/uuid`**（R33 遗留点名的不稳桩），toolbridge 兜成 500 回喂。
- 动作（全部为线上配置/种子数据修复，零代码改动）：admin token 过期→`sign-admin-token.mjs --rotate` 轮换（连坐 pluginToken→`watt plugin register channel-feishu` 重签 + 重 put `WATT_PLUGIN_TOKEN`，未跑完整 setup feishu 以免冲掉 def）；`watt policy add` ×2（`lurker-tool-test-root`/`lurker-tool-test-sub`：agent:lurker/scribe → tool://test 与 tool://test/*，read,invoke allow）；agent Write 恢复 def `toolScopes:["test"]` + grants 增补 `{resources:[tool://test,tool://test/*],actions:[read,invoke]}`；`watt tool mount test/echo` 换 `https://httpbingo.org/uuid`。
- 验证：`watt tool call test/echo get-uuid` → 200 真 uuid（admin 路径）；API 注入 `@watt 用工具取 uuid` 到真实群 session `feishu:chat:oc_9096...` → 第一次回复复现 grant exceeded（暴露第②层）→ 补 grants 后再注入 → **出站回答「（基于本群 1 条上下文）取到了，UUID 是：37174c0f-…」真实投递进飞书群**。@llm 本轮实耗 2 次（第一次为必要的中途修复复验，留痕声明）。
- 勾选：无（维护轮，DOD 无新增项；R33 遗留「httpbin 换可靠桩」就此收口）。
- 沉淀：/llmdoc:update（agent 工具访问两关授权模式 + def Write 整体覆盖会冲掉部署侧 toolScopes/grants 的运维坑）。
- 遗留：**入站 webhook 的新 pluginToken 未经真实飞书消息验证**（本轮注入走 admin Publish 旁路），需真人在群里 @watt 一条确认；`setup feishu`/`e2e-3` 的 def Write 仍会把部署侧 toolScopes/grants 冲回默认（建议后续给 setup 加 merge 语义或文档警示）；admin token 轮换连坐 pluginToken 的运维摩擦依旧（R33 遗留项不变）。

## Round 33 — 2026-07-04（可用性冲刺：六期并行全落地 + 飞书真实闭环 + lurker LLM 化）
- 目标：用户四痛点（部署重 / 飞书不回复 / agent 无工具 / CLI 发 npm）→ 六期计划（P1 飞书 plugin 化、P2 HTBP 工具注入、P3 SecretStore、P4 CLI 打包、P5 init 向导、P6 dashboard 配置页）全做。
- 动作（4 个 worker worktree 并行 + 主 assistant 合并/部署/线上验证）：
  - **P1**：新包 `packages/plugin-feishu`（第一个 watt-plugins/* 实例；自持 webhook 回调=验签/AES 解密/decode/mentions 展开/Publish + §11.4 Encode/Send 面 + 凭据自持）；gateway 通用出站分发器 `event/plugin-sender.ts`（adapter→`channel-<adapter>` 约定 + binding:/HTTPS 双形态 + platform-token + X-Watt-Request-Id 幂等）替换 feishu-sender 硬编码（已删）；`watt setup feishu` 幂等五步。
  - **P2**：tools-proxy 抽取 `tools/tool-invoker.ts`（纯重构回归门）→ `harness/htbp-tools.ts` 三工具（htbp_help/skill/call，scope 前缀约束 + Check PEP + deny 回喂）；AgentDefinition 增 `systemPrompt`（Proto §3.1 先行）；spawn 落 toolScopes/systemPrompt 进 state。
  - **P3**：SecretStore（AES-256-GCM + WATT_SECRET_ENCRYPTION_KEY + AAD=名字 + KV_TENANTS `secret:` 前缀）+ `POST /htbp/platform/secret` 四动词永不回显 + resolveSecret env→KV 回退链（keys.ts 明确排除）+ `watt secret` 三命令（值走 stdin）。
  - **P4**：CLI 改名 `@tokenroll/watt` + tsup bundle（core/shared/plugin-feishu inline；lark SDK optionalDependencies + import 容错）+ files/publishConfig + `release:cli` + pack-smoke（tarball 24K→684K 含 deploy/）。
  - **P5**：`watt init` TUI（@clack/prompts 九步：auth→问答→provision(TS 移植)→模板渲染(占位符+飞书开关控 FEISHU_PLUGIN binding)→migrations→信任根三 secret→**同进程本地签首 admin token（零轮换解鸡生蛋）**→deploy→SecretStore 写可选密钥）+ `--resume`/`--resign-admin`；部署产物随包（build:deploy esbuild 3 worker + 模板 + migrations + dashboard dist）；`.env.example`；sign-admin-token jwksBase 参数化。
  - **P6**：dashboard SecretsView/ChannelsView（feishu plugin 状态卡）/ProvidersView（secretRef 下拉）。
  - **R33 增补**（线上实测逼出）：① lurker 接真实 LLM（default provider caller + state.toolScopes 工具 + scratch 上下文进 system；「N 条上下文」前缀保留兼容 E2E-3；@消息也记 scratch；TTL env 覆盖生产 3600s）；② **re-Spawn 复活 terminated 实例**（Proto §3.2 补充语义；重置态 + 按当前 def 重新快照——顺带解决实例快照永不追随 def 更新）；③ **Authorizer 接 AgentDefLoader**（历史恒传空 agentDefs 致一切 agent 主体在步骤 2 误拒——§51 同类坑系统性收口，lurker 出站的绕道保留）。
- 部署事实（两条硬约束实测）：**同账户 workers.dev 互调被平台拦截**（探活/Send 404）→ 同账户 plugin 走 service binding（`binding:FEISHU_PLUGIN`，Plugin.md 平台内推荐形态）；**workers.dev 境内被干扰**（飞书回调 3s 握手超时）→ plugin 挂单级自定义域名 `watt-feishu.pdjjq.org`（Universal SSL 只盖一级）。
- 验证：`pnpm verify` 全绿 **1233 passed / 1 skipped**（shared 6 + dashboard 18 + core 411 + plugin-feishu 47 + cli 175 + gateway 576+1skip）；线上：challenge 握手/伪 token 401/入站 kind='im'/lurker LLM 回答（「（基于本群 2 条上下文）…」真实模型文本）/audit `tool://test/echo/get-uuid` read+invoke allow（lurker 主体全链过 PEP）/SecretStore 回退链（LLM_RELAY_KEY 仅存 KV → 模型调用成功）/**用户截图证实群内 @watt 收到回复 = Phase 6 ② 采证闭环**。
- 勾选：**DOD Phase 6 ②（@feishu 入站真实群消息）**——项目全部 Done。
- 沉淀：llmdoc 收录 R33（current-state 翻页 + decisions ×4 + pitfalls 增补 + reflections）；`.env` 内 FEISHU_ENCRYPT_KEY 实为空（值位是注释——".env 存在≠有值"再现）。
- 遗留：npm publish 未真执行（org 权限待人工）；`watt init` 真实账户全程未跑（交互式 TUI）；飞书 app 缺"接收群聊中所有消息"权限（群上下文只累积 @ 消息）；未配 ENCRYPT_KEY（明文+token 校验模式，建议后台生成后 secret put 到 plugin）；admin token 1h 短命且轮换连坐 pluginToken（运维摩擦，可考虑 init 的 7d token 或独立 plugin 签名面）；httpbin.org 桩工具不稳（E2E/演示建议换 postman-echo）。

## Round 32 — 2026-07-04（Phase 7 关门轮：E2E-4 + 质量关口 22 MAJOR 全修 + 六条全绿）
- 目标：E2E-4 权限对照 + `pnpm e2e` 六条复跑 + Phase 7 关门（质量关口 + 确认项全修 + 沉淀）
- 动作（主 assistant 直接实现）：
  - **E2E-4**（`4f674d2`）：桩财务工具（http postman-echo）+ role:admin allow 策略；admin call 200 / staff（`sign-admin-token --extra user:staff=staff` 同轮换双签）403 permission_denied + tool ls 裁剪 / audit allow(user:djj)+deny(user:staff) 对照 + user 面无 agent 链断言。
  - **质量关口 Workflow**（4 维 + 对抗核查，26 agents，**不含渗透性安全维度**）：**22 MAJOR 确认（0 BLOCKER、0 误报）+ 16 MINOR** backlog。
  - **22 项归并 8 簇全修**（`45bbeb2` + `e05b305`）：① publishTaskOutbound dedupe 死字段→findByDedupeKey 短路+确定性来源键；② secretRef 劫持钉死模型 def→state.model 钉死时不查 default（model+key 同源）；③ queryMetric groupBy string/数组错配→归一+枚举校验；④ **lurker 出站绕过 Check**→core authorize 两关判定（def grants event://* write + 部署策略）+ 审计 + deny 用例；⑤ echo 跳过 expect.schema→同过 validateAgentOutput（E2E-2 判据③从空转变真实）；⑥ E2E 假绿系（/\d/ 恒真→'总计 <n>'非零；1d 窗命中上轮→基线增量；越权 error 非空→语义正则；固定 id+前推窗→run 序号+当下窗）；⑦ E2E 残留/门控系（e2e-3 拆全量订阅+策略清理；e2e-5 清 default 位；e2e-6 exit 钩子兜底清 cron + 门控未开走 null channel；e2e-1 terminate 派生实例）；⑧ e2e-4 判据收紧与降级口径显式声明。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**1136 tests**：shared 6 + dashboard 4 + core 444 + cli 140 + gateway 541+1skip）；`pnpm deploy:all` exit 0；`pnpm provision` 幂等；`node scripts/smoke.ts` OK；**`pnpm e2e` 六条线上全绿**（修复后全量复跑：1/2/3/5/6 一轮 + 4 重签 token 后过——两次 FAIL 均为 token 1h 过期非代码问题）。
- 勾选：**Phase 7 六条 E2E 全部采证**（DOD §9 已入账 R28~R32 证据）→ **Phase 7 正式关门**。**DOD §0 五条**：① 六 E2E ✅（人工体感面残留见下）② 各 Phase DoD 勾选=可重跑命令 ✅（唯 Phase 6 ② 等人工）③ pnpm verify 一键绿 ✅ ④ 从零部署（provision 幂等 + deploy:all + smoke）✅ ⑤ CLI 覆盖全管理面 + E2E 全 CLI 驱动 ✅。
- 沉淀：pitfalls 候选（e2e token 1h 过期是最常见 FAIL 源——脚本前重签；process.on('exit') 兜底清理模式）；16 MINOR backlog（listInstances 200 上限截断、terminated 行 7d sweep 依赖、e2e lib waitFor 吞错噪声等）。
- 遗留：**项目唯一未闭环 = DoD Phase 6 ②（@feishu 入站真实群消息，人工）**；人工体感清单（协议判据已全过）：飞书卡片真实点击、群内可见核对。16 MINOR backlog 维护态顺手修。


## Round 31 — 2026-07-04（Phase 7 R31：潜伏群聊 agent + E2E-3 线上全绿）
- 目标：调研 §4 R31——B5（潜伏群聊 agent 整体缺失）+ E2E-3 四判据线上采证
- 动作（主 assistant 直接实现，commit 87dbd94）：`agent/lurker.ts`——lurker/* 定义前缀分派专用 harness：无 @ 的 im.message 静默写会话级 **TTL scratch namespace**（`context://scratch/<session>`，惰性挂载 structured + ttl=120s，path=event.id 天然幂等，零出站）；含 `@watt` → 读 scratch 出站回答（含上下文条数=协议事实，经 publishTaskOutbound system 管道）。session 粘性=声明式订阅 instanceBy:'session'（def Write 联动建立）。LURKER_SCRIBE_DEF 不入全局种子（订阅全量 im.message 是部署级决策，E2E 脚本注册）。+3 集成测试（真实 DO+D1）。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**1135 tests**）；`pnpm deploy:all` exit 0；**E2E-3 线上全绿**（`pnpm e2e 3`，API 模拟 5+1 消息经真实订阅→consumer→agent 投递）：① 静默期对本会话零出站 ② scratch namespace ≥5 条目（mount ttl=120s 单测锁定；过期等待 E2E_WAIT_TTL=1 可选）③ @watt 后 **8.8s** 收到回答且含"5 条上下文" ④ 全程同一实例 `agent:lurker/scribe#session:...`（粘性）→ terminate 清理。
- 勾选：无（六条全绿后一并勾）。
- 沉淀：无新坑（narrow-to-never 复用 pitfalls §31 已知解法）。
- 遗留：R32 = E2E-4（B6 --extra token 已就绪：admin/employee 对桩财务工具的 PEP 对照 + audit chain）+ 六条 `pnpm e2e` 复跑 + Phase 7 关门（质量关口 + DOD §0 五条终验）。人工清单不变（@feishu 入站、卡片点击）。


## Round 30 — 2026-07-04（Phase 7 R30：deep-research 真实化 + E2E-2 线上全绿）
- 目标：调研 §4 R30——B3（deep-research 真实化）+ E2E-2 四判据线上采证
- 动作（主 assistant 直接实现，commit 407f3d0）：RESEARCH_FANOUT 2→3（判据②）；子 agent spawn 带 **expect.schema**（判据③——result 过 JSON Schema 校验才回送，invalid_output 走 failed）；summarize 增 **publishTaskOutbound**（判据④——汇总经 system outbound 管道送通知渠道，input.notify 参数化可发飞书群，确定性 dedupeKey 防重）；deep-research checkpoint notify 同参数化。websearch 工具留 llm def 换入时接（echo 满足全部协议判据——DOD 断言协议事实非文本内容）。测试三处适配 N=3。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**1132 tests**）；`pnpm deploy:all` exit 0；**E2E-2 线上全绿**（`pnpm e2e 2`）：① waiting_human@confirm-plan → signal approve → running → **done**（3 agent fan-in 经线上 consumer 真实回送）；② agent tree 见 3 个 research 子实例、terminate 后全 terminated（回收）；③ 3 个 research step 全 done（expect.schema 校验通过的 result 回送）；④ 汇总 outbound.message "收到 3/3 份子报告" 留痕。中途 token 过期 401 一次（1h TTL，重签后过）。
- 勾选：无（六条全绿后一并勾）。
- 沉淀：无新坑。
- 遗留：R31 = B5（潜伏群聊 agent：静默订阅 im.message + TTL scratch namespace 写入 + @ 触发回答 + session 粘性）+ E2E-3；R32 = E2E-4 + Phase 7 关门。人工清单不变。


## Round 29 — 2026-07-04（Phase 7 R29：auto-delivery-lite 真实化 + E2E-1 线上全绿）
- 目标：调研 §4 R29——B2（模板真实化）+ B4（checkpoint 通知参数化）+ E2E-1 四判据线上采证
- 动作（主 assistant 直接实现，commit 7a717b2）：
  - **B2 模板真实化**：register-bug 真实写 `context://feedback/bugs/<taskId>`（structured provider，namespace 惰性挂载免手工前置；status:open，approve 后重写 fixed，版本递增可断言）；locate 从"即发即忘桩"改 **expect fan-in**（correlationId + taskWaiter）——接力链这一跳产真实 agent.result 留痕（waitForEvent 归并回送），超时记 failed step 不卡任务。
  - **B4 notify 参数化**：checkpoint 卡片目标由 input.notify {channel,target} 决定（E2E-1/2 可发飞书群），缺省回落 cli/createdBy（零回归）。
  - **测试适配**：本地 vitest 无 consumer 回送——introspect mockEvent（喂 locate 结果）/forceEventTimeout（超时推进）四处适配；HITL 全链补 bug open→fixed（版本 1→2）+ locate output 断言。
  - e2e-1.ts 接入 `pnpm e2e`（判据③ @feishu 未开时协议降级：卡片事件 actions 断言 + CLI signal 恢复——DOD 认可 CLI=人类确认路径）。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**1132 tests**：shared 6 + dashboard 4 + core 444 + cli 140 + gateway 537+1skip）；`pnpm deploy:all` exit 0；**E2E-1 线上全绿**（`pnpm e2e 1`）：run → waiting_human@confirm-release（locate 的 agent.result 经线上 consumer **真实回送**推进）→ ① bug open（v1）→ ③ 卡片事件带 approve/reject signal actions → CLI signal approve → done → ① bug fixed（v2）② locate step done + echo output ④ audit 见 task signal allow。
- 勾选：无（Phase 7 六条全绿后一并勾）。
- 沉淀：无新坑（introspect mockEvent 模式沿用 R20 既有）。
- 遗留：R30 = B3（deep-research 真实化：N=3 + 子 agent websearch 工具 + expect.schema + 汇总出站飞书群）+ E2E-2；R31（B5 潜伏 agent + E2E-3）；R32（E2E-4 + Phase 7 关门）。人工清单持续：@feishu 入站群消息（DoD Phase 6 ②）、飞书卡片真实点击（E2E-1/2 判据③的"真实飞书"面）。


## Round 28 — 2026-07-04（Phase 7 R28：E2E 地基 + E2E-5/6 线上采证）
- 目标：Phase 7 首轮（按 investigator 调研 `.llmdoc-tmp/investigations/phase7-e2e.md` 五轮拆分）——补阻塞项 B1/B6/B7 + `pnpm e2e` 脚手架 + E2E-5/E2E-6 线上闭环
- 动作（主 assistant 直接实现）：
  - **B1 echo def 种子化**（`17ba81d`）：echo AgentDefinition 入 SEED_MANAGE_DEFS（Task 模板依赖，未注册卡 running——Round 20 backlog 收口）。
  - **B7 harness 接 default provider**：AgentInstance.runHarness 每次调用查 ModelProviderRegistry.resolveDefault（def 缺省 model 或 `preferred:'default'` 哨兵 → 跟随平台默认渠道，set-default 即时生效）；secretRef 经 env 引用解析 key。resolveDefault 死代码收口（Phase 4 backlog）。
  - **B6 非 admin token**：sign-admin-token `--extra <sub>=<roles>`（同一把新私钥多签，避免两次 --rotate 互相吊销）——E2E-4 身份对照就绪。
  - **script 能力表扩容**：watt.queryMetric（只读 metrics，Check platform://metrics read + cron 链段 + 旁路审计）——Case 6「含真实数字的日报」数据源（Phase 5 backlog 收口）；+2 测试。
  - **e2e 脚手架**：`scripts/e2e/{lib,index,e2e-5,e2e-6}.ts` + `pnpm e2e`——CLI --json 驱动（spawnSync bin.ts）、waitFor 重试、exit 0/1/2 分层、`E2E_LLM`/`E2E_FEISHU` 门控（每轮每 tag 一次）；未实现条目（1~4）标 TODO。
  - **实测缺陷修复**（`adbf4e8`，E2E-6 首跑翻出）：script publish outbound.message 时 event-bus 出站 Check 带 cron:<jobId> 链段，而注入的平台 Authorizer cronJobs 索引恒空 → 误判 "cron job disabled/deleted"。修：script publish 用本 job 播种的判定包装（审计旁路留痕）；+1 回归测试（修复前必红）。顺带：grants 前缀通配需显式 `event://*`（match.ts 语义）。
  - lib.ts 坑：node strip-only 不支持 constructor parameter properties（pitfalls 候选）。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**1131 tests**：shared 6 + dashboard 4 + core 444 + cli 140 + gateway 536+1skip）；`pnpm deploy:all` exit 0 ×2；**E2E-5 线上全绿**（`pnpm e2e 5`，E2E_LLM=1）：① tokens 7d total=3294 非空 ② e2e5-relay-a List 可见 ③ set-default b 后 a.default 翻转 false ④ **@llm 一次**：preferred:'default' def spawn→send → usage group-by model 出现 minimax-m3（新默认渠道模型，B7 实证）；**E2E-6 线上全绿**（`pnpm e2e 6`）：① job action=script + automations 脚本读回 ② 日报事件含真实数字（"过去 24h token 用量 3467"，watt.queryMetric 真实取数）③ fired/completed 成对 ok:true ④ 越权 job（无 event grants）publish → "cron script grant exceeded" deny。
- 勾选：无（Phase 7 是整体验收——六条全绿 + `pnpm e2e` 编排后一并勾）。
- 沉淀：pitfalls 候选（strip-only 无 parameter properties；script 出站 Check 需播种 cronJobs）；E2E-5/6 脚本即证据载体（可重跑）。
- 遗留：R29 = B2（auto-delivery-lite 真实化：context feedback/bugs open→fixed + 接力链 agent.result 留痕）+ B4（checkpoint 卡片发飞书群，notify 参数化）+ E2E-1；随后 R30（B3 deep-research N=3 + E2E-2）、R31（B5 潜伏 agent + E2E-3）、R32（E2E-4 + Phase 7 关门）。@feishu 入站人工采证持续等待（connect 长驻中）。


## Round 27 — 2026-07-04（Phase 6 关门轮：质量关口 + DoD 复验，① ③ ④ ⑤ 全勾，② 等人工）
- 目标：Phase 6 关门——五项 DoD 复验 + 4 维质量关口 workflow + 逐条对抗核查 + 确认项全修 + Docs 漂移回查 + llmdoc 沉淀
- 动作（按用户指示全部由主 assistant 直接实现，不派 worker）：
  - **在途修复收口**（上一会话遗留未提交）：`d91086f` llm usage 打点取 **totalUsage**（ai@6 语义：usage=仅最后一步、totalUsage=全步累计——tool loop 多步时取 usage 系统性漏账；fake fetch 两步应答锁定）；`2c5a344` platform Publish 接线 **IdentityMapper.Resolve**（channelUser→principal，映射命中/未命中 anonymous 双测试）；`eb902ad` lockfile 追认。
  - **质量关口 Workflow**（4 维 correctness/contract/ops/test-quality + 逐条对抗核查，17 agents；**按约不含渗透性安全维度**）：**12 MAJOR 确认（0 BLOCKER、0 误报驳回）+ 1 降级 MINOR + 18 MINOR** 入 backlog。
  - **12 MAJOR 全修**（按根因聚 7 簇，逐簇 commit）：
    - `9763423` audit List 未声明 filter 键 → invalid_argument（§0.2，对齐 PolicyStore 先例）。
    - `184e018` 内置种子（plugin/manage defs）改「get 不存在才 write」——原无条件 upsert 会在每个新 isolate 冷启动把管理员 Update（enabled=false、换模型）静默回滚（Round 7 策略种子同类缺陷回归）；补"修改不被种子复活"回归测试。
    - `2b8de74` **Send 到未 Spawn 实例 → not_found**（DoD 复验实测自发现：idFromName 隐式创建 INITIAL_STATE 幽灵 DO（harness=echo）静默回显——send 拼错 instanceId 极难排查）；send 先查 correlation 实例索引。
    - `f60c8c5` Dashboard ListInstances 去掉 tree:'all'（tree=<id> 是子树语义，对不存在 rootId 恒 []——Agents 视图实例表在任何有实例环境都渲染为空）+ status→state 字段对齐 + **dashboard api 客户端 vitest 从零建立**（4 tests 锁请求形状/错误语义）。
    - `d053508` connectFeishu 接 SDK **onError → Promise 可 settle**——原实现连接后永不 settle，runSupervisor 断线重连全是死代码（SDK 1.68.0 全部终态放弃路径必然 safeInvoke('onError')，实证 lib/index.js）；start() 异步 rejection 一并接住；lark 模块可注入 +3 settle 测试。
    - `b9d51fc` PluginRegistry.Write **注册探活**（§11.1 最低整改：外部 endpoint GET healthPath 不通 → 拒绝注册不落库不签 pluginToken；binding: 跳过；~help/~describe 校验延后 doc-gaps #30）。
    - `a059f7f` **飞书出站可靠投递**：retryable 语义（网络/token 失效→msg.retry 上限 3→DLQ；业务拒绝→留痕 ack）+ token 失效作废 KV 缓存 + **重投幂等**（systemPublish 确定性 dedupeKey `system:checkpoint:<源事件id>` 窗内短路 + 飞书 uuid=event.id 服务端去重）+ system handler 抛错不再失整批；+6 测试。
    - `a401aec` **push 型入站 source.kind 保留**：channel-adapter plugin 主体（pluginToken）自报 kind='im' 予以保留（白名单防冒用），其余维持 §2.3 webhook 规约——修复前 sourceKind:'im' 订阅对飞书事件永不命中；CLI connect 优先 WATT_PLUGIN_TOKEN。
  - **Docs 漂移回查**：`1523eff` Proto §2.3 规约豁免规范性补充（宪法先行）；doc-gaps #25① 收口标注 + 新增 #30（~help 注册校验延后）/#31（R27 实现声明簇）；modules-and-flows 注册流程标注实现状态。
- 验证（主 assistant 亲自跑）：`pnpm verify` **exit 0（1108 tests**：shared 6 + dashboard 4 + core 444 + cli 140 + gateway 514+1skip**）**；`pnpm deploy:all` exit 0（toolbridge→gateway→dashboard + 四库 migrations 幂等）；**修复线上复验**：Send 幽灵实例 → 404 not_found / audit bogus filter → 400 / plugin 探活失败 → 400 拒绝注册；**DoD 复验**：③ tokens 7d v=1199 + group-by model + status tokensToday 2095；④ @llm 一次：manage/cron 对话 → CronJob{0 9 * * *, publish report.daily.tokens, target=测试群} → 清理；⑤ M10 全表 33+ 命令 --json sweep 全 PASS + 三入口（CLI/API/Dashboard-Origin）audit 对等各恰 3 行 allow 同主体；② 出站复验（consumer outcome ok 0 异常）+ WS 链路就绪（plugin 主体长驻），**入站真实群消息等人工**。
- 勾选：**Phase 6 ① ③ ④ ⑤**（证据入 DOD.md）；② 待人工入站后勾 → Phase 6 正式关门。
- 沉淀：llmdoc 更新（current-state 翻页 R27、pitfalls 新坑 ×4、doc-gaps #30/#31、reflection）；Proto §2.3 回写。
- 遗留：**② @feishu 入站人工步骤**（connect 已长驻，群里已留请求配合消息）；19 条 MINOR backlog（metrics filter 静默忽略（已降级确认）、60s 超时覆盖整个 tool loop、模型中途抛错漏 usage、pluginToken 无轮换端点 §11.2、CORS 白名单不可收窄、dashboard base 默认同源、agent sink 不透传 claims、wrapEvent header 平铺假设、feishu Send 无 §11.4e 10s 超时、im.action 缺 session 声明、recordUsage/recordScriptAudit/audit best-effort 零覆盖等）；DoD ⑤ sweep 期间留下的良性残留：provider r27-relay（唯一 provider 行，resolveDefault 死代码不影响 harness）、plugin r27-plugin（已置 disabled）、channel-feishu built_in 标志经 Write 翻为 false（health 走 binding: 分支仍 healthy）。


## Round 26 — 2026-07-04（Phase 6 R26：Dashboard + PluginRegistry + CLI 完备——DoD ⑤ 地基）
- 目标：Phase 6 / DoD ⑤（CLI 完备 + 三入口对等）的 Dashboard 与 plugin 面
- 动作：worker 落地（commits 18b7e3c/16885ee/9fcd3c1）：PluginRegistry（plugin_registrations 表挂 watt-providers 0004 + List/Get/Write/Update + Lifecycle.Health；内置 webhook/feishu adapter 种子注册 kind=channel-adapter）；/htbp/platform/plugin 路由 + CORS 中间件（允许 pages.dev origin）；CLI watt plugin register|list|health；packages/dashboard（Vite+React 静态 SPA：Overview/Agents/Tasks/Cron 写/Audit 五视图 + HTBP 客户端 + token 手填 localStorage）；deploy-all 编排 pages deploy（--skip-dashboard 可跳）。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**1083 tests**：shared 6 + core 444 + cli 137 + gateway 496+1skip）；`wrangler pages project create watt-dashboard` + deploy → **https://watt-dashboard-4tn.pages.dev 200**；CORS preflight 回 allow-origin 精确匹配；线上 `watt plugin list` 见 channel-webhook/channel-feishu 种子、`plugin health channel-feishu` → healthy:true；audit 已积累 38 行（三入口对等的数据面就绪）。
- 勾选：无（DoD ⑤ 证据关门轮采集：三入口同操作 AuditLog 对等抽查需 Dashboard 人工/脚本配合）。
- 沉淀：留关门轮统一。
- 遗留：R27 关门（五项 DoD 复验 + @feishu 入站真实消息 + M10 CLI 核对清单入账 + 质量关口 workflow——按约不含渗透性安全维度）。

## Round 25 — 2026-07-03/04（Phase 6 R25：manage/cron Agent——DoD ④ 线上通过）
- 目标：Phase 6 / DoD ④（manage/cron 对话建 CronJob）+ ②의 WS 入站链路启动验证
- 动作：worker 落地：llm harness 加 **agentic tool loop**（Vercel AI SDK generateText tools+maxSteps；无 tools 的 def 行为不变零回归）；scheduler-tools（scheduler_write/list 工具 execute 直调 SchedulerManager，Check 经 Authorizer wrapper 自带审计——工具面选型 B：不过 builtin 树，gateway 内直连，理由已注释声明）；manage-defs（manage/cron 种子 def：中文 ~skill prompt 内嵌 cron 语义/三 action/输出纪律 + tools:['scheduler'] + grants platform://scheduler；manage/platform 一并种子纯对话；ensureManageDefsSeeded 挂路由中间件与策略种子同幂等语义）；+16 测试（fake 模型工具轨迹断言全链）。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**1037 tests**：shared 6 + core 435 + cli 128 + gateway 468+1skip）；部署 exit 0；**DoD ④ 线上 @llm 一次**：`watt agent spawn manage/cron` → send "每天早上 9 点（UTC）发一份 token 用量日报到测试群 <chat_id>" → 真实模型两步工具调用 → `watt cron list` 见 **CronJob{schedule:"0 9 * * *", action:publish report.daily.tokens, payload.target=<chat_id>, description 中文正确}** → 清理（cron rm + terminate）。**WS 入站链路**：`watt channel connect feishu-main` 起真实长连接 → SDK "ws client ready"（订阅方式需在飞书后台配置为长连接——链路侧已就绪；真实群消息入站需人工发消息配合，留关门轮）。
- 勾选：无（DoD ④ 证据已备，随关门一并勾）。
- 沉淀：决策候选 manage-agent-tool-loop（选型 B 直连 vs builtin 树）。
- 遗留：R26（Dashboard 最小版 + PluginRegistry + CLI 完备性——DoD ⑤）；R27 关门（DoD ①②③④⑤ 复验 + @feishu 入站人工配合 + 质量关口）。

## Round 24 — 2026-07-03（Phase 6 R24：飞书 ChannelAdapter——入站规约 + 出站接线 + CLI connect）
- 目标：Phase 6 / DoD ①（飞书单测四面）+ ②（@feishu 集成）的地基（真实收发留 R25）
- 动作：worker 落地（commits 3 连 + fix）：
  - **core 规约纯逻辑**：`core/src/channel/feishu.ts`——WS 事件 decode（im.message.receive_v1→type/session=feishu:chat:<id>/channelUser=open_id/dedupeKey=event_id/occurredAt；card.action.trigger→im.action+signal 载荷）+ OutboundMessage encode（text→msg_type:text；actions→interactive 卡片 ActionButton→button.value 信号回传）；33 新测试，core 覆盖率 100% 保持。
  - **IdentityMapper 渠道映射**：watt-policies 0002（channel_identities 表）+ resolve 查表（未命中 anonymous 保留）+ identity 写入口路由 + CLI。
  - **出站接线**（调研标注的隐藏工作量）：consumer 加 outbound.message 投递分支（ChannelStore 查 adapter=feishu → feishu-sender 调 REST）；feishu-sender（tenant_access_token 换取 + KV_TENANTS TTL 缓存 + 可注入 fetch）；FEISHU_APP_ID/SECRET 进 gateway secrets（deploy-all 检查清单同步）。
  - **CLI connect**：装 @larksuiteoapi/node-sdk（cli 包）；`watt channel connect`——WSClient（wsConfig 必填坑）+ supervisor backoff 重连 + core decode → 平台 Publish 转发。
  - **线上冒烟修复**：feishu-sender 裸 `fetch` 引用在 workerd 抛 Illegal invocation（丢 this）——绑定 globalThis 修复（pitfalls 候选）。
- 验证（主 assistant 亲自跑）：`pnpm verify` exit 0（**1021 tests**：shared 6 + core 435 + cli 128 + gateway 452+1skip）；`pnpm deploy:all` exit 0（watt-policies 0002 线上应用，channel_identities 表实证存在）；**线上出站全链**：`watt channel set feishu-main --adapter feishu` → Platform API Publish outbound.message → consumer → 飞书 REST 投递（首发现 Illegal invocation，修复重发后 tail 日志 0 失败；直连 REST probe code 0 验证 scope/凭据可用）。
- 勾选：无（DoD ① 单测面已备，随关门与 ② 一并勾）。
- 沉淀：pitfalls 候选（workerd 裸 fetch 引用 Illegal invocation；WSClient wsConfig 必填）。
- 遗留：R25（@feishu 真实进出集成 + manage/cron Agent + DoD ④）；R26（Dashboard + PluginRegistry + CLI 完备 DoD ⑤）；R27 关门。注意：飞书 app 缺 im:message.group_msg 读权限（消息列表查不了，发消息 im:message:send 正常——真实收发验证靠 WS 入站+人工/回执）。

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
