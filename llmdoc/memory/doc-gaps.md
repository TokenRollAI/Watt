# 文档缺口

记录已知缺口及关闭条件。由 `recorder` 在非平凡更新时核对。

## 1. guides/ 为空

- 缺口：项目尚无已固化的可重复工作流，guides/ 暂无文档。
- 关闭条件：出现第一个重复执行过的工作流（如"新增 protocol schema 并补测试"或"新建 package 的标准步骤"）后写入对应 guide。

## 2. docs/ 与代码的权威同步机制未定

- 缺口：docs/ 当前是设计权威，但实现展开后"docs 先行还是代码先行"未定，可能出现静默偏离。
- 关闭条件：确立同步规则（如"协议变更必须先改 docs/protocol-v1.md 再改代码"或反向），记入 decisions/ 并更新 must/project-basics.md。

## 3. 无 CI / lint

- 缺口：质量门只有本地 `pnpm test` / `pnpm typecheck`，无 CI 强制，无 lint 配置。
- 关闭条件：CI 接入（或显式决策不做）后更新 must/project-basics.md 的质量门描述。

## 4. plan-script 与 runtime-core 实现后需补 architecture 文档

- 缺口：`packages/plan-script`（QuickJS 封装 + 静态校验 + journal 重放）与 `packages/runtime-core`（turn loop + DeepSeek 薄模型层）是下一步路线，实现后 architecture/ 只有 execution-model.md 一篇不够。
- 关闭条件：两包落地后分别补 architecture 文档（解释器边界与重放实现、turn loop 与 finish/give_up 实现），并同步 index.md 与 reference/。
