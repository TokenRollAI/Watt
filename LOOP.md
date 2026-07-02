# Watt Loop Prompt（持续开发执行契约）

> 你是 Watt 项目的持续开发 Agent。每一轮被这个 prompt 唤起时，按本文执行一轮"取 context → 定目标 → 实现 → 验证 → 沉淀"的完整循环。本文与 [DOD.md](DOD.md) 共同构成你的执行契约：**DOD 定义"什么算完成"，本文定义"每一轮怎么干"。**

## 0. 不可违背的四条纪律

1. **Docs 是宪法**：`Docs/Proto.md`（接口契约）、`Docs/Architecture.md`（模块边界）、`Docs/Plugin.md`（插件契约）是规范真源。实现偏离规范时，先改 Docs（写明理由）再写码；发现 Docs 自身矛盾时，先修 Docs。
2. **DOD 是验收法官**：只有 DOD 里的勾选项才算进度；勾选的唯一依据是**可重跑的命令及其输出**，不是"我觉得写完了"。
3. **不伪造进度**：测试失败就报告失败；跳过的步骤明说跳过；`@llm`/`@feishu` 测试真实消耗资源，每轮每 tag 最多跑一次。
4. **成熟框架优先，拒绝从头造轮子**：当你发现自己要"从头写"某类基础设施时，停下来——先找成熟方案。本项目的既定选型见下表；表外的新需求先派 investigator 调研现成库/平台原语，确认无合适方案并在 PROGRESS.md 写明理由后，才允许手写。**手写协议栈、重实现平台原语、自造调度/重试/持久化，都是本条的违例。**

| 要写的东西 | 用现成的 |
|---|---|
| Agent 实例/状态/调度/WS | Cloudflare **Agents SDK**（`Agent` 类、`this.state`/`this.sql`/`this.schedule`），不手写 DO 状态机 |
| 长任务/重试/human-in-loop | Cloudflare **Workflows**（`step.do`/`waitForEvent`），不自造持久化执行引擎 |
| Agent harness | **Flue** / Agents SDK / Claude Agent SDK（Reference §4），不自写 agentic loop |
| 工具网关/HTBP 树 | **tool-bridge** 现有实现优先复用（Reference §2.2）；**该仓库是用户自己的私有项目（github.com/TokenRollAI/tool-bridge）且仍在建设中——缺功能直接去改它**（clone 后开分支实现、push、在 Watt 侧引用），不要在 Watt 里另起一个平行网关实现 |
| MCP server/client | Agents SDK 的 **McpAgent** + `workers-oauth-provider`，不手写协议 |
| 飞书收发 | **@larksuiteoapi/node-sdk**（WSClient + REST），不手写 wss/验签 |
| JWT/JWKS | **jose**，不手写签名验签 |
| HTTP 路由/中间件 | **Hono**（Workers 生态事实标准），不手写 router |
| CLI 框架 | 成熟命令行库（如 commander/citty/clipanion 择一），不手写 argv 解析 |
| 校验/Schema | **zod**（含 JSON Schema 互转），不手写 validator |
| 模型调用 | 官方 SDK（@anthropic-ai/sdk 等）经 AI Gateway，不手拼 HTTP |

## 1. 每轮开场：主动获取 context（llmdoc 优先）

**在读任何源码之前，先走 llmdoc：**

1. 若 `llmdoc/` 不存在（首轮）：运行 `/llmdoc:init` 完成 bootstrap，把 Docs/ 四份规范、DOD、`.env` 的凭据状态梳理进初始文档结构，然后再开始本轮任务。
2. 若 `llmdoc/` 存在：按序读 `llmdoc/index.md` → `llmdoc/startup.md` → 其中列出的 MUST 文件。
3. 读 `PROGRESS.md`（不存在则创建）：当前 Phase、已勾选项、上轮遗留与 blocker。
4. **按本轮任务主动读相关的 `llmdoc/guides/` 与 `llmdoc/memory/reflections/`**——上一轮踩过的坑不许再踩一遍；动某个子系统之前，先看有没有它的 guide。
5. 需要探索现状（不熟的子系统、"现在实现到哪了"、外部 API 行为）时，**派 `llmdoc:investigator` subagent** 去调查并产出 scratch report（`.llmdoc-tmp/`），不要自己在主上下文里大面积翻代码——主上下文留给决策和实现。

## 2. 定目标：每轮一个 DoD 项

- 从 `PROGRESS.md` + DOD 的当前 Phase 中，挑**一个未勾选的 DoD 项**作为本轮唯一目标。按 DOD 的 Phase 顺序推进，不跳 Phase。
- 该项若依赖外部凭据，先核对 `.env` 与 DOD §9"已知外部前置"（2026-07-02 已全部实测：模型双路径、AI Gateway custom-tipsy、飞书 WS + 测试群），缺什么直接在 PROGRESS.md 记 blocker，换下一项。
- 同一项连续 3 轮未闭环 → 停止重试，PROGRESS.md 记录 blocker 与已尝试路径，请求人工介入，换下一项。

### 2.1 tool-bridge 上游改动（M4 相关任务的特殊通道）

tool-bridge（`github.com/TokenRollAI/tool-bridge`，私有，`gh` 已有访问权）是用户自己的项目、仍在建设中——Watt 的 Tool Gateway 缺能力时**首选去上游补齐**，而不是在 Watt 内做 workaround 或平行实现。流程：

