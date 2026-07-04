# Round 34 — 维护轮：飞书群 agent 工具链路修复（运行时数据推断被证伪 + 两关授权一次修双侧）

## Task
- 用户截图报障：真实飞书群 @watt 用工具取 uuid 失败——先「"test" 工具树 permission denied」后「503」。主 assistant 派 investigator 出报告（`.llmdoc-tmp/investigations/agent-htbp-test-tree-denied.md`），随后线上修复（零代码改动，全部是策略/def/挂载配置）+ 真实群端到端验证通过。

## Expected vs Actual
- 预期：调查报告定位根因 → 按报告一次修复 → 注入验证即绿。
- 实际：报告的**代码路径结论全部正确**（deny 在 §6.4c 步骤 1、503 是 httpbin 桩经 toolbridge 兜 500），但**两处运行时数据推断被实测证伪**；第一次修复后真实验证暴露第二层拒绝（`agent definition grant exceeded`），补 grants 后第二次注入才闭环（真 uuid 投递进飞书群）。

## What Went Wrong
- **investigator 把运行时数据推断写成了结论（两处证伪）**：
  1. 报告断言线上 def 有 `grants: tool://*`（依据是源码种子 `LURKER_SCRIBE_DEF`）——实际线上 def grants 只有 `event://*` write，源码种子≠线上现状。教训→**源码种子只能证明「初始值」，不能证明「现值」**；线上 def/policy/mount 全是 D1/KV/DO 运行时数据，报告里必须归入「Gaps/未验证」而非结论（本报告对 test 树 mount 恰好做对了，对 def grants 没做到——同一报告内双标）。
  2. 报告由 deny 文案措辞反推「test 已在 toolScopes 内（前缀过了）」——实际线上 def `toolScopes` 已被某次 def 整体 Write 冲回 `[]`，只是**运行中实例的旧快照**还留着 test。教训→文案推断只能证明「本次请求走到了哪个分支」，不能证明持久化配置的现值；且 spawn 快照语义（R33 已知：实例快照不追随 def）意味着「实例行为」与「def 现值」本就允许不一致。
- **主 assistant 复用报告前未对运行时断言实查**：`watt agent get lurker/scribe` 一条命令就能同时证伪上述两处（grants 与 toolScopes），成本秒级，却在第一次修复后才靠线上真实回复暴露。教训→**报告里凡是「线上态」断言，动手修复前先 CLI 实查一遍**（agent get / policy list / tool get），把「读报告」和「查现场」当两个必做步骤。
- **「修一层就宣布修好」的诱惑**：§6.4c 是两关判定（步骤 1 principal policy + 步骤 2 def grants），步骤 1 先拦时步骤 2 的缺口完全不可见。第一次只补了 policy，若当时直接宣布修复完成，用户下次 @watt 仍会失败。教训→**两关（多关）授权模型的修复必须一次盘双侧**：补 policy 的同时核对 def grants（以及 toolScopes 前缀约束），三个闸门逐一对照后再验证。
- **CLI `--json` 位置错误导致 60s 空转误判**：`watt event tail ... --json` 尾部的 `--json` 被忽略（它是全局选项，必须放子命令前：`watt --json event tail ...`），轮询解析不到 JSON 输出，空转 60s 一度误判「无出站」。教训→全局选项前置是本 CLI 的硬语法；轮询类验证若首轮就零输出，先怀疑命令形状再怀疑系统。

## Root Cause
- 调查报告体例没有强制区分两类事实：**代码路径事实**（源码可证，静态可靠）vs **运行时数据事实**（线上 D1/KV/DO 态，源码取不到）。investigator 无线上凭据时，后者只能是假设，但报告语气未降级。
- 真实路径（agent 主体全链过 PEP）此前只在 R33 末尾走通过一次，两关授权的「另一关被前一关遮蔽」特性没有形成修复 checklist。
- def 整体 Write 覆盖语义（`setup feishu`/`e2e-3` 会把部署侧 toolScopes/grants 冲回默认）是本轮 toolScopes 漂移的源头——幂等脚本的子步骤有破坏性副作用，此前无警示。

## What Worked（保持）
- **真实路径验证 loop**：API 注入 @消息到真实群（非 admin 旁路）是唯一能证明 agent 主体授权的手段——第一次验证「失败」本身就是产出（暴露第二层拒绝）。admin 路径 `watt tool call` 只证明了 503 侧修复（挂载换 httpbingo），对授权侧零证明力（admin 种子策略 allow-all）。
- **轮换连坐的最小面处理**：admin token 过期 → `--rotate` 连坐 pluginToken；本轮**没有**重跑完整 `watt setup feishu`（其第③步 def Write 会冲掉刚修好的 toolScopes/grants），而是单跑 `watt plugin register channel-feishu` 重签 + 重 put secret。教训（正面）→幂等编排脚本的子步骤有副作用时，运维修复只跑需要的那一步。
- 报告的代码路径部分（文件/行号索引、两关判定顺序、503 透传形状）修复时全程直接复用，零返工——**「源码可证」的部分 investigator 是可靠的**，问题只出在越界推断。

## Missing Docs or Signals
- 缺 investigator 报告体例约束：运行时数据断言必须显式标注「未验证」并给出验证命令（如 `watt agent get`），不得以源码种子代替线上现值。
- 缺修复 checklist：两关授权类 deny 的修复项 =「policy + def grants + toolScopes 三闸门同轮核对」+「真实主体路径验证」。
- 缺运维警示：`setup feishu`/`e2e-3` 的 def 整体 Write 会冲掉部署侧 toolScopes/grants（PROGRESS 已记遗留：建议 merge 语义或文档警示）。
- 缺 CLI 事实：`--json` 是全局选项须前置（pitfalls 已有 `--json banner 污染`条目，可就近增补位置语义）。

## Promotion Candidates
- `guides/`（investigator 派发模板或调查报告体例）：**报告须两栏事实——代码路径事实（行号可证）/运行时数据事实（标未验证+附验证命令）**；主 assistant 复用前对后者逐条 CLI 实查。
- `guides/` 或 `must/loop-contract.md`：多关授权修复纪律——修一关必核对全部关；验证必走真实主体路径（admin 旁路对授权修复零证明力）。
- `guides/toolchain-pitfalls.md`：① CLI 全局选项 `--json` 必须置于子命令前，尾部被忽略（轮询零输出先查命令形状）；② `setup feishu` 等编排脚本的 def Write 是整体覆盖，会冲掉部署侧 toolScopes/grants——运维修复只单跑所需子步骤（`watt plugin register`）。
- `reference/` 或 architecture：agent 工具访问三闸门模型（toolScopes 前缀约束 → §6.4c 步骤 1 policy → 步骤 2 def grants）+ spawn 快照不追随 def 的排障含义（实例行为≠def 现值）。

## Follow-up
- 真人在群里 @watt 一条，验证入站 webhook 的新 pluginToken（本轮注入走 admin Publish 旁路，入站面未采证——PROGRESS 已记遗留）。
- 请 recorder 按 Promotion Candidates 落稳定文档；investigator 派发 prompt 增加「运行时断言标注未验证」硬性条款。
- 后续给 `watt setup feishu` 的 def 步骤加 merge 语义或 `--skip-def` 旗标（R34 遗留）。
