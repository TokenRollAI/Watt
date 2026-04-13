# Watt V1.0 系统架构蓝图

## 1. 文档目的

本文档用于定义 Watt 在 MVP 阶段的系统级架构蓝图，重点回答以下问题：

- Watt 的核心设计原则是什么。
- 平台内部有哪些核心对象和逻辑层。
- 平台如何围绕“规划、确认、执行、沉淀、复核”形成闭环。

本文档优先描述架构边界和模块关系，不展开具体技术选型与实现细节。

## 2. 系统目标与非目标

### 2.1 系统目标

Watt 的目标是成为一个面向软件工程协作场景的事件驱动型 Agent 平台。MVP 阶段重点解决以下问题：

- 为每个项目建立独立存储、可持续演进、被所有 Agent 共享的 Knowledge 空间。
- 将“先规划、人工确认后执行”设为默认工作流，而不是让执行直接起跑。
- 将执行层设计为 provider-agnostic，允许 Codex、Claude Code 等不同执行后端平等接入。
- 将外部同步、内部通知、执行结果、审批反馈统一收敛为标准事件。
- 以松耦合模块构建平台，使控制面、知识面、执行面和交付面能够独立演进。

### 2.2 非目标

MVP 阶段不追求以下能力：

- 自动选择“最佳 agent”的智能派单。
- 基于仓库内专用目录或专用文件约束执行环境的强绑定设计。
- 跳过人工确认、完全自治的执行链路。
- 一开始就做成多服务分布式控制面。
- 一次性覆盖所有软件工程协作平台和工作流模型。

MVP 的目标是先跑通一条稳定、可审计、可复核的最小闭环。

## 3. 核心设计原则

### 3.1 All as Event

Watt 将所有外部同步和内部通知统一建模为事件。

这里的事件不仅包括：

- 来自 GitHub、Linear、IM 等外部系统的输入
- 来自执行层的结果、日志、失败、取消、完成信号
- 来自审批、评论、反馈的人类交互
- 来自知识更新、状态推进、交付回写的内部结果

平台通过 `Event` 感知事实，通过 `Command` 协调动作。两者必须分离：

- `Event` 表示某件事已经发生。
- `Command` 表示系统决定接下来应该做什么。

### 3.2 Knowledge Independence

Knowledge 是项目级的一等能力，而不是某个 Agent 的私有上下文。

每个项目都拥有自己的 Knowledge 空间，并满足以下约束：

- 独立存储
- 独立演进
- 可被所有 Agent 共享读取
- 允许在任务完成后持续更新

Knowledge 的职责是沉淀项目事实、约束、上下文与历史结论，而不是保存某次执行的临时思考。

### 3.3 Plan First, Execute After Approval

Watt 的默认工作流不是“收到输入立刻执行”，而是：

1. 基于事件和 Knowledge 先生成计划
2. 将计划提交给人类确认
3. 确认后才进入执行
4. 执行完成后更新 Knowledge
5. 更新 Task 状态
6. 最后进入人工确认或 Review

这样设计的目的是将高成本执行和高风险交付放在明确的人机边界之后。

### 3.4 Shared Knowledge, Isolated Execution

所有 Agent 可以共享同一个项目的 Knowledge，但不能共享同一个可写执行上下文。

也就是说：

- 知识层是项目共享的
- 执行层是 Run 级隔离的

这样可以同时满足“上下文复用”和“执行不互相污染”。

### 3.5 Execution Provider Agnostic

执行层不应显式依赖某个特定编码 Agent。

Watt 的执行面必须通过统一适配接口对接不同后端，例如：

- Codex
- Claude Code
- 其他兼容的 Coding Agent / CLI

控制面和知识面不应感知具体 provider 的专有细节。

### 3.6 Loose Coupling by Explicit Contracts

Watt 强调的是逻辑边界的松耦合，而不是部署形态上的强拆分。

MVP 阶段允许控制面以内聚单体形式实现，但模块之间仍应通过显式契约协作：

- 通过 `Event` 传递事实
- 通过 `Command` 触发动作
- 通过统一对象模型表达 Session、Task、Run、Approval、Artifact

模块可以同进程部署，但不能互相绕过边界直接写对方状态。

### 3.7 Human Review by Default

Watt 不是“模型自证正确”的系统。