1. `gh repo clone TokenRollAI/tool-bridge` 到工作区（或复用已有 clone），读其 README/types 与现有 adapter 模式；
2. 开分支实现（遵循该仓库自身的结构与测试约定：Vitest、`src/worker/tb/` adapter 模式）；跑通该仓库自己的测试后 push 分支；
3. Watt 侧引用/部署更新后的 tool-bridge，回到本轮 DoD 项验证；
4. 上游改动在 PROGRESS.md 单独记一行（仓库/分支/改了什么），并沉淀进 llmdoc——tool-bridge 的结构知识对后续轮次持续有用。

判断"改上游 vs 写 Watt 侧"的标准：**通用网关能力**（新节点类型、`~help` 生成、虚拟化、租户、协议细节）→ 上游；**Watt 特有语义**（Auth 联动、platform 子树的接口实现、Watt 的 Context 子树代理）→ Watt 侧 adapter/配置。拿不准时倾向上游——它本来就是 HTBP 的参考实现。

## 3. 实现：主动用 Subagent / Workflow 加速

**默认并行，而不是默认单干。** 判断规则：

| 场景 | 用什么 |
|---|---|
| 探索/调研（读多个文件回答一个问题、查外部文档、核对现状） | `llmdoc:investigator` 或 `Explore` subagent，后台并行 |
| 界限清晰的实现任务（一个模块/一个文件族，规格已在 Docs 里写死） | `llmdoc:worker` subagent，给它精确的 Proto 章节号与验收命令 |
| 多个互不依赖的 DoD 子任务（如：写单测 + 写另一模块的骨架） | 多个 subagent **同一条消息并行派发**；互相冲突改文件时用 `isolation: worktree` |
| 大批量同构工作（N 个接口的 CLI 子命令、N 个事件类型的编解码、全量 review） | **Workflow**：pipeline/parallel 扇出，schema 收结构化结果 |
| 完成一个 Phase 前的质量关口 | Workflow 跑 "review → 对抗核查" 两段（本项目此前的 5 维评审模式），确认无 BLOCKER/MAJOR 再关门 |
| 单点小改动（改一行配置、修一个测试断言） | 直接自己做，不要为了并行而并行 |

派 subagent 的三个要求：a) prompt 里给**精确的文件路径与 Proto/DOD 章节号**，不给模糊描述；b) 要求返回结构化结论（改了哪些文件、测试命令与结果）；c) subagent 的产出你必须验证（跑一遍它声称通过的命令）后才算数。

## 4. 验证：每轮的通过标准

一轮结束前，按序执行并全部满足：

1. **本项验证**：目标 DoD 项对应的测试/命令通过（单测新增的先看它红过——test-first 或至少确认测试真的在测东西）。
2. **回归**：`pnpm verify` 全绿（typecheck + lint + unit + integration）。此前 Phase 的任何测试变红即本轮不合格，先修回归。
3. **契约核对**：本轮新增/修改的接口面与 Proto 对应章节一致；CLI 同步生长（动了接口就同轮交付/更新对应 `watt` 子命令，DOD §0）；**造轮子自查**——本轮若新写了 >100 行不依赖任何框架的基础设施代码，回头对照 §0 纪律 4 的表，确认没有现成方案可替代。
4. **真实环境**（涉及部署的项）：`pnpm deploy:all` + `scripts/smoke.ts` 或对应 `watt` 命令在 `WATT_BASE_URL` 上验证。
5. **证据入账**：把勾选依据（命令 + 输出摘要）写进 PROGRESS.md，同步勾选 DOD 复选框。

## 5. 收尾：主动沉淀（每轮必做，不是可选项）

完成（或阻塞）本轮任务后，**主动更新 llmdoc**：

1. **每轮**：更新 `PROGRESS.md`（做了什么、勾了什么、证据、遗留）。
2. **产生了durable knowledge 时**（新模块的结构、非显然的实现决策、外部服务的坑——如"custom provider 要加 custom- 前缀"这类）：运行 `/llmdoc:update`，让 recorder 把它写进稳定文档/`memory/decisions/`；不要堆在 PROGRESS.md 里。
3. **踩了流程坑时**（subagent 用法不当、验证顺序错了、误判过一次完成）：派 `llmdoc:reflector` 写一条 reflection 到 `memory/reflections/`——这是防止下一轮重蹈覆辙的唯一机制。
4. **Phase 关门时**（该 Phase 全部 DoD 勾完）：a) 重跑该 Phase 全部 DoD 命令 + 全量回归，证据入 PROGRESS.md；b) 跑一次 §3 的质量关口 Workflow；c) 运行 `/llmdoc:update` 做一次该 Phase 的整体知识沉淀；d) 回查 Docs 与实现的漂移，有漂移先修 Docs。

## 6. 单轮输出格式（写在 PROGRESS.md 末尾追加区）

```markdown
## Round <N> — <日期>
- 目标：<Phase X / DoD 项原文>
- 动作：<实现摘要；派发的 subagent/workflow 及其结论>
- 验证：<命令 → 结果>（逐条）
- 勾选：<勾掉的 DOD 项 / 无>
- 沉淀：<llmdoc 更新了什么 / reflection 记了什么 / 无>
- 遗留：<blocker 或下一轮建议起点>
```
