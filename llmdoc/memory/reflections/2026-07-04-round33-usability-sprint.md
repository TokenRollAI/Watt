# Round 33 — 可用性冲刺（六期并行 worktree 纪律 + 实测逼出的架构修正）

## Task
- 用户四痛点驱动的六期并行冲刺：P1 飞书 plugin 化、P2 HTBP 工具注入、P3 SecretStore、P4 CLI npm 化、P5 `watt init` 向导、P6 dashboard 配置页。4 个 worker worktree 并行（3 批次流水），主 assistant 只做合并/冲突/部署/线上验证；最终飞书真实群 @watt 闭环采证（Phase 6 ② 关门）。

## Expected vs Actual
- 预期：六期各自 worktree 内闭环，单测全绿即可合并部署。
- 实际：六期全落地且 `pnpm verify` 1233 全绿，但——① P1/P2 基线漂移险些在旧代码上开工；② 线上实测（真实主体 + 真实链路）逼出三个单测全绿盖不住的架构修正；③ 两条外部环境硬事实（workers.dev 同账户互调被拦、境内被干扰）只有部署后线上失败才暴露。

## What Went Wrong
- **worktree 基线漂移**：P1/P2 两个 worktree 都从 f71d8cc（Phase 5 时代）切出，而 main 已在 Phase 7 关门之后。P2 自查发现并自愈（ff 到 main）；P1 是主 assistant 收到 P2 报告后主动 SendMessage 预警才纠正。若未发现，两期会在缺失两个 Phase 改动的基线上开发。
- **单测全绿 ≠ 可用——三个实测逼出的架构修正**：
  1. 终止实例后 session 永久死锁：terminated 行挡住重生，同 session 再也拉不起实例 → 增补 **re-Spawn 复活语义**（Proto §3.2）。
  2. Authorizer 恒传空 agentDefs（Phase 1 残留）→ 一切 agent 主体在判定步骤 2 被误拒。关键信号早就存在：**lurker 出站当初为绕它直调 core**——绕道本身是坏味道标记，当时没系统性收口，债务一直潜伏到本轮真实主体全链过 PEP 才炸。
  3. policy `tool://test/*` 不匹配根路径 `tool://test`（~help 根即列表语义）→ 通配语义修正。
- **外部环境事实两次靠线上失败才定**：同账户 workers.dev 互调被平台拦截（收 404，无文档直说）；workers.dev 境内被干扰（飞书回调 3s 握手超时，**用户截图反馈才暴露**）。两次都发生在部署后。
- **token 生命周期未纳入长回合计划**：admin token 1h 中途过期，且轮换连坐 pluginToken（重签 admin 会吊销 plugin 主体），排查/重签打断流水。
- **零散返工**：`git add -A` 在含 ignored 嵌套仓库的目录把 worktree 当 embedded repo 收进 index（需 `git rm --cached` 补救）；@feishu/@llm 真实资源验证在多问题连环排查中超出"每轮每 tag 一次"预算。

## Root Cause
- worktree 创建时默认"当前 HEAD 即最新"，派发 prompt 没有基线自检指令——漂移只能靠 worker 自觉或事后发现。
- 平台层判定链的历史 workaround（绕 Authorizer 直调 core）从未被登记为债务：绕道消除了症状也消除了报警信号，直到新调用方走正路才复现。
- 线上验证长期只走 happy path + 管理员主体，"真实主体（agent/plugin token）+ 真实链路（PEP 全链）"没有进入常规验证面；外部平台行为（互调拦截、境内可达性）无文档可查，只能实测。
- 长回合规划只排任务批次，没排凭据生命周期。

## What Worked（保持）
- **3 批次流水 + 文件所有权互斥清单写进 prompt**：六期冲突全部是"两侧新增同位置"型（union 保留即解），零语义冲突——所有权划分有效。
- **主 assistant 角色收敛**：只做合并/冲突/部署/线上验证，不下场写码，六期节奏未互相阻塞。
- **P3~P6 的基线自检指令**：吸取 P1/P2 教训后，派发 prompt 内置「首步 `git rev-parse HEAD` 对照 main」，四期全部顺利——同轮内闭环验证了该指令有效。
- **跨 agent 即时横向广播**：P2 报告漂移后主 assistant 立刻 SendMessage 预警 P1，把一个 agent 的坑变成全体的免疫。
- **用户侧回环是不可替代的验证面**：境内可达性问题任何自动化探测（本机在代理后）都测不出，用户截图是唯一暴露渠道。

## Missing Docs or Signals
- 缺派发规则：worktree 派发 prompt 必须内置基线自检首步（rev-parse 对照 main，不一致先 ff/rebase 再开工）。
- 缺债务纪律：**"绕过平台层"的 workaround 是债务标记，见到就开票**（backlog/doc-gaps），不许只留在代码注释里。
- 缺部署前检查清单条目：跨 worker 调用形态（同账户 workers.dev 互调被拦 → 用 service binding）与境内可达性（workers.dev 被干扰 → 自定义域名）。
- 缺长回合规划项：开局盘点凭据有效期（admin token 1h + 轮换连坐 pluginToken），预排重签点。
- 缺 git 事实：含 ignored 嵌套仓库时 `git add -A` 的 embedded repo 陷阱。
- 缺预算声明惯例：真实资源验证（@feishu/@llm）在排查型场景多次触发可接受，但需在 PROGRESS 声明超额原因。

## Promotion Candidates
- `guides/`（并行派发相关，或 phase-gate-workflow 的派发模板）：① worktree 基线自检首步指令；② 跨 agent 坑即时横向广播；③ 文件所有权互斥清单 + 主 assistant 只做合并/部署/验证的分工模式（本轮实证零语义冲突）。
- `must/loop-contract.md` 或 `guides/`：**绕过平台层的 workaround = 债务开票义务**；线上验证须覆盖"真实主体 + 真实链路"而非仅管理员 happy path。
- `reference/external-facts.md`：同账户 workers.dev 互调被拦（用 service binding）；workers.dev 境内被干扰（自定义域名，Universal SSL 只盖一级）——两条已属稳定外部事实。
- `guides/toolchain-pitfalls.md`：`git add -A` 嵌套仓库坑；长回合开局盘点 token 生命周期（1h + 轮换连坐 pluginToken）。

## Follow-up
- 把「基线自检首步」固化进并行派发 prompt 模板（本轮 P3~P6 文本可直接复用）。
- 对现存平台层绕道做一次 grep 盘点（已知：lurker 出站绕道本轮保留），逐条开票进 backlog。
- 部署前检查清单增补两条环境事实条目；请 recorder 按上述 Promotion Candidates 落稳定文档。
- R33 MINOR backlog 跟进时优先处理 admin token 短命/轮换连坐的运维摩擦（init 的 7d token 或独立 plugin 签名面）。
