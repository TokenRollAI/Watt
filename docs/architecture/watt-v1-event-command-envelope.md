# Watt V1.0 Event / Command Envelope

## 1. 文档目的

本文档定义 Watt V1 阶段统一的 `EventEnvelope` 和 `CommandEnvelope`。

目标是解决三个问题：

- 所有模块之间如何交换事实与意图
- Event Log 和 Command 处理链路的最小公共 schema 是什么
- 幂等、顺序、因果关联如何在信封层表达

## 2. 设计原则

### 2.1 Event 表达事实，Command 表达动作

- `Event` 表示已经发生的事实
- `Command` 表示系统决定要触发的动作

二者都使用统一 envelope，但语义不同。

### 2.2 Envelope 先于 Payload

各模块可以拥有自己的 payload 结构，但 envelope 必须先统一。这样才能支持：

- 统一日志存储
- 幂等处理
- Trace 关联
- 跨模块路由

### 2.3 最小必需，渐进扩展

MVP 只定义最小必需字段。复杂的 provider 专有信息、外部系统原始载荷和大体积产物应通过引用放入 payload，而不是污染公共 envelope。

## 3. 通用字段

### 3.1 必填字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 当前 envelope 的全局唯一 ID |
| `kind` | string | `event` 或 `command` |
| `type` | string | 具体类型，例如 `plan.generated` |
| `source` | string | 事件或命令的来源模块或外部系统 |
| `project_id` | string | 所属 Project |
| `occurred_at` | string | RFC3339 时间戳 |
| `correlation_id` | string | 同一工作链路的关联 ID |
| `payload` | object | 具体业务载荷 |
| `schema_version` | integer | envelope schema 版本 |

### 3.2 推荐字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `session_id` | string | 关联 Session，若已有归属则必填 |
| `task_id` | string | 关联 Task |
| `run_id` | string | 关联 Run |
| `approval_id` | string | 关联 Approval |
| `knowledge_space_id` | string | 关联 Knowledge Space |
| `causation_id` | string | 直接触发本 envelope 的上一个 envelope ID |
| `idempotency_key` | string | 幂等去重键 |
| `trace_id` | string | 观测链路 ID |
| `actor` | object | 发起方身份信息 |
| `sequence` | integer | Session 内顺序号，便于串行处理 |

### 3.3 actor 结构

推荐使用以下最小结构：

```json
{
  "type": "human | agent | system | integration",
  "id": "string",
  "display_name": "string"
}
```

## 4. EventEnvelope

### 4.1 结构

```json
{
  "id": "evt_01H...",
  "kind": "event",
  "type": "run.completed",
  "source": "execution.agent_driver",
  "project_id": "proj_123",
  "session_id": "ses_123",
  "task_id": "task_456",
  "run_id": "run_789",
  "occurred_at": "2026-04-13T10:00:00Z",
  "correlation_id": "corr_123",
  "causation_id": "cmd_123",
  "idempotency_key": "run_789:completed",
  "trace_id": "trace_123",
  "schema_version": 1,
  "payload": {
    "result": "success",
    "artifact_refs": [
      "art_001"
    ]
  }
}
```

### 4.2 Event 命名规范

MVP 阶段使用点分命名法：

`<domain>.<action>`

示例：

- `project.created`
- `session.created`
- `plan.generated`
- `approval.approved`
- `run.started`
- `run.completed`
- `run.timed_out`
- `knowledge.updated`
- `delivery.completed`

### 4.3 Event 语义约束

- Event 必须不可变
- Event 必须描述事实，不得表达“希望发生”
- Event 可以被重复投递，但重复处理不能改变最终状态
- Event 的 payload 应尽量携带摘要和引用，而不是大块原始内容

## 5. CommandEnvelope

### 5.1 结构

