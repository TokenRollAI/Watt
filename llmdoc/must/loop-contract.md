# 每轮循环执行契约（浓缩自 LOOP.md + DOD §10 约定）

> 每轮必读。真源：`LOOP.md`、`DOD.md`。本文只做高密度浓缩，冲突时以真源为准。

## 四条不可违背纪律（LOOP §0）

1. **Docs 是宪法**：`Docs/Proto.md`/`Architecture.md`/`Plugin.md` 是规范真源；实现偏离先改 Docs（写理由）再写码；Docs 自相矛盾先修 Docs。
2. **DOD 是验收法官**：只有 DOD 勾选项算进度；勾选唯一依据是可重跑命令及其输出。
3. **不伪造进度**：测试失败就报失败；跳过步骤明说；`@llm`/`@feishu` 测试真实消耗资源，每轮每 tag 最多跑一次。
4. **成熟框架优先，拒绝造轮子**：要"从头写"基础设施时停下先找成熟方案；表外新需求先派 investigator 调研，确认无方案并在 PROGRESS.md 写明理由后才允许手写。

## 成熟框架优先表（全表，LOOP §0）

| 要写的东西 | 用现成的 |
|---|---|
| Agent 实例/状态/调度/WS | Cloudflare Agents SDK（`Agent` 类、`this.state`/`this.sql`/`this.schedule`），不手写 DO 状态机 |
| 长任务/重试/human-in-loop | Cloudflare Workflows（`step.do`/`waitForEvent`），不自造持久化执行引擎 |
| Agent harness | Flue / Agents SDK / Claude Agent SDK（Reference §4），不自写 agentic loop |
| 工具网关/HTBP 树 | tool-bridge 现有实现优先复用；私有仓库 `TokenRollAI/tool-bridge`，缺功能直接改它，不另起平行网关 |
| MCP server/client | Agents SDK 的 McpAgent + `workers-oauth-provider`，不手写协议 |
| 飞书收发 | `@larksuiteoapi/node-sdk`（WSClient + REST），不手写 wss/验签 |
| JWT/JWKS | `jose`，不手写签名验签 |
| HTTP 路由/中间件 | Hono，不手写 router |
| CLI 框架 | commander/citty/clipanion 择一，不手写 argv 解析 |
| 校验/Schema | zod（含 JSON Schema 互转），不手写 validator |
| 模型调用 | 官方 SDK（@anthropic-ai/sdk 等）经 AI Gateway，不手拼 HTTP |

注意：文档中 "Flue" 归属勘误——真身为 `withastro/flue`，`TokenRollAI/flue` 不存在（见 [../memory/decisions/flue-attribution.md](../memory/decisions/flue-attribution.md)）。

## 每轮五步流程

1. **取 context（llmdoc 优先）**：`llmdoc/index.md` → `startup.md` → MUST 文件；读/建 `PROGRESS.md`；按任务读相关 guides 与 reflections；探索现状派 `investigator` 产 scratch report（`.llmdoc-tmp/`），不在主上下文大面积翻代码。
2. **定目标（每轮一个 DoD 项）**：从 PROGRESS.md + 当前 Phase 挑一个未勾选 DoD 项作唯一目标，按 Phase 顺序不跳；依赖外部凭据先核对 `.env` 与 DOD §9，缺则记 blocker 换下一项。
3. **实现（默认并行）**：界限清晰的实现派 worker（给精确 Proto 章节号+验收命令）；多互不依赖子任务同消息并行（冲突改文件用 `isolation: worktree`）；Phase 关门前跑 review→对抗核查；单点小改动直接自己做。派 subagent 三要求：精确路径与章节号、结构化结论、产出验证后才算数。
4. **验证（按序全满足）**：① 本项 DoD 命令通过（test-first 先看红过）；② 回归 `pnpm verify` 全绿；③ 契约核对 + CLI 同步生长 + 造轮子自查（新写 >100 行无框架基础设施代码对照纪律 4 表）；④ 涉部署项 `pnpm deploy:all` + `smoke.ts` 或 `watt` 命令在 `WATT_BASE_URL` 验证；⑤ 证据入账 PROGRESS.md 并勾 DOD。
5. **收尾沉淀（每轮必做）**：更新 `PROGRESS.md`（末尾追加 `## Round <N> — <日期>`：目标/动作/验证/勾选/沉淀/遗留 六行）；durable knowledge 跑 `/llmdoc:update`；流程坑派 `reflector`；Phase 关门时重跑全部 DoD+回归、整体沉淀、回查 Docs 漂移。

## tool-bridge 上游通道判断标准（LOOP §2.1）

Watt Tool Gateway（M4）缺能力**首选去上游 tool-bridge 补齐**，不在 Watt 内 workaround 或平行实现：

- **通用网关能力**（新节点类型、`~help` 生成、虚拟化、租户、协议细节）→ 上游 tool-bridge。
- **Watt 特有语义**（Auth 联动、platform 子树接口、Watt Context 子树代理）→ Watt 侧 adapter/配置。
- 拿不准 → 倾向上游。

流程：`gh repo clone TokenRollAI/tool-bridge`（私有，gh 已有访问权）→ 开分支实现（遵循其 Vitest + `src/worker/tb/` adapter 模式），跑通自身测试后 push → Watt 侧引用更新版 → 回到本轮 DoD 项验证 → PROGRESS.md 单独记一行上游改动。

## 硬性止损规则

- **同一 DoD 项连续 3 轮未闭环**：停止重试，在 PROGRESS.md 记 blocker，换下一项，请人工介入。
- Cloudflare 凭据验证只用 `wrangler whoami`，不用 `/user/tokens/verify`（Account API Token 会误报 Invalid，详见 [current-state.md](current-state.md)）。

## DOD 全局约定要点

- CLI 增量策略：`watt` CLI 不是独立 Phase，随各 Phase 生长；从 Phase 1 起作为集成验证默认驱动；CLI 是纯 Platform API 客户端，"存在管理旁路"视为缺陷。
- 每 Phase 通用验收五条：契约一致 / 单元测试（Vitest + `@cloudflare/vitest-pool-workers`）/ 集成测试穿透 / 可部署（`wrangler deploy` + `scripts/smoke.ts`）/ 回归不破坏。
- E2E 断言协议事实（事件序列、状态迁移、权限判定、数据落点），不断言 LLM 文本内容。
