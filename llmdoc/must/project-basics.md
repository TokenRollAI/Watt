# 项目基本盘

## Watt 是什么

Watt 是面向个人自动化的 Agent 控制平面：把 Agent 从一次性对话变成 7x24 小时工作的基础设施——长期可寻址、廉价海量创建、可靠编排并交付可验证结果。第一落地 Cloudflare（Workers / DO / D1 / R2 / Queues / Workflows），但核心协议平台无关。

## 当前阶段

设计已定稿、实现刚起步（2026-06）。`docs/` 四篇全部定稿；唯一代码包是 `packages/protocol`。无部署、无 CI、无 apps/。

## 仓库结构

```text
docs/
  vision.md          # 愿景：五个承诺
  architecture.md    # 核心架构（执行模型 5 决策、调度器、分层、已决问题清单）
  protocol-v1.md     # 协议定稿：ID 语法、AgentSpec、ContextPackage、Host API、Session
  flue-reference.md  # Flue 调研：可借鉴设计 + runtime 全自研定案
README.md            # 项目门面：资源模型、REST 草案、Manager 模型
packages/protocol/   # @watt/protocol 0.1.0（zod v4 + ulid），src 5 文件 + test 3 文件
llmdoc/              # 本文档系统
```

## 工具链

- pnpm 11 workspace（`packages/*` + `apps/*`，apps 暂空）。
- Node 26、TypeScript strict（`tsconfig.base.json`）、ESM。
- 测试用 vitest。无 lint 配置（有意为之，暂未引入）。
- 根脚本仅两个：`pnpm test` 与 `pnpm typecheck`（均 `-r` 递归）。

## 质量门

提交前必须通过：

```sh
pnpm test
pnpm typecheck
```

## docs/ 四篇的定位

| 文件 | 定位 |
| --- | --- |
| `docs/vision.md` | 为什么做：五个承诺与最终图景 |
| `docs/architecture.md` | 怎么做：架构边界、执行模型决策、已决/未决问题清单（最重要） |
| `docs/protocol-v1.md` | 契约定稿：`packages/protocol` 的规范来源 |
| `docs/flue-reference.md` | 调研依据：可借鉴设计 + runtime 选型定案 |

docs/ 是设计权威；代码与 docs/ 冲突时需显式裁决，不可静默偏离。