```json
{
  "id": "cmd_01H...",
  "kind": "command",
  "type": "run.start",
  "source": "workflow.engine",
  "project_id": "proj_123",
  "session_id": "ses_123",
  "task_id": "task_456",
  "occurred_at": "2026-04-13T10:00:01Z",
  "correlation_id": "corr_123",
  "causation_id": "evt_123",
  "idempotency_key": "task_456:run:start:1",
  "trace_id": "trace_123",
  "schema_version": 1,
  "payload": {
    "provider_hint": "codex",
    "workspace_policy": "isolated"
  }
}
```

### 5.2 Command 命名规范

MVP 阶段同样使用点分命名法：

`<domain>.<action>`

示例：

- `plan.generate`
- `approval.request_plan`
- `run.start`
- `run.cancel`
- `knowledge.apply_update`
- `delivery.sync_external`

### 5.3 Command 语义约束

- Command 表达“下一步应该做什么”
- Command 不能被当作已发生事实写回 Event Log
- Command 执行后必须通过 Event 回报结果
- 同一个 Command 可因重试被重复下发，因此必须带 `idempotency_key`

## 6. correlation_id 与 causation_id

### 6.1 correlation_id

`correlation_id` 用于把同一工作链路串起来。

在 MVP 阶段建议：

- 一个 Session 的首个入口 Event 创建新的 `correlation_id`
- 后续属于同一闭环的 Event / Command 复用该 `correlation_id`

### 6.2 causation_id

`causation_id` 用于表达“本 envelope 是由哪个 envelope 直接触发的”。

示例链路：

`event(issue.created) -> command(plan.generate) -> event(plan.generated) -> command(approval.request_plan) -> event(approval.approved)`

## 7. 幂等、顺序与去重

### 7.1 id

`id` 是当前 envelope 的唯一标识，用于存储和审计。

### 7.2 idempotency_key

`idempotency_key` 用于防止重复副作用。

典型规则：

- 外部 webhook：使用外部事件 ID
- run 完成事件：使用 `run_id + terminal_status`
- 交付命令：使用 `session_id + delivery_action + revision`

### 7.3 sequence

`sequence` 是同一 Session 内的单调递增序号。

MVP 阶段若暂时无法稳定生成 `sequence`，则至少要保证：

- 同一 Session 的状态推进串行
- 乱序 Event 不会绕过状态机直接改写最终态

## 8. Payload 设计规则

### 8.1 Payload 只放业务相关数据

公共治理字段必须停留在 envelope 层，不应散落到 payload 里。

### 8.2 大对象使用引用

以下内容不应直接塞入 payload：

- 大段日志
- 完整 diff
- 大块文档正文
- 二进制附件

它们应通过 `artifact_refs` 或其他引用字段指向外部存储。

### 8.3 Payload 应具备向后兼容空间

MVP 阶段建议为复杂 payload 预留：

- `payload_version`
- `metadata`

但二者不是 envelope 的必填字段。

## 9. 最小 Event 类型集

MVP 阶段建议优先定义以下 Event 类型：

- `project.created`
- `session.created`
- `plan.generated`
- `approval.requested`
- `approval.approved`
- `approval.rejected`
- `approval.changes_requested`
- `run.queued`
- `run.started`
- `run.completed`
- `run.failed`
- `run.timed_out`
- `knowledge.updated`
- `delivery.completed`
- `delivery.failed`

## 10. 最小 Command 类型集

MVP 阶段建议优先定义以下 Command 类型：

- `plan.generate`
- `approval.request_plan`
- `approval.request_review`
- `run.start`
- `run.retry`
- `run.cancel`
- `knowledge.apply_update`
- `delivery.sync_external`
- `session.archive`

## 11. Event Log 存储建议

MVP 阶段的 Event Log 至少应保存以下字段：

- `id`
- `kind`
- `type`
- `source`
- `project_id`
- `session_id`
- `task_id`
- `run_id`
- `approval_id`
- `correlation_id`
- `causation_id`
- `idempotency_key`
- `trace_id`
- `occurred_at`
- `schema_version`
- `payload`

## 12. 与其他文档的关系

本文件定义信封层，不替代：

- `watt-v1-state-machines.md` 中的状态迁移约束
- Project / Knowledge Space 数据模型
- 审批、Review 与交付协议
- 运行时模型与执行适配器协议
