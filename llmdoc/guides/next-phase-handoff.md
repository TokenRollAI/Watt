# 下一阶段路线图与分工（M1–M4）

Watt 实现阶段的里程碑路线图与并行分工方案。M1 已完成（2026-06-12）；后续里程碑按此推进。
设计权威见 `docs/architecture.md` 与 `docs/protocol-v1.md`；硬不变量见 [../must/core-invariants.md](../must/core-invariants.md)。

## 模块划分与依赖图

```text
packages/protocol        ✅ 已完成（契约源头，所有包依赖它）
packages/plan-script     ✅ M1【Lane A】QuickJS 沙箱 + 静态校验 + journal 重放
packages/model-deepseek  ✅ M1【Lane B】DeepSeek 薄模型层（usage 归一化 + costUsd）
packages/runtime-core    ✅ M1【Lane B】turn loop + finish/give_up + 预算三限
packages/storage         ✅ M1【Lane C】五窄接口 + 内存实现
packages/orchestrator    ← 依赖 plan-script + runtime-core + storage 【M2】
packages/context         ← 依赖 protocol + storage   【M2，可与 orchestrator 并行】
packages/agent-factory   ← 依赖 protocol + runtime-core 【M3】
packages/integrations-github ← 依赖 protocol         【M3，可提前并行】
packages/delivery        ← 依赖 protocol + integrations-github 【M3】
apps/api-worker          ← 依赖以上全部（Cloudflare 落地）【M3 末】
apps/cli / apps/web      ← 依赖 api-worker 的 REST API 【M4】
```

通用模式（强制）：每个包都是「平台无关 core + 窄接口 + adapter」。core 必须能用纯 vitest +
内存 adapter 测试，不依赖 Cloudflare；CF adapter（D1/DO/R2/Queues）集中在 apps/api-worker
或独立 adapter 文件，用 @cloudflare/vitest-pool-workers 测。

## M2（M1 已合入，现在可启动）

- packages/orchestrator：Run Coordinator 状态机（平台无关 core）；Scheduler 驱动
  plan-script 重放循环，把 run/invoke 翻译成带幂等 key 的队列命令（key 用 protocol 的
  `idempotencyKeyForHostCall`）；Dispatcher 即 Queue consumer：装载 AgentVersion →
  跑 runtime-core loop → 结果写回。预算计数器在派发前检查。一次 AgentRun 的完整 loop
  在单个 consumer 调用内跑完，超长任务 re-enqueue 续跑——不做跨 step 可重入状态机。
- packages/context：ContextPackage 构造、ContextRef 解析（经 storage）、
  permissions.contextScope 强制。
- 验收：端到端内存测试——手写 PlanScript 跑通「fan-out 两个 AgentRun（fake model）→
  checkpoint → artifact」全链路，且 journal 可中断后重放续跑。

## M3

- packages/agent-factory：Planner prompt（输出 PlanScript）与 Factory prompt（输出
  AgentSpec），policy check（工具授权不超 maxTools），输出过 protocol schema 校验。
- packages/integrations-github：octokit 封装为 Tool；artifact 写入 workspace 配置的专用
  repo，路径 `runs/<YYYY-MM-DD>-<task-slug>/`；写后 API 回读确认（机械验证）。
- packages/delivery：Final Report / Verification Summary（区分机械验证与模型自述）/
  Memory Candidates。
- apps/api-worker：Hono + REST API；CF adapter：D1（registry，按 workspace 拆库）、
  per-Run DO（Run Coordinator）、per-Agent DO（会话状态）、R2（artifact）、Queues
  （dispatcher）；直连会话路径——会话历史在 per-Agent DO，模型调用在无状态 Worker。
  实现前先做 spike：Workflows/Queues 的并发 waitForEvent 行为（architecture.md 未决）。
- 验收：本地 miniflare 跑通 architecture.md「V1 建议切片」的 10 步最小闭环。

## M4

- apps/cli（提交任务/查 run/拉 artifact/会话对话）与 apps/web。全部走公开 REST API，
  不得直连内部服务。

## 工程规约

- 新包结构照抄 packages/protocol：ESM、TS strict、vitest、exports 指向 src/index.ts、
  scripts 含 test 与 typecheck。
- 并行分工时：先统一脚手架 + 一次 `pnpm install` 装齐依赖，再派工——并行 agent 不得各自
  改 lockfile（M1 验证有效的做法）。
- zod v4 语法：`z.iso.datetime()`、`z.url()`、错误参数 `{ error: '...' }`、z.record 双参数。
- 每个里程碑收尾：`pnpm test` 与 `pnpm typecheck` 全绿 → git commit（一个里程碑一个
  commit，英文 summary）→ 更新 llmdoc（新包补 architecture/ 或 reference/ 文档、
  reconcile memory/doc-gaps.md、重要决策记 memory/decisions/）。
- 临时调研产物放 .llmdoc-tmp/，不入 git、不入 llmdoc 索引。

## 决策边界

可自行决定：包内部文件结构、内部库选型、测试组织方式、不影响契约的实现细节。

必须停下来问用户：修改 packages/protocol 既有契约（含 Host 函数语义）、新增外部服务
依赖、任何与 6 条硬不变量冲突的方案、以及触及两个未决问题时——①GitHub 自动写入的审批
粒度；②Agent visibility（private/workspace/global）模型。
