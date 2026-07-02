# llmdoc 全局文档地图

> Watt：构建在 Cloudflare 上的 Agent Infra 平台，由持续开发 loop 按 DOD Phase 0~7 增量实现（Phase 0/1 已关门，当前 Phase 2 Event Gateway）。规格真源在 `Docs/`，本目录是其检索层与过程记忆。启动阅读顺序见 [startup.md](startup.md)（此处不重复）。

## 目录用途

| 目录 | 用途 |
|---|---|
| `must/` | 每轮必读的小文档（执行契约 + 当前状态） |
| `overview/` | 项目定位、验收基准、路线图 |
| `architecture/` | 模块边界、数据流、全局模式 |
| `guides/` | 单一工作流指南（随实现轮次生长） |
| `reference/` | 稳定查表事实（接口契约地图、外部事实） |
| `memory/` | 过程记忆：`decisions/`（决策记录）、`reflections/`（流程反思，reflector 维护）、`doc-gaps.md`（Docs 缺口台账） |

## 文档清单

- [must/loop-contract.md](must/loop-contract.md) — 每轮循环执行契约浓缩：四条纪律、成熟框架优先表、五步流程、tool-bridge 上游通道、止损规则。
- [must/current-state.md](must/current-state.md) — 当前状态快照：Phase 进度、源码/部署现状、本机工具链、凭据状态与空缺（随轮次更新）。
- [overview/project-overview.md](overview/project-overview.md) — 项目定位、六个 User Case、Phase 0~7 路线图、全局 Done 五条。
- [architecture/modules-and-flows.md](architecture/modules-and-flows.md) — M1~M11 模块表、三大 Registry 与单一 HTBP 消费面、数据流、HITL 链路、CLI 命令表、Plugin 四类契约、引导顺序。
- [guides/toolchain-pitfalls.md](guides/toolchain-pitfalls.md) — 本仓库工具链与 wrangler 部署的坑：registry 超时、pnpm build 门禁、vitest-pool-workers 新 API（含 D1 migrations 接线、同文件共享 isolate）、TS noEmit、workers_dev 默认关闭、--json banner 污染、JSONC 注入、边缘传播重试（含旧 isolate 首击）、本机 DNS 污染 workaround、Biome 单行 import、块注释 `*/` 字面、coverage 排除、--coverage 不透传、脚本 stdout 纯净化、secret 传播窗口、provision 幂等金标准、pnpm --filter 空匹配假通过、验证脚本 base_url 缺省、Hono matcher 锁定、501 占位注册位置。
- [guides/phase-gate-workflow.md](guides/phase-gate-workflow.md) — Phase 关门标准流程：重跑 DoD 记证据 → 5 维质量关口 + 对抗核查 → 修复复核 → Docs 漂移回查 → PROGRESS 入账与 llmdoc 沉淀；附 Phase 0/1 实测经验（并行修复拆分、跨包契约消费方枚举、线上全链重跑）。
- [reference/proto-map.md](reference/proto-map.md) — Proto.md 章节检索地图 + 四大横切契约（Event 信封/CallContext/§6.4c 判定/WattError 含 401/501 补充与裸 body）+ §6.5d device flow + §3.4 六条路由规则 + HTBP 树 + 24 个接口面。
- [reference/external-facts.md](reference/external-facts.md) — Cloudflare 原语选型、外部仓库归属（含 Flue 勘误）、模型渠道双路径与易错点、飞书 WS 方案要点。
- [memory/doc-gaps.md](memory/doc-gaps.md) — Docs 缺口台账（P1/P2 需修 Docs，P3 仅记录）。
- [memory/decisions/feishu-websocket-channel.md](memory/decisions/feishu-websocket-channel.md) — 飞书走 WS push 型不走 webhook（2026-07-02）。
- [memory/decisions/flue-attribution.md](memory/decisions/flue-attribution.md) — Flue=withastro/flue 勘误确认（gh 核实）。
- [memory/decisions/resource-naming-and-provision.md](memory/decisions/resource-naming-and-provision.md) — 云资源 `watt-` 前缀、D1 多库拆分、Vectorize 1024 维 bge-m3、`pnpm provision` 幂等方案（2026-07-02 Round 2）。
- [memory/decisions/bare-watterror-body.md](memory/decisions/bare-watterror-body.md) — 错误 body = 裸 WattError 无信封；401/501 复用 7 码不扩容（2026-07-02 Round 3）。
- [memory/decisions/auth-implementation.md](memory/decisions/auth-implementation.md) — Phase 1 Auth 选型：Ed25519+jose+JWKS、私钥生命周期与轮换签发模式、device grants 存 KV、OAuth 端点 WattError 豁免边界、CLI 未认证退出码分层、KV 判定缓存跳过（2026-07-02 Round 5/6）。
- [memory/reflections/2026-07-02-round1-scaffold.md](memory/reflections/2026-07-02-round1-scaffold.md) — Round 1 worker 派发反思：prompt 三件套模板、Reflection Handoff、派发前 proto-map 自查指令契约细节。
- [memory/reflections/2026-07-02-round7-phase1-gate.md](memory/reflections/2026-07-02-round7-phase1-gate.md) — Round 7 关门轮反思：派发检查清单（filter 名对照 package.json name、跨包契约改动先 grep 全部消费方、文件集预留连带改动报告出口）、独立 mock 掩盖跨包错配、deploy 后旧 isolate 误判、worker 有理偏离评审建议的良性案例。

## 检索路由

- 查**接口契约/事件 schema/错误码/判定算法** → [reference/proto-map.md](reference/proto-map.md)（再按章节号进 `Docs/Proto.md`）。
- 查**模块归属/宿主/持久化/数据流/Plugin 类型/CLI 命令** → [architecture/modules-and-flows.md](architecture/modules-and-flows.md)。
- 查 **Cloudflare 原语限制/外部仓库/模型渠道/飞书方案** → [reference/external-facts.md](reference/external-facts.md)。
- 查**验收标准/Phase 范围/E2E 判据** → [overview/project-overview.md](overview/project-overview.md)（再进 `DOD.md`）。
- 查**每轮怎么干/何时止损/该不该造轮子** → [must/loop-contract.md](must/loop-contract.md)。
- 查**凭据/工具链/当前进度** → [must/current-state.md](must/current-state.md)。
- **装依赖/配测试/改 TS 工程/wrangler provision 与 deploy 踩坑** → [guides/toolchain-pitfalls.md](guides/toolchain-pitfalls.md)。
- **某 Phase DoD 全勾、准备关门** → [guides/phase-gate-workflow.md](guides/phase-gate-workflow.md)。
- 发现 Docs 自相矛盾或缺口 → 先查 [memory/doc-gaps.md](memory/doc-gaps.md) 是否已记录。
- 历史决策为什么这么定 → `memory/decisions/`。

## 外部真源（不在 llmdoc 内）

- `Docs/{Vision,Architecture,Proto,Plugin,Reference}.md` — 规范宪法。
- `DOD.md` — 验收法官；`LOOP.md` — 执行契约原文。
- `.env` — 凭据真源（已 gitignore）；`PROGRESS.md` — 进度账本（首轮建立）。
- `.llmdoc-tmp/investigations/` — 临时调查缓存，复用前须验证。