在人机协作链路中，人类至少需要介入两个关键节点：

- 计划确认
- 结果复核或最终 Review

平台的目标是减少人类重复劳动，而不是移除人类在关键决策点上的控制权。

## 4. 核心领域对象

Watt 的架构设计围绕以下核心对象展开。

### 4.1 Project

`Project` 是 Watt 中承载业务上下文、知识空间和协作流程的顶层边界。

Project 的职责：

- 作为 Knowledge 的归属边界
- 作为 Session 的归属边界
- 作为外部系统同步和交付的主要映射对象

### 4.2 Knowledge Space

`Knowledge Space` 是某个 Project 的独立知识空间。

Knowledge Space 的职责：

- 持久化项目长期可复用知识
- 为 Planner、执行层和内部 Agent 提供共享上下文
- 承载任务完成后的知识更新结果

### 4.3 Event

`Event` 是平台观察到的事实，用于驱动工作流继续推进。Event 可以来自外部系统，也可以来自平台内部模块。

Event 的作用：

- 描述某件事已经发生
- 触发 Session 归属和工作流判断
- 作为系统内部的统一通知语言

### 4.4 Command

`Command` 是工作流引擎向其他模块发出的调度意图。

Command 的作用：

- 将状态判断与动作执行解耦
- 驱动规划、审批、执行、知识更新和交付
- 避免执行模块自行决定主流程走向

### 4.5 Session

`Session` 是围绕一个工作目标建立的长期协作上下文。

Session 的职责：

- 作为工作流实例的主容器
- 维护当前工作阶段和整体状态
- 聚合关联的 Task、Run、Approval、Artifact

### 4.6 Task

`Task` 是 Session 内可分配、可追踪、可验证的工作单元。

Task 的职责：

- 表达一个明确的工作目标
- 承载依赖关系、执行状态和结果归属
- 作为计划与执行之间的稳定边界

### 4.7 Run

`Run` 是某个 Task 的一次具体执行尝试。

Run 的职责：

- 记录一次执行尝试的完整上下文
- 关联工作空间、执行日志、验证结果和执行产物
- 为失败分析、重试控制和知识更新提供依据

在 MVP 阶段，一个 Task 可以拥有多个历史 Run，但同一时刻只能存在一个活跃 Run。

### 4.8 Workspace

`Workspace` 是 Run 对应的独立执行上下文。

Workspace 的职责：

- 承载代码仓库工作副本和运行依赖
- 为具体执行后端提供隔离的读写环境
- 保证不同 Run 之间互不污染

### 4.9 Approval

`Approval` 表示一次显式的人类决策节点。

Approval 的典型场景：

- 计划确认
- 高风险执行授权
- 结果复核
- 最终交付前 Review

### 4.10 Artifact

`Artifact` 表示执行过程中产出的可引用结果，包括但不限于：

- 执行日志
- Diff 摘要
- 验证报告
- 错误堆栈
- 交付说明
- 知识更新摘要

### 4.11 对象关系

在 MVP 阶段，这些对象之间满足以下关系：

- 一个 `Project` 拥有一个独立的 `Knowledge Space`
- 同一 `Project` 下的所有 Agent 共享同一 `Knowledge Space`
- 一个 `Session` 归属于一个 `Project`
- 一个 `Session` 可以包含多个 `Task`
- 一个 `Task` 可以产生多个 `Run`
- 一个 `Run` 必须关联一个 `Workspace`
- 一个 `Run` 可以产出多个 `Artifact`
- 一个 `Session` 在生命周期内可以触发多个 `Approval`
- `Event` 进入系统后，由 `Workflow Engine` 基于状态生成 `Command`
- `Command` 驱动模块执行，模块执行结果再回流为新的 `Event`

## 5. 系统分层与核心模块

### 5.1 事件接入层

事件接入层负责接收外部输入并转化为平台内部统一事件。

核心模块：

- `Source Adapter`: 对接 IM、任务源、代码托管平台等外部系统
- `Event Gateway`: 完成规范化、校验、去重与事件封装

### 5.2 事件骨干与编排层

该层是平台的控制中枢，负责接收事件、决定状态迁移并下发命令。

核心模块：

