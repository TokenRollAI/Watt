-- Migration 0002: Task 状态存储层（Proto §8 TaskManager / M7 Task 引擎）。
-- 库：watt-events（binding DB_EVENTS）。
--
-- 归属说明：Task 状态表放 watt-events 库（而非新建 D1 库或复用 watt-providers）——理由：
--   ① Task 生命周期与 Event Gateway 紧耦合：进 waiting_human 时 Publish task.checkpoint、
--      恢复经 im.action → Signal（§1.1 闭环），consumer 侧 TaskSignaler 也读 Task 状态判定可信号性；
--   ② watt-providers 是"可挂载能力提供方"簇（tool/agent/model registry，静态定义），Task 是运行时
--      执行实例（动态状态），语义不同簇；
--   ③ 避免为单一状态表新增独立 D1 库（多库拆分决策见 memory/decisions/resource-naming-and-provision.md）。
--   与 events/channels 表以表名隔离，互不干扰。
--
-- taskId 即 Workflows instance id（实现声明）：TaskManager.Write 时 env.WATT_TASK.create({id: taskId})，
--   Signal/Cancel 经 env.WATT_TASK.get(taskId) 直接取实例——免维护 taskId↔instanceId 映射表。
--   本表存 TaskInfo 元数据 + TaskDetail 的 steps/pendingCheckpoint/artifacts（Workflows 实例本身不暴露
--   自定义查询，List/Get 的过滤与投影靠此表；instance.status() 仅合成 Get 时的引擎侧状态）。
--
-- tasks：TaskInfo（§8 L806-815）+ TaskDetail 扩展（§8 L817-825）的持久化面。
--   state = pending|running|waiting_human|waiting_event|done|failed|cancelled（7 态，core taskStateSchema）；
--   steps_json / artifacts_json：TaskDetail.steps[] / artifacts[]（JSON 数组字符串，Workflow step 写）；
--   pending_checkpoint_json：waiting_human 时的 { checkpoint, prompt, requestedAt }（可空，非 waiting_human 清空）。

CREATE TABLE IF NOT EXISTS tasks (
  task_id                 TEXT PRIMARY KEY,   -- = Workflows instance id
  definition              TEXT NOT NULL,      -- 不透明引用（当前 = 已部署模板名）
  state                   TEXT NOT NULL,      -- 7 态
  current_step            TEXT,               -- TaskInfo.currentStep（可空）
  note                    TEXT,               -- Update 补的元信息（可空）
  created_by              TEXT NOT NULL,      -- PrincipalRef（principal 字符串）
  created_at              TEXT NOT NULL,      -- ISO8601
  updated_at              TEXT NOT NULL,      -- ISO8601
  steps_json              TEXT NOT NULL DEFAULT '[]',   -- TaskDetail.steps[] JSON
  pending_checkpoint_json TEXT,               -- waiting_human 时的 pendingCheckpoint JSON（可空）
  artifacts_json          TEXT NOT NULL DEFAULT '[]'    -- TaskDetail.artifacts[] JSON（URI[]）
);

CREATE INDEX IF NOT EXISTS idx_tasks_state      ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_definition ON tasks(definition);
CREATE INDEX IF NOT EXISTS idx_tasks_created    ON tasks(created_at);
