# 2026-07-04 — 飞书群消息静默中断：R35 信任根轮换连坐 pluginToken（R34 遗留验证收口）

## Task
- 用户报障「给飞书群发消息无回复」。排查确认消息根本没进平台（watt-events 最近入站 im.message 停在 UTC 14:14），逐段探测定位到 pluginToken 401 失效，单步重签修复，真人群消息 e2e 闭环。

## Expected vs Actual
- 预期：R34 末尾重签的 pluginToken 应当有效，飞书入站链路可用。
- 实际：该 pluginToken 在 R35 Root Key 改造期间信任根再次轮换时被连坐吊销——R34 反思 Follow-up 里「新 pluginToken 未经真人群消息验证」的遗留项，实际上遗留的就是一个已经坏掉的 token。入站中断完全静默：飞书侧只见回调 502，平台侧无任何告警。

## What Went Wrong
- **信任根轮换后没有立即验证依赖凭据**：R35 的 Root Key 改造属于「顺带」轮换信任根，轮换连坐 pluginToken 的规律 R34 已知，但没有形成「轮换 → 立即重签 + secret put + 假事件探测」的强制动作，而是被动等「下次真人消息」暴露——结果暴露方式就是线上事故。
- **pluginToken 失效无告警面**：飞书回调收到 502 后只会重试/放弃，watt 平台侧 Publish 401 没有任何主动信号。「入站流量归零」这类物理量目前无人监控。
- **R34 遗留项被 R35 的改动直接作废而未察觉**：遗留台账记录的是「待验证」，但后续轮次改动信任根时没有回查该遗留项是否已被连坐失效——遗留项的前提条件变化时台账不会自动报警。

## What Worked（保持）
- **诊断先查数据真源**：第一步直接看 watt-events 最近入站时间戳 vs 当前时间，立刻判定「消息没进来」（而非「进来了没回复」），比翻日志快一个量级，排查方向一次定准。
- **分段探测法**：healthz（worker 活着）→ verification token challenge 握手（验签配置对）→ 用 .env 的 FEISHU_VERIFICATION_TOKEN 构造假 im.message.receive_v1 事件（假 chat_id，避免打扰真实群）POST 到 `https://watt-feishu.pdjjq.org/webhook/event` → 返回 502 "platform Publish failed: HTTP 401 invalid or expired token"，一次探测把断点精确暴露在 Publish 的 pluginToken 上。假事件同时覆盖「全链含 Publish + D1 落库」两个证明面。
- **最小面修复（复用 R34 教训）**：只单跑 `npx @tokenroll/watt --json plugin register channel-feishu ...` 重签（严格不跑完整 `setup feishu`，避免 pitfalls §63 def 整体 Write 冲掉线上 grants）；pluginToken 经 stdin 直接 `wrangler secret put` 到 watt-plugin-feishu，不落盘不回显；等 15s 传播窗口后假事件重放返回 `{"ok":true}` 且落库。
- **真人闭环采证**：用户发两条 @watt 消息均入站（17:31:23/17:31:32）且均有出站回复（17:31:46/17:32:10）——R34 遗留的「入站面未采证」就此收口。

## Root Cause
- pluginToken 的信任链挂在 JWT 签发密钥上，信任根任何轮换（含 Root Key 改造这类非轮换目的的改动）都会连坐吊销全部在途 pluginToken，且失效表现为下游回调 502 的静默故障。已知规律（R34）没有升级为轮换后的强制运维步骤，验证被推迟到「自然流量」。

## 顺带发现（current-state 过时项）
- npm `@tokenroll/watt` 已真实发布 v0.1.1（npx 可直接跑），current-state 里「npm 未真发布」已过时。
- `~/.watt/credentials.json` 的 admin token 为 7d 长票且仍有效（R35 root key 换发产物）。

## Missing Docs or Signals
- 缺轮换 runbook：信任根轮换（不论动机）后的强制三步——重签 pluginToken → stdin secret put → 假事件探测验证（不得以「等真人消息」代替）。
- 缺告警面：pluginToken 失效静默，平台侧 Publish 401 / 入站流量归零无信号（可考虑 healthz 扩展带 token 自检，或入站水位监控）。
- 缺排障套路沉淀：飞书入站链路分段探测法（healthz → challenge → 假事件 → D1 落库）目前只在本反思里。

## Promotion Candidates
- `must/current-state.md`：更新 npm 已发布 v0.1.1、admin token 7d 长票现状；pluginToken 已于本次重签。
- `guides/`（运维/轮换 runbook）：信任根轮换连坐纪律——轮换后立即重签 pluginToken + secret put + 假事件探测，静默失效不可依赖自然流量暴露。
- `guides/`（排障）：飞书入站分段探测法四步（数据真源时间戳判定 → healthz → challenge → 假 chat_id 事件全链探测），假事件是覆盖 Publish 面的最小无扰探针。
- `reference/external-facts.md` 或 pitfalls：pluginToken 失效在飞书侧的表征 = 回调 502，`platform Publish failed: HTTP 401` 即信任根连坐信号。

## Follow-up
- 请 recorder 更新 current-state（npm 发布 / 7d admin token / pluginToken 重签），并按 Promotion Candidates 落轮换 runbook 与排障指南。
- 评估 pluginToken 失效的主动信号方案（healthz 自检或入站水位告警），避免第三次静默中断。
- 后续任何触碰信任根的改动（密钥轮换、root key、签发逻辑）在 DoD 里显式包含 pluginToken 重签 + 假事件验证。