- `Event Backbone`: 承接外部事件和内部结果事件，作为统一事件流入口
- `Session Resolver`: 判断事件应归入哪个 Session
- `Workflow Engine`: 维护主状态机，决定下一步动作
- `Task Graph Manager`: 管理 Task 结构、依赖关系与执行准备状态

### 5.3 Knowledge 层

Knowledge 层负责 Knowledge 的持久化、读取和更新。

核心模块：

- `Knowledge Store`: 保存项目级独立 Knowledge 空间
- `Knowledge Router`: 根据当前任务和事件定位最相关 Knowledge
- `Knowledge Curator`: 在任务完成后维护和更新 Knowledge

### 5.4 规划与审批层

该层负责在执行之前形成可复核的计划，并在人机边界上建立确认节点。

核心模块：

- `Planner Agent`: 结合事件上下文和 Knowledge 生成计划
- `Approval Coordinator`: 管理计划确认、结果复核和 Review 过程

### 5.5 执行层

执行层负责将经确认的计划转化为真实代码执行。

核心模块：

- `Run Scheduler`: 创建和调度 Run
- `Workspace Manager`: 为 Run 准备隔离执行环境
- `Agent Driver`: 通过统一适配接口驱动不同执行后端
- `Verification Runner`: 执行验证逻辑并收集结果
- `Run Watchdog`: 发现超时、悬挂或失联 Run，并发出恢复事件
- `Artifact Manager`: 收集和整理执行产物

执行层只对 `Command` 作出响应，并将结果作为 `Event` 回流。

### 5.6 交付与外部同步层

该层负责把平台内部结论同步回外部系统。

核心模块：

- `Delivery Coordinator`: 执行 PR、评论、状态回写等交付动作

交付动作本身的结果也必须回流为事件，而不是停留在外部 API 调用层。

### 5.7 数据与横切能力

数据与横切能力为所有层提供持久化、审计和可观测支持。

核心模块：

- `Event Log`: 保存不可变事件流
- `State Store`: 保存 Session、Task、Run、Approval 的当前态
- `Artifact Store`: 保存执行产物和知识更新摘要
- `Policy & Audit`: 记录敏感操作和审批决策
- `Observability`: 提供 Trace、耗时、失败分类和资源消耗统计

### 5.8 Session Resolver 的 MVP 归属规则

在 MVP 阶段，`Session Resolver` 采用确定性归属规则，避免一个事件被多个 Session 同时消费。

归属原则：

- 每个外部工作对象最多映射到一个主 Session
- 主映射键建议为：`(project_id, source_type, source_object_id)`
- `source_object_id` 可以是 Issue ID、PR ID、Thread ID 或其他外部对象主键
- 一个 Event 在 MVP 阶段最多只归属一个主 Session

终态处理原则：

- 若命中的是终态 Session，默认创建新的后续 Session
- 新 Session 应保留对前序 Session 的可追溯关联

MVP 阶段不支持一个 Event 同时扇出到多个 Session。

### 5.9 Knowledge Space 的 MVP 实现

Knowledge Space 在架构上是独立能力，在 MVP 阶段建议采用最小但明确的实现：

- 存储形式：结构化 Markdown 文档加元数据索引
- 最小粒度：`Knowledge Node`，可以是一篇文档或文档中的稳定章节
- 检索机制：路径定位、标签过滤和全文搜索的组合
- 版本方式：保留节点级修订信息，支持覆盖更新和历史追溯

MVP 阶段不要求先引入向量数据库或复杂 RAG 管线。优先保证：

- 知识是项目级独立存储的
- 所有 Agent 可以共享读取
- 知识更新有明确来源和修订记录
- 检索结果具备确定性和可解释性

## 6. 关键运行主线

### 6.1 事件进入平台

1. 外部系统同步或内部模块通知被统一转换为 `Event`
2. `Event Gateway` 完成规范化、去重和事件封装
3. 标准 Event 被送入 `Event Backbone`
4. `Session Resolver` 和 `Workflow Engine` 基于当前状态判断下一步动作

### 6.2 规划优先

1. `Workflow Engine` 判断该 Session 需要先规划
2. `Planner Agent` 结合 Session 上下文与 `Knowledge Router` 返回的项目知识生成计划
3. 计划被整理为可复核的 Task Plan 和说明材料
4. 计划结果进入审批流程，而不是直接进入执行

### 6.3 人工确认后执行

