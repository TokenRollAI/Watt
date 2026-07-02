# PROGRESS（loop 自维护进度账本）

> 真源：[DOD.md](DOD.md)（验收标准）、[LOOP.md](LOOP.md)（执行契约）。本文记录当前 Phase、已勾选项、每轮证据与遗留。

## 当前状态

- **当前 Phase**：Phase 1 已关门（2026-07-02 Round 7）→ **Phase 2（Event Gateway）**
- **已勾选**：Phase 0 全部；Phase 1 全部（关门证据 Round 7）
- **Blocker**：无（注意：watt.pdjjq.org 本机 ISP DNS 污染，CF 边缘正常——验证/E2E 用 workers.dev URL 或 DoH）
- **下一目标**：Phase 2 / DoD 项 1（订阅匹配、instanceBy 路由、Verify 拒收、出站鉴权点单测）

## 上游改动记录（tool-bridge 等）

（无）

---

# 轮次记录

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
