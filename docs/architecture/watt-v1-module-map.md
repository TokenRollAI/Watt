# Watt V1.0 模块地图

## 1. 文档目的

本文档用于拆解 Watt V1 阶段的模块边界，明确每个模块负责什么、不负责什么，以及模块之间允许的协作关系。

本文件不定义具体技术栈，重点是保证架构松耦合、对象边界清晰、工作流可演进。

## 2. 架构约束

### 2.1 逻辑松耦合，部署可单体

Watt 强调的是逻辑上的模块化，而不是一开始就拆成分布式微服务。

MVP 阶段允许：

- 控制面模块运行在同一进程内
- 执行层以独立 worker / daemon 进程存在

但模块之间仍应通过显式契约协作，而不是直接越层改状态。

### 2.2 All as Event

Watt 统一使用两类信号：

- `Event`: 表示已经发生的事实
- `Command`: 表示工作流引擎发出的动作指令

所有外部同步、内部通知、执行结果、审批反馈和知识更新结果，都应统一回流为 Event。

### 2.3 Knowledge 独立且共享

Knowledge 是 Project 级独立能力：

- 独立存储
- 独立演进
- 被所有 Agent 共享读取

因此，Knowledge 的读取、更新和路由必须从执行链路中抽象出来，不能附着在某个 Agent 私有上下文之上。

### 2.4 规划优先，执行后置

默认主流程必须是：

1. 规划
2. 人工确认
3. 执行
4. 更新 Knowledge
5. 推进 Task 状态
6. 人工确认 / Review

任何跳过规划确认、直接进入执行的路径，都应被视为显式例外，而不是默认行为。

### 2.5 执行层无显式依赖

执行层必须通过统一适配接口接入不同编码 Agent / CLI。

控制面不应依赖某个 provider 的专有协议或上下文格式。

### 2.6 Workflow Engine 是唯一流程推进入口

除底层存储写入外，所有业务状态推进都必须经由 `Workflow Engine` 决策。

其他模块只能：

- 发出 Event
- 接收 Command
- 返回执行结果

不能自行推动主流程向前走。

## 3. 分层模块地图

### 3.1 事件接入层

#### 3.1.1 Source Adapter

职责：

- 对接 IM、任务源、代码托管平台等外部系统
- 将外部载荷转化为平台可识别的候选事件

输入：

- 外部系统原始载荷

输出：

- 标准化前的候选事件数据

不负责：

- Session 匹配
- Task 拆解
- 状态推进

#### 3.1.2 Event Gateway

职责：

- 接收候选事件数据
- 做基础校验、规范化、去重和事件封装
- 将外部输入转换为平台标准 Event

输入：

- Adapter 输出的候选事件数据

输出：

- 标准 Event

不负责：

- 决定事件该进入哪个业务流程
- 直接调用 Planner 或执行后端

### 3.2 事件骨干层

#### 3.2.1 Event Backbone

职责：

- 作为平台统一事件流入口
- 承接外部输入事件和内部模块结果事件
- 将事件分发给编排层、观察层和协作层

输入：

- Event Gateway 产生的外部 Event
- 执行层、知识层、审批层回流的内部 Event

输出：

- 发送给 `Workflow Engine` 的标准事件流
- 发送给可观测、审计和外部通知链路的事件

不负责：

- 决定业务状态如何迁移
- 直接创建 Task 或 Run

### 3.3 编排层

#### 3.3.1 Session Resolver

职责：

- 将 Event 归入已有 Session，或创建新的 Session
- 维护 Event 与 Session 的关联边界

输入：

- 标准 Event
- Project / Session 上下文摘要

输出：

- Session 命中结果
- 新建 Session 决策结果

不负责：

- Task 拆解
- 工作流状态迁移

#### 3.3.2 Workflow Engine

职责：

- 维护平台主状态机
- 决定当前 Session 下一步应规划、审批、执行、更新 Knowledge、交付还是终止
- 基于 Event 生成 Command

输入：

- Event
- Session 当前态
- Task / Run / Approval / Knowledge 更新结果

输出：

- 发往各模块的 Command
- 状态更新决策

不负责：

- 直接读取 Knowledge 内容
- 直接运行执行后端
- 直接调用外部系统 API 完成交付

#### 3.3.3 Task Graph Manager

职责：

- 将规划结果转为平台内部 Task 结构
- 维护 Task 的父子关系、依赖关系和可执行状态

输入：

- Planner 产出的计划
- Workflow Engine 下发的编排 Command

输出：

- Task 图结构
- 可执行 Task 集合

不负责：

- 生成规划内容
- 创建 Workspace