1. `Approval Coordinator` 向人类发起计划确认
2. 人类的 Approve、Reject、Feedback 统一作为 Event 回流
3. `Workflow Engine` 基于审批结果决定：
   - 批准后生成执行 `Command`
   - 驳回后重新规划
   - 反馈后补充上下文并再次规划

### 6.4 执行与验证

1. `Run Scheduler` 为被批准的 Task 创建 Run
2. `Workspace Manager` 为 Run 准备隔离 Workspace
3. `Agent Driver` 选择具体执行后端适配器，例如 Codex 或 Claude Code
4. 执行结果和验证结果统一交给 `Artifact Manager`
5. 所有执行过程中的完成、失败、取消、超时、验证结果都回流为 Event

### 6.5 任务完成后更新 Knowledge

1. 执行完成后，`Knowledge Curator` 基于执行产物生成知识更新候选
2. 更新结果写入该 Project 的 `Knowledge Space`
3. Knowledge 更新结果作为 Event 回流
4. `Workflow Engine` 在接收到知识更新结果后推进 Task 状态

Knowledge 更新是任务闭环的一部分，而不是事后补写的可选操作。

### 6.6 人工确认 / Review 与交付

1. Task 状态推进后，平台进入人工确认或 Review 阶段
2. 人类对结果进行复核，并通过 Event 给出确认、修改意见或拒绝
3. 若允许交付，则由 `Delivery Coordinator` 回写外部系统
4. 交付结果再次回流为 Event，最终推动 Session 进入完成态或下一轮规划态

### 6.7 失败与恢复

MVP 阶段所有失败都应收敛到以下恢复路径之一：

- 自动重试
- 重新规划
- 人工介入
- 终止归档

`Run Watchdog` 负责发现悬挂或失联执行，`Workflow Engine` 负责决定恢复路径。

## 7. Bootstrap 与系统初始化

Watt 的最小启动引导至少包含以下步骤：

1. 创建 `Project`
2. 为 `Project` 初始化独立的 `Knowledge Space`
3. 注册需要接入的 `Source Adapter`
4. 注册至少一个执行后端适配器
5. 初始化默认策略，例如：
   - 计划确认必需
   - 单 Task 单活跃 Run
   - Review 后才允许交付

MVP 阶段不要求复杂的自动发现机制，但这些初始化对象必须是显式可管理的。

## 8. 对外 API Surface

Watt 的对外接口边界在架构上至少应覆盖以下能力：

- `Project API`
  用于创建、查询和管理 Project 及其基础配置

- `Knowledge API`
  用于查看、导入、编辑和审计 Project 级 Knowledge

- `Event Ingress API`
  用于接收外部系统同步和人类主动触发输入

- `Session / Task / Run Query API`
  用于查询当前工作流状态、执行历史和产物摘要

- `Approval API`
  用于执行计划确认、结果复核和交付授权

- `Delivery API`
  用于查询和追踪对外同步与交付结果

这些 API 在 MVP 阶段可以通过 HTTP、Webhook、IM 回调或内部调用暴露，但其逻辑边界必须先独立存在。

## 9. MVP 架构边界

为保证 MVP 可落地，建议将系统边界收敛为以下范围：

- 每个 `Project` 只维护一个独立 `Knowledge Space`
- 计划默认需要人工确认后才允许执行
- 控制面可以以内聚单体实现，执行面以独立 worker / daemon 方式运行
- 执行层必须通过 provider-agnostic 适配接口接入不同 Coding Agent
- 每个 `Task` 同时只允许一个活跃 `Run`
- 交付和外部状态回写必须由平台显式发出 `Command`
- 暂不引入自动派单器

## 10. 延后到后续版本的能力

以下能力不应阻塞 V1 架构收敛：

- 自动派单与负载感知调度
- 更复杂的跨项目 Knowledge 共享
- 多实例控制面的分布式事件总线
- 更精细的组织级权限体系
- 高级成本优化、模型路由与执行策略引擎

## 11. 后续文档建议

在本蓝图基础上，当前文档栈还建议继续补齐以下内容：

1. 运行时模型文档
2. Project / Knowledge Space 数据模型文档
3. 审批、Review 与交付协议文档
4. 对外 API 细化文档
5. Bootstrap 与项目初始化细化文档

以上文档应作为本蓝图的细化，而不是替代本蓝图。
