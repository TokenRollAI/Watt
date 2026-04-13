# Watt 架构文档

本目录用于沉淀 Watt 平台在 MVP 阶段的系统架构、模块边界与核心运行约束。

当前文档：

- `watt-v1-system-architecture.md`: V1 阶段的总体系统蓝图，定义目标、核心对象、分层架构、关键流程与 MVP 边界。
- `watt-v1-module-map.md`: V1 阶段的模块地图，定义各模块职责、输入输出、依赖关系与模块间约束。
- `watt-v1-state-machines.md`: V1 阶段的 Session / Task / Run / Approval 状态机与关键不变量。
- `watt-v1-event-command-envelope.md`: V1 阶段统一的 Event / Command 信封定义。

建议阅读顺序：

1. 先阅读 `watt-v1-system-architecture.md`，理解系统整体边界与运行主线。
2. 再阅读 `watt-v1-module-map.md`，理解模块职责分工与协作方式。
3. 阅读 `watt-v1-state-machines.md`，确认状态迁移和关键约束。
4. 阅读 `watt-v1-event-command-envelope.md`，确认模块间统一信封。
5. 后续再补充运行时模型、Knowledge 数据模型和审批/交付协议。
