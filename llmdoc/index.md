# llmdoc 全局地图

Watt 项目稳定文档的索引。启动阅读顺序见 [startup.md](startup.md)（此处不重复）。

`.llmdoc-tmp/` 是本地临时调查缓存，不被本索引收录；引用其内容前需先验证日期与 git revision。

## 分类与文档

### must/ —— 每次会话必读的小文档

- [must/project-basics.md](must/project-basics.md)：项目身份、阶段、仓库结构、工具链、质量门。
- [must/core-invariants.md](must/core-invariants.md)：全项目硬不变量（决策 4、Session XOR Run、确定性边界等）。

### overview/ —— 项目身份与边界

- [overview/project-overview.md](overview/project-overview.md)：愿景五承诺、V1 in/out of scope、主要区域。

### architecture/ —— 执行流、所有权边界、不变量成因

- [architecture/execution-model.md](architecture/execution-model.md)：五 fabric、执行模型 5 决策、调度器三件套、runtime 自研执行形状、预算防护、直连会话路径。

### guides/ —— 可重复工作流

- （暂空：项目尚处实现起步期，无已固化的可重复工作流。见 [memory/doc-gaps.md](memory/doc-gaps.md)。）

### reference/ —— 稳定查表事实与契约

- [reference/protocol-contracts.md](reference/protocol-contracts.md)：`packages/protocol` 检索地图——5 个 src 文件、ID 语法表、AgentSpec / ContextPackage / Host API 一览、zod v4 注意点。

### memory/ —— 历史过程记忆

- [memory/decisions/2026-06-12-runtime-and-protocol-decisions.md](memory/decisions/2026-06-12-runtime-and-protocol-decisions.md)：已拍板决策记录（runtime 自研、QuickJS、协议各项定案）。
- [memory/doc-gaps.md](memory/doc-gaps.md)：已知文档缺口与关闭条件。
- memory/reflections/：由 `reflector` 维护（暂空）。

## 路由提示（想知道 X → 读 Y）

| 想知道 | 读 |
| --- | --- |
| Watt 是什么 / 现在做到哪一步 | must/project-basics.md |
| 写代码时绝不能违反什么 | must/core-invariants.md |
| 为什么 DO 不能 await 模型调用 | must/core-invariants.md → architecture/execution-model.md |
| PlanScript 如何执行 / 重放 / 计量 | architecture/execution-model.md |
| Run Coordinator / Script Runner / Dispatcher 各管什么 | architecture/execution-model.md |
| 某个 ID 的语法 / schema 字段 / Host 函数签名 | reference/protocol-contracts.md（完整规范在 `docs/protocol-v1.md`） |
| V1 不做什么 | overview/project-overview.md |
| 某个决策的理由与弃用候选 | memory/decisions/ |
| Flue 调研细节 | `docs/flue-reference.md`（设计权威在 docs/，本文档系统只做指针） |

## 与 docs/ 的关系

`docs/`（vision / architecture / protocol-v1 / flue-reference）是设计权威与完整规范；`llmdoc/` 是其压缩检索层加代码现状地图。两者冲突时以 docs/ 与代码为准，并修正 llmdoc。