### 3.4 Knowledge 层

#### 3.4.1 Knowledge Store

职责：

- 为每个 Project 保存独立的 Knowledge Space
- 作为所有 Agent 的共享知识真相源

输入：

- 初始知识导入
- Knowledge Curator 写入的更新结果

输出：

- 可读取的项目知识空间

不负责：

- 规划决策
- Task 状态推进

#### 3.4.2 Knowledge Router

职责：

- 根据当前任务和事件定位最相关的 Knowledge
- 为 Planner 和执行层提供结构化知识视图

输入：

- 查询意图
- Project 标识
- Knowledge Store 中的知识索引

输出：

- 知识命中结果
- 路由摘要

不负责：

- 改写 Knowledge
- 决定是否执行任务

#### 3.4.3 Knowledge Curator

职责：

- 在任务完成后整理知识更新候选
- 将可复用结论沉淀回 Project 的 Knowledge Space

输入：

- 执行产物摘要
- 运行结果和人工反馈

输出：

- Knowledge 更新结果
- 回流 Event

不负责：

- 参与运行时即时规划
- 直接推进 Task 状态

### 3.5 规划与审批层

#### 3.5.1 Planner Agent

职责：

- 理解事件、Session 目标和 Project 知识
- 产出可执行、可复核的任务计划
- 为后续执行准备明确的 Task 描述

输入：

- Event 上下文
- Session 摘要
- Knowledge Router 返回的知识视图

输出：

- Task Plan
- 规划说明

不负责：

- 直接修改平台状态
- 直接执行代码
- 直接写入 Knowledge Store

#### 3.5.2 Approval Coordinator

职责：

- 创建和跟踪计划确认、结果复核和最终 Review 节点
- 将人类操作统一回流为 Event

输入：

- Workflow Engine 发起的审批 Command
- 计划摘要、执行摘要、Knowledge 更新摘要

输出：

- Approval 记录
- 审批结果 Event

不负责：

- 自主决定是否跳过审批
- 直接变更 Task / Session 状态

### 3.6 执行层

#### 3.6.1 Run Scheduler

职责：

- 从可执行 Task 集合中创建具体 Run
- 控制并发执行入口

输入：

- 可执行 Task 集合
- Workflow Engine 的执行 Command

输出：

- 新建 Run

不负责：

- 决定业务优先级
- 维护 Task 图

#### 3.6.2 Workspace Manager

职责：

- 为 Run 准备独立的执行上下文
- 挂载代码仓库工作副本和运行依赖
- 回收执行后的临时环境

输入：

- Run 信息
- Project / 仓库上下文

输出：

- 可执行 Workspace

不负责：

- 任务拆解
- 主流程状态推进

#### 3.6.3 Agent Driver

职责：

- 通过统一适配接口对接不同执行后端
- 屏蔽 Codex、Claude Code 等 provider 的实现差异
- 将 Task 和 Workspace 转换为具体执行调用

输入：

- Task 执行描述
- Workspace
- 执行后端配置

输出：

- 执行结果
- 过程消息
- provider 相关 usage 信息

不负责：

- 决定是否重试
- 决定是否更新外部系统状态

#### 3.6.4 Verification Runner

职责：

- 执行验证动作并汇总结果
- 将验证结果标准化后交回平台

输入：

- Workspace
- 本次执行后的仓库状态

输出：

- 验证结果
- 验证日志与报告

不负责：

- 修改业务代码
- 直接决定 Task 成败

#### 3.6.5 Run Watchdog

职责：

- 监测超时、悬挂、失联或异常中止的 Run
- 将异常恢复信号统一回流为 Event

输入：

- Run 生命周期数据
- 心跳、超时和执行状态信息

输出：

- 超时 / 失联 / 恢复类 Event

不负责：

- 直接终止业务流程
- 绕过 Workflow Engine 做状态结论

#### 3.6.6 Artifact Manager

职责：

- 收集并整理执行和验证产物
- 为 Knowledge 更新、审批和交付提供统一引用

输入：

- Agent Driver 与 Verification Runner 的结果

输出：

- Artifact 集合
- 产物摘要

不负责：

- 决定是否需要人工确认

### 3.7 交付层

#### 3.7.1 Delivery Coordinator

职责：

- 执行 PR、评论、状态同步等交付动作
- 将交付结果回流为 Event

输入：

- Workflow Engine 的交付 Command
- Artifact 摘要
- 外部系统映射信息

输出：

- 交付结果 Event

不负责：

- 代码执行
- 任务规划

### 3.8 数据层

#### 3.8.1 Event Log

职责：

