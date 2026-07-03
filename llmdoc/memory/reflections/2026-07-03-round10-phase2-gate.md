# Round 10 — Phase 2 关门轮（并行修复交叉污染 + 评审维度裁剪的流程反思）

## Task
- 质量关口 Workflow（4 维 review + 对抗核查,19 agents）确认的 15 MAJOR 按主题拆 4 个 worker 并行修复,主 assistant 收口 + DoD 线上重跑,Phase 2 正式关门。

## Expected vs Actual
- 预期：4 个 worker 各自文件集内闭环,typecheck/测试独立可验证。
- 实际：全部修复成功关门,但共享工作树并行导致 worker 间在途半成品互相污染验证信号;线上冒烟中途 token 过期 + 代理环境脚本坑各浪费一次排查。

## What Went Wrong
- **并行 worker 交叉污染**：4 个 worker 共享同一工作树,worker A 的在途半成品（consumer.ts 扩 ConsumerDeps/import zod 未完成）让 worker B/C 的 typecheck 和 gateway 测试全红。B/C 被迫自救：用 `git worktree` 隔离验证、用 `git show HEAD:<file>` 判断报错归属是自己还是他人在途改动。
- **注释把错误设计写成正确意图**：CLI tail 的"+1ms 避免重复"注释本身就是 bug 成因（跳过同毫秒事件）,审阅时被注释描述带偏;配合一条死测试（守卫条件恒假、断言永不执行）把 bug 锁进了绿灯。
- **token 有效期撞上长关门轮**：admin token 1h 过期,关门轮跨多小时,线上冒烟中途 401——重签即可,但 sign-admin-token.mjs 在代理环境需 `NODE_USE_ENV_PROXY=1`,不知道这点浪费了一次排查。

## Root Cause
- 文件集"互不冲突"只保证了**写入不冲突**,没保证**验证信号不污染**——类型契约耦合（一人扩接口、另一人的测试要消费该接口）使共享工作树下的 typecheck/测试红灯无法归属。
- review 测试时默认"断言存在即有检测力",没有先问"这个断言有没有可能永不执行"（守卫条件、桩的抛错时机都可能让断言死掉）;注释被当作意图真源而非嫌疑对象。
- 长流程未预检 token 剩余有效期;Node 20+ fetch 不读 env 代理变量这一事实未进任何 guide。

## What Worked（保持）
- **评审维度裁剪不降质**：按用户要求去掉渗透性安全维（避免模型拒答）,4 维（correctness/contract/ops/test-quality）+ "常规工程质量问题照常报"的措辞足够——15 MAJOR 全部确认、0 误报,质量未因裁维下降。phase-gate guide 已同步改 4 维。
- **对抗核查连续三个 Phase 误报率 0**（Round 3 / 7 / 10 全数确认成立）：说明 review agent 的 finding 证据链质量高（带 file:line + 规范原文）。对抗核查的价值已不在滤误报,而在**修正严重度 + 产出修复所需的完整代码事实链**——保留它,但预期要调整。
- **worker 自救手段可复用**：git worktree 隔离验证 + `git show HEAD:<file>` 判错误归属,应写进并行派发的 prompt 模板。

## Missing Docs or Signals
- 缺派发规则：并行 worker 的文件集之间若存在**类型契约耦合**,要么划进同一 worker,要么 prompt 里明示"你的 typecheck/测试可能因他人在途改动而红,以隔离验证（git worktree）为准"。
- 缺收口规则：主 assistant 收口时统一跑 verify 收敛格式（biome --write）与残留,而非依赖各 worker 自扫。
- 缺 review 检查项：审测试先问"断言有没有可能永不执行";注释与实现矛盾时以实现行为为准,注释本身可能是 bug 的书面化。
- 缺工具链事实：sign-admin-token.mjs（Node fetch）在代理环境需 `NODE_USE_ENV_PROXY=1`;admin token 1h 有效期,长流程中途需预备重签。

## Promotion Candidates
- `guides/phase-gate-workflow.md`（并行修复章节）：① 类型契约耦合的文件集划分规则;② prompt 明示"红灯可能来自他人在途改动,以 git worktree 隔离验证为准";③ 主 assistant 收口统一 biome --write + verify。
- `guides/phase-gate-workflow.md`（评审章节）：4 维裁剪的实测结论（0 误报、质量不降）已改,补"对抗核查价值 = 修严重度 + 补证据链,非滤误报"。
- `guides/toolchain-pitfalls.md`：`NODE_USE_ENV_PROXY=1` 代理坑;admin token 1h 有效期与长流程重签。
- review 检查项（并入 phase-gate 的 review prompt 模板）："死测试探测——守卫恒假/桩抛错时机使断言永不执行"。

## Follow-up
- 下次并行派发前：按类型契约耦合（不只是写入冲突）划文件集;prompt 模板加隔离验证条款。
- 请 recorder 把 NODE_USE_ENV_PROXY / token 有效期两条落进 toolchain-pitfalls。
