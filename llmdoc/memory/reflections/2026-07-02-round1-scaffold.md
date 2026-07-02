# Round 1 — Phase 0 monorepo 骨架搭建（worker 派发流程反思）

## Task
- 主 assistant 派 `llmdoc:worker` 完成 Phase 0 monorepo 骨架（DoD 项），一轮闭环成功。

## Expected vs Actual
- 预期：worker 按 prompt 完成骨架并通过验收命令。
- 实际：一次成功；worker 额外主动汇报了一处契约偏离（占位错误码 501/unimplemented 超出 Proto §0.2 的 7 码集合），未悄悄糊过去。

## What Went Wrong
- 派发 prompt 本身"违宪"：主 assistant 在任务指令中指定的占位错误码（unimplemented/501）与 Proto §0.2 错误码集合冲突。靠 worker 主动汇报才暴露，而非派发前拦截。
- 环境损耗（一句话摘要，细节见 [../../guides/toolchain-pitfalls.md](../../guides/toolchain-pitfalls.md)）：npm registry 超时与 pnpm build 门禁消耗 worker 大量轮次。

## Root Cause
- 派发前只核对了 DoD 与验收命令，未把 prompt 中出现的契约细节（错误码、事件名等）对照 [../../reference/proto-map.md](../../reference/proto-map.md) 快查一遍——默认"指令即正确"，但指令与 Docs 同样可能冲突。

## Missing Docs or Signals
- 缺一条派发前检查规则："给 worker 的指令中所有契约细节须先过 proto-map 自查"。
- 缺工具链踩坑 guide（新 CF 依赖 / npm registry / pnpm 门禁），本轮已确认需要 `guides/toolchain-pitfalls.md`。

## What Worked（保持）
- **高约束 prompt 模板**：写死「精确 DoD 项原文 + 选型约束表 + 验收命令」三件套，worker 一轮闭环。
- **Reflection Handoff 段落**：worker 结构化汇报契约偏离而非静默妥协——应作为后续派 worker 的模板必备要求。
- **不信任声称的绿**：主 assistant 亲自重跑 `pnpm verify`（LOOP §3 要求），本次与 worker 汇报一致；成本低，每轮保持。

## Promotion Candidates
- `guides/`（新建 dispatch-worker 指南或并入现有派发章节）：worker prompt 三件套 + 要求 Reflection Handoff 段落。
- `must/loop-contract.md` 五步流程第 3 步补一句：派发前对照 proto-map 自查指令中的契约细节。
- `guides/toolchain-pitfalls.md`：npm registry 超时、pnpm build 门禁、新 CF 依赖前置阅读（细节由 recorder 落盘）。

## Follow-up
- 下轮派 worker 前：prompt 里的错误码/事件名/接口面先过 proto-map；模板中固定要求 Reflection Handoff 段落。
- 请 recorder 落盘 `guides/toolchain-pitfalls.md` 并在 index.md 挂载。
