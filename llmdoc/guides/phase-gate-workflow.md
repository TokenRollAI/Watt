# Phase 关门标准流程（Phase Gate Workflow)

> 适用场景：某 Phase 的 DoD 全部勾选后，正式宣布该 Phase 关门之前。实测：Phase 0 关门（2026-07-02 Round 3）、Phase 1 关门（2026-07-02 Round 7），证据见 `PROGRESS.md` 对应轮次。

## 流程五步

### ① 重跑全部 DoD 命令，记证据

- 该 Phase 在 `DOD.md` 中的**每一条** DoD 命令都要在关门轮重新跑一遍（不吃历史证据）。
- 主 assistant 亲自跑，每条记一行结果（命令 + exit code / 关键输出），入 `PROGRESS.md` 关门轮。

### ② 质量关口 Workflow：4 维 review → 对抗核查

- **4 维并行 review**：correctness / contract（与 Proto 契约一致性） / ops / test-quality，各维独立派 review agent（Phase 0/1 曾含渗透性安全维度共 5 维，Round 10 起按用户指示去掉该维度）。
- **逐条对抗核查**：每条 BLOCKER/MAJOR finding 再派一个核查 agent，prompt 要求**"先假设这是误报去求证"**——拿着 finding 去读源码/规范原文，只有证伪失败才确认成立。
- MINOR 不阻塞关门，记入 backlog（PROGRESS 遗留节）。

### ③ 确认项全修 + 复核

- 确认成立的 BLOCKER/MAJOR **全部修复**后才能关门。
- 修复后主 assistant **亲自重跑**受影响的验证命令（verify / deploy / curl 等），不信任 worker 自报。

### ④ Docs 漂移回查（宪法优先）

- review 中发现的规范缺口/矛盾/实现与规范的偏差，先修 `Docs/` 再改实现（宪法优先）。
- 同步闭环 `llmdoc/memory/doc-gaps.md` 对应条目状态。
- Phase 0 实例：修了 Proto §0.2（401/501 规范性补充）、§6.4c（引用错位 + cron 系统段规则）、Architecture 附B（watt- 前缀实名）。

### ⑤ PROGRESS 入账 + llmdoc 沉淀

- `PROGRESS.md` 写关门轮记录：DoD 重跑证据、finding 清单与修复、Docs 回写、MINOR 遗留。
- 触发 llmdoc 沉淀：更新 `must/current-state.md`（阶段翻页 + 关门证据摘要）、相关 reference/guides、`memory/decisions/` 新决策。

## 实测经验（Phase 0，2026-07-02）

- 5 维并行 + 逐条对抗核查**有效滤掉误报**：共 12 个 agents，7 条 MAJOR 对抗核查后 7/7 确认成立（评审期间另有 1 条 501 码问题已先行解决）。
- 对抗核查 prompt 的关键措辞是要求核查者**先假设误报去求证**，避免核查者顺着原 finding 的叙事确认偏误。
- 关门轮不做新功能，只做重跑、修复、回写三类动作。

## 实测经验（Phase 1，2026-07-02 Round 7）

- **确认项修复可并行**：按"互不冲突的文件集"把修复拆给多个 worker（本轮 4 个）并行执行，主 assistant 复核 diff 并收口。
- **跨包契约改动派发时必须列全消费方**：gateway List 返回形状变更（→ `{items}`）时漏列了 CLI 消费方 `cli/audit.ts`——worker 无权限修界外文件，且 CLI 侧测试 mock 掩盖了错配，只能靠主 assistant 收口时发现。拆任务时对每个契约变更显式枚举所有消费方（含测试 mock），要么划进同一 worker 的文件集，要么明确留给主 assistant 收口。
- **关门轮 DoD 重跑可结合线上全链**：Phase 1 用真实部署跑通 device flow 全链（login → approve → whoami）作为 DoD 项 3 的关门证据，比只跑单测更硬。