- 持久化不可变事件流

不负责：

- 替代当前态查询模型

#### 3.8.2 State Store

职责：

- 保存 Session、Task、Run、Approval 的当前态视图

不负责：

- 替代 Event Log 的历史追溯能力

#### 3.8.3 Artifact Store

职责：

- 持久化执行产物、验证报告和知识更新摘要

### 3.9 横切能力

#### 3.9.1 Policy & Audit

职责：

- 定义敏感动作的授权与约束策略
- 审计审批、交付和关键状态迁移

#### 3.9.2 Observability

职责：

- 提供事件链路、任务耗时、失败分类和资源消耗视图

## 4. 模块协作规则

### 4.1 主链路方向

主链路保持如下方向：

`Source Adapter -> Event Gateway -> Event Backbone -> Session Resolver -> Workflow Engine`

规划链路保持如下方向：

`Workflow Engine -> Planner Agent -> Task Graph Manager -> Approval Coordinator -> Event Backbone`

执行链路保持如下方向：

`Workflow Engine -> Run Scheduler -> Workspace Manager -> Agent Driver -> Verification Runner -> Artifact Manager -> Event Backbone`

Knowledge 更新链路保持如下方向：

`Artifact Manager -> Knowledge Curator -> Knowledge Store -> Event Backbone -> Workflow Engine`

交付链路保持如下方向：

`Workflow Engine -> Delivery Coordinator -> Event Backbone`

### 4.2 禁止的直接耦合

以下调用关系应在架构层面被禁止：

- `Source Adapter` 直接写 `State Store`
- `Planner Agent` 直接写 `State Store`
- `Planner Agent` 直接写 `Knowledge Store`
- `Agent Driver` 直接调用外部系统完成交付
- `Verification Runner` 直接决定 Task 成败
- `Knowledge Curator` 直接推进 Task / Session 状态
- `Approval Coordinator` 自行跳过人工确认
- `Run Watchdog` 直接下结论关闭 Session

### 4.3 人类反馈回流规则

人类的 Approve、Reject、Feedback、Review 结果不是旁路输入，而是标准 Event。所有人类操作都必须回流到 `Event Backbone`，再由 `Workflow Engine` 决策后续动作。

### 4.4 执行后端替换规则

替换或新增执行后端时，只允许在 `Agent Driver` 的适配层内扩展，不应影响：

- `Workflow Engine`
- `Knowledge Router`
- `Knowledge Curator`
- `Approval Coordinator`
- `Delivery Coordinator`

## 5. MVP 阶段建议保留的模块

MVP 阶段建议优先保留以下逻辑模块，构成最小闭环：

- `Source Adapter`
- `Event Gateway`
- `Event Backbone`
- `Session Resolver`
- `Workflow Engine`
- `Task Graph Manager`
- `Knowledge Store`
- `Knowledge Router`
- `Knowledge Curator`
- `Planner Agent`
- `Approval Coordinator`
- `Run Scheduler`
- `Workspace Manager`
- `Agent Driver`
- `Verification Runner`
- `Run Watchdog`
- `Artifact Manager`
- `Delivery Coordinator`
- `Event Log`
- `State Store`
- `Artifact Store`

这些是逻辑边界，不等于必须一开始就拆成同等数量的可部署组件。

### 5.1 MVP 允许的实现合并

在不破坏逻辑职责边界的前提下，MVP 阶段允许做以下实现级合并：

- `Source Adapter + Event Gateway + Event Backbone`
  可先实现为统一的 `Event Ingress` 组件

- `Knowledge Store + Knowledge Router + Knowledge Curator`
  可先实现为统一的 `Knowledge Manager` 组件

- `Run Scheduler + Run Watchdog`
  可先实现为统一的 `Run Orchestrator` 组件

- `Agent Driver + Verification Runner + Artifact Manager`
  可先实现为统一的 `Run Executor` 组件

### 5.2 合并边界的要求

即使在实现上做了合并，以下逻辑边界仍必须保留：

- Knowledge 的读取与更新语义不能混淆
- Run 的调度决策与执行结果不能混淆
- 执行后端适配逻辑不能泄漏到控制面
- 审批与交付不能被执行层绕过

MVP 阶段允许其中大部分控制面模块运行在同一进程内，只要这些边界不被破坏。

## 6. 需要后续补齐的设计文档

在当前模块地图基础上，建议继续补齐以下设计文档：

1. 运行时模型与执行适配器协议
2. Project / Knowledge Space 数据模型
3. 审批、Review 与交付协议
4. Event Ingress 与外部系统对接协议
5. 对外 API Surface 细化文档
