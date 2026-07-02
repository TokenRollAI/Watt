# 决策/勘误确认：Flue 真身为 withastro/flue

- 日期：2026-07-03（gh 核实；memory 线索最初记录更早）
- 状态：已确认；Docs 回写待办（doc-gaps P1-1）

## 结论

- **Flue = `withastro/flue`**（公开，Apache-2.0，描述 "The sandbox agent framework"，与 Watt 中 Flue 的 sandbox agent harness 定位一致）。
- **`TokenRollAI/flue` 不存在**：`gh search repos flue --owner TokenRollAI` 返回空。
- Docs 原文（`LOOP.md` §0/§2.1、`DOD.md` §6、`Docs/Reference.md`）把 Flue 与 tool-bridge/HTBP 并列归为 TokenRollAI **属勘误**。

## 核实方式

gh CLI 只读核查（账户 `Disdjj`，scopes 含 repo）：

- `withastro/flue`：存在，公开，默认分支 `main`。
- `TokenRollAI/tool-bridge`：存在，**私有**，可访问，默认分支 `main`（LOOP §2.1 "gh 已有访问权"属实）。
- `TokenRollAI/HTBP`：存在，公开。
- `TokenRollAI/flue`：不存在。

## 行动约束

- M4 及 harness 相关轮次 clone/引用 Flue 时一律指向 `withastro/flue`，**勿按 Docs 原文路径操作**。
- Docs 回写（所有 Flue 引用改指 `withastro/flue`）记录在 [../doc-gaps.md](../doc-gaps.md) P1-1，待某轮顺手完成后销账。
