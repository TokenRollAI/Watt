# Round 13 — Phase 3 关门轮（宽容解析养漂移 + finding 聚类找共同根因）

## Task
- Phase 3 关门：质量关口 Workflow（4 维 review + 对抗核查,20 agents）确认 16 MAJOR（去重后 9 个独立问题）,2 worker 文件集互斥并行全修,DoD 线上复验后正式关门。

## Expected vs Actual
- 预期：Round 12 冒烟修完三个跨包错配后,CLI↔gateway 形状已对齐。
- 实际：关门评审又揪出第四个（CLI put/patch 解包 `{entry}` 但服务端返 `{meta}`）——冒烟时"人类模式回退字符串"的双形态兜底恰好掩盖;另发现 vector provider 三条独立 MAJOR 同根,需架构级修复而非三个补丁。

## What Went Wrong
- **"mock 全绿线上坏"四连击**：Phase 3 冒烟揪出三个跨包错配（contentType 必填缺省 / cat 未解包 `{entry}` / R2 list 缺 include customMetadata）,关门评审补第四个（put/patch 解 `{entry}` vs 服务端返 `{meta}`）。前三个靠线上全链暴露,第四个连线上冒烟都没暴露——因为 CLI 写了"两种形状都能解"的兜底,解不到就回退字符串,人类模式下输出看着正常。
- **架构级 finding 被报成三个独立问题**：vector provider 的 2048 截断丢数据 / List unavailable 违反 §4.1 / Vectorize 最终一致使 read-after-write 不可靠,评审报为三条 MAJOR;实际同一根因——**权威数据放错了存储层**（全文/version/metadata 塞进 Vectorize）。对症是一个架构动作"D1 sidecar"（权威数据入 DB_CONTEXT,Vectorize 只存 embedding+引用）,一举修三条,还顺带解锁 metadata-only Update 不重算 embedding。
- **worker 空转**：p3-providers（Round 12）idle 时源文件已就位但测试未写,若按 idle 即收口会漏验收。主 assistant 用 SendMessage 补要求"验收命令跑绿再报告"后完成。

## Root Cause
- **"宽容解析"是漂移的温床**：双形态兜底把契约错配从"第一次运行就炸"推迟到"静默产出错误结果"。mock 各写各的挡不住错配（Phase 1/2 已知）,而兜底连线上冒烟这道最后防线也废掉了——解不到就应报错。
- 评审 agent 逐文件/逐维度产 finding,天然倾向报症状不报病灶;三条症状共享根因时,逐条打补丁会把错误架构固化。
- worker 的 idle 状态与"完成"没有必然联系;派发 prompt 中验收指令埋在中部,不够醒目。

## What Worked（保持）
- **对抗核查连续四个 Phase 误报率 0**（Round 3/7/10/13）：关键在 review agent 的证据链质量（file:line + 规范原文）。核查的价值稳定在三件事：修正严重度、补足修复所需代码事实、识别"已声明的实现自由"（非 bug）——本轮核查 prompt 新加了 doc-gaps 台账比对指令,有效滤掉了已声明项。
- **finding 聚类→找共同根因→再决定补丁还是重构**：vector 三条聚类后一个 D1 sidecar 动作全消,新增 36 测试;若逐条补丁只会在错误的存储层上叠创可贴。
- **根治纪律已落地**（pitfalls §34）：响应形状唯一真源 = gateway 路由测试锁定的形状（Get→`{entry}`、Write/Update→`{meta}`、List→裸 Page）;CLI mock 照抄真源并在文件头声明出处;禁双形态兜底。本轮修复即按此执行（删兜底、mock 全对齐、补 headers 断言）。

## Missing Docs or Signals
- 缺元规则成文：**宽容解析（fallback/双形态/静默回退）是契约漂移的温床——解析失败就报错,让错配在第一次运行就炸**。§34 记了具体纪律,元规则本身适用于所有跨包边界（不只 CLI↔gateway）。
- 缺评审收口步骤：对抗核查确认后、派发修复前,先做 finding 聚类找共同根因,再决定补丁 vs 重构。
- 缺派发规则："验收命令跑绿再报告,idle≠done"要放 prompt 末尾显眼处;主 assistant 见 worker idle 先核对验收产物再收口。

## Promotion Candidates
- `must/loop-contract.md` 或 `guides/phase-gate-workflow.md`：元规则"解析失败就报错,禁宽容兜底"（§34 是其在 CLI↔gateway 的实例）。
- `guides/phase-gate-workflow.md`（评审章节）：① 修复派发前先聚类 finding 找共同根因;② 核查 prompt 保留 doc-gaps 比对指令（本轮实测有效）。
- worker 派发 prompt 模板：验收指令置于末尾显眼处 + "idle≠done,跑绿验收命令再报告"。

## Follow-up
- 请 recorder 把"聚类找根因"与"验收指令置尾"两条并入 phase-gate guide 的评审/派发章节。
- 下次跨包消费面新增时:CLI 侧先抄 gateway 路由测试的响应 fixture,再写解析代码——顺序颠倒就是本轮四连击的起点。
