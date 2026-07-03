# 决策：taskId 即 Workflows instanceId（免映射表）

> 2026-07-03（Round 20，Phase 5 Task/M7）。

## 决定

TaskManager.Write 生成 taskId 后，直接以它作为 Cloudflare Workflows 的实例 id 创建：
`env.WATT_TASK.create({ id: taskId, params })`。Signal / Cancel 经 `env.WATT_TASK.get(taskId)`
直取实例——**不维护 taskId↔instanceId 映射表**。

## 为什么

- Workflows 的 `create({ id })` 接受调用方指定 id，且 `get(id)` 可按 id 直取——平台原语天然支持外部主键，映射表是纯冗余。
- 免掉一张映射表 = 免掉一处写入原子性问题（Write 时"建 task 行 + 建实例 + 写映射"三步的部分失败面收窄为两步）。
- Signal/Cancel/Get 的路径全部单跳：拿 taskId 就能到实例，无需先查表。

## 代价与边界

- taskId 必须满足 Workflows instance id 的字符集/长度约束（当前 UUID 形态天然满足）；若未来 taskId 形态变化需重核。
- Workflows 实例本身不暴露自定义查询——List/Get 的过滤与投影仍靠 TaskStore（watt-events 库 `tasks` 表，migrations-events/0002）；`instance.status()` 仅在 Get 合成时叠加引擎侧执行态。本地 hibernate 时 status 报 running 的坑见 toolchain-pitfalls §41。
- 同 id 重复 create 会撞实例已存在——Write 侧以 taskId 唯一生成保证不重入。

真源：`packages/gateway/src/task/watt-task-workflow.ts` 文件头 + `migrations-events/0002_task_store.sql` 归属说明；doc-gaps #29①。

相关：[[scheduler-script-runner]]（同 Phase 的 Scheduler 侧决策）。
