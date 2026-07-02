# Round 7 — Phase 1 关门轮（并行 worker 修复 13 项 finding 的流程反思）

## Task
- 质量关口确认的 13 项 finding（1 BLOCKER + 8 MAJOR + 4 MINOR）按"互不冲突文件集"拆 4 个 worker 并行修复，主 assistant 收口 + DoD 重跑,Phase 1 正式关门。

## Expected vs Actual
- 预期：4 个 worker 各自在授权文件集内闭环,验收命令直接可用。
- 实际：总体顺利关门,但暴露 3 处派发缺陷（验收命令包名错误、跨包消费方遗漏、文件集必然交叉）,均靠 worker 主动上报而非派发前拦截。

## What Went Wrong
- **验收命令包名错误**：主 assistant 下发的命令写了 `@watt/cli`,实际 package.json 的 `name` 是 `watt-cli`。pnpm filter 空匹配 exit 0,会造成假通过——幸被一个 worker 发现上报,主 assistant 随即向其他 worker 广播纠正。
- **跨包契约改动漏列消费方**：gateway List 返回形状 records/cursor→items 的任务只列了 policy.ts 消费方,漏了 cli/audit.ts;负责 worker 无权限修,且 CLI 测试用独立 mock,错配下测试仍绿（线上会 TypeError）。worker 上报"跨界依赖",主 assistant 收口改 audit.ts。
- **授权文件集必然交叉**：seed once-guard 的连带影响使两个 worker 在 gateway/test/device-flow.test.ts 上必然相遇。worker-platform 越界加了一行 `resetSeedGuardForTests()` 并在结论中显式报告不可兼得性——越界但透明,属良性处理。
- **部署后立即断言险些误判**：deploy 后首批 curl 命中旧 isolate（Hono 默认 404 纯文本）,险些判修复无效;等传播窗口后重测全部符合契约。

## Root Cause
- 派发前没有核对 package.json 的 `name` 字段——filter 名是验收命令里的高危细节,空匹配静默成功使错误不可见。
- 改返回形状时只凭记忆列消费方,未 grep 全部消费点;独立 mock 的测试对跨包契约漂移**无检测力**（mock 与实现同步错、测试绿但集成断）。
- 文件集划分假设"互不冲突"总能成立,未给必然连带改动预留出口。

## Missing Docs or Signals
- 缺派发前检查项："验收命令中的 pnpm filter 名须与各 package.json `name` 逐一核对"（空匹配 exit 0 是静默陷阱,可考虑 filter 失配时报错的守护写法）。
- 缺规则："跨包契约（返回形状/字段名）改动派发前必须 grep 全部消费方列入任务"。
- 缺检测手段：跨包契约漂移需要契约测试或共享 fixture,独立 mock 不够。

## What Worked（保持）
- **worker 主动上报越界/跨界而非静默处理**：三次派发缺陷全部由 worker 的 Reflection Handoff 暴露,广播纠正机制有效。
- **越界的透明出口**：worker-platform "有理有据越界 + 显式报告不可兼得性"是正确姿势——边界划分应预留"必然连带改动须显式报告"的出口,而非绝对禁止越界。
- **worker 对评审建议的合理偏离**：占位路由注册在认证中间件之前而非评审建议的 app.notFound（否则 501 被 401 先拦）,worker 说明结构性矛盾并给替代方案,主 assistant 采纳。评审 fix 建议是最小修复参考,不是机械执行的指令。
- **线上断言等传播窗口重测**：deploy 后先等边缘传播/重测两次再下结论,避免误判。

## Promotion Candidates
- 派发 worker 检查清单（并入 dispatch 相关 guide）：① filter 名对照 package.json `name`;② 跨包契约改动先 grep 全部消费方;③ 文件集划分预留"连带改动显式报告"出口。
- `guides/toolchain-pitfalls.md`：pnpm filter 空匹配 exit 0 假通过;deploy 后旧 isolate 传播窗口。
- 测试策略：跨包契约点考虑契约测试或共享 fixture（doc-gap 候选）。

## Follow-up
- 下次跨包契约改动：派发前 grep 消费方全集,或直接由单一 worker 端到端负责该契约。
- worker prompt 模板固化："遇必然连带改动,允许最小越界但必须在结论显式报告"。
