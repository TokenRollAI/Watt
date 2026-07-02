# Watt 项目总览

> 真源：`Docs/Vision.md`（定位与验收基准）、`DOD.md`（Phase 划分与全局 Done）。

## 定位

Watt 是一个廉价、可扩展、协议开放的**云上 Agent 基础设施（Agent Infra）**——不是又一个 Agent 框架，而是框架之下那一层：让任意 harness（Flue / Claude / OpenAI SDK / 自研）通过开放协议（MCP / HTBP / HTTP）接入组织的事件流、上下文与工具，长期自治运行。底座绑定 Cloudflare，空闲近零成本。

分层原则：每层由纯接口定义，实现（内置或 Plugin）都是 Provider；层间只经接口交互，无旁路。模块与数据流详见 [../architecture/modules-and-flows.md](../architecture/modules-and-flows.md)。

## 六个 User Case（Vision §3，硬性验收基准）

| # | 场景 | 要点 | 覆盖模块 |
|---|---|---|---|
| 1 | 自动交付需求 | webhook 收 bug 反馈 → Triage 查重登记 → 定位 → Coding Agent（Container）修复 → QA/Review 接力 → PR/CI → **人类确认上线**（checkpoint 卡片→Signal 恢复）→ 回写 Context 置 fixed | M1/M2/M3/M4/M7/M5 |
| 2 | Deep Research | 飞书提问 → Master 出方案卡片等确认 → **Spawn N 个 subagent**（带 expect）各自 websearch → `agent.result` fan-in 汇总回群（超时者平台代发 `agent.failed`） | M1/M2/M4/M7 |
| 3 | 群聊记录 | 机器人入群**只记录不回复**（长驻 DO 空闲零计费），写入带 TTL 的临时 Context namespace；被 @ 时基于积累 context 立即回答 | M1/M2/M3 |
| 4 | 权限控制 | 同一财务 Agent，CEO 可用工具、普通员工在 Tool Layer 调用点被 Auth 拒绝后礼貌拒答；判定主体 = **(调用者 Principal, Agent, 资源)** 三元组 | M5/M4/M1 |
| 5 | Provider 管理 | Admin 看 7 天 token 用量/费用/缓存命中率 → 新增模型渠道并设为默认 | M10/M8/M9/M5 |
| 6 | 定时任务 | 对 Manage Agent 说"每天发 token 日报到飞书群" → 脚本存 `context://automations` → Scheduler 发布 `action=script` cron → 每日 isolate 执行 → 出站 webhook | M10/M6/M9/M1/M3 |

## Phase 0~7 路线图（DOD）

| Phase | 内容 | 要点 |
|---|---|---|
| 0 | 工程骨架与部署管道 | pnpm monorepo、`watt-gateway` 骨架、wrangler 绑定占位、`pnpm verify`/`deploy:all`/`smoke.ts`、CLI 骨架（`watt status`） |
| 1 | Auth 内核 + Event 信封 | Proto §0/§1/§6 落地：JWT 三类 token、`Authorizer.Check` 四步算法、PolicyStore+KV 缓存、种子 Policy、WattError↔HTTP 中间件 |
| 2 | Event Gateway（M1） | Ingress、EventBus（Queues+Router DO）、EventStore、ChannelRegistry、内置 webhook Adapter、§1.1 HITL 内置路由 |
| 3 | Context Layer（M3） | ContextRegistry（挂载/TTL/Resolve）、object/structured/vector 三内置 Provider、HTBP Context 子树 |
| 4 | Tool Layer + Agent Runtime（M4+M2） | tool-bridge 集成（缺能力改上游）、Agent Spawn/Send/§3.4 六条路由规则、echo/LLM harness、Model Provider 最小版。首个消耗真实 token 的测试（tag `@llm`） |
| 5 | Task + Scheduler（M7+M6） | Workflows 适配（事件名净化/归并/超时）、deep-research 与 auto-delivery-lite 模板、cron 三种 action、HITL 全链路接通 |
| 6 | 飞书 + Observability + Management | 飞书 WS 长连接 Adapter（tag `@feishu`）、IdentityMapper 映射、Metrics/AuditLog、manage/* Agent、Dashboard 最小版、CLI 完备性核对 |
| 7 | E2E 验收 | 六条 E2E（真实部署+真实飞书+真实模型，`pnpm e2e`，CLI `--json` 驱动）；**E2E 通过 = 项目 Done**，此后进入维护态 |

## 全局 Done（DOD §0，五条同时成立）

1. 六个 User Case 的 E2E 全部通过（真实 Cloudflare + 真实飞书）。
2. 每个 Phase 的 DoD 全勾选且依据可重跑命令。
3. `pnpm verify` 一键绿。
4. 从零部署 30 分钟内可复现。
5. Watt CLI 覆盖全部管理面（M10 命令表 + 六条 E2E 以 `--json` CLI 驱动断言）。

## 成功标准补充（Vision §5）

六 Case 走通无旁路；新增 Context/工具/IM 来源 = 实现 Plugin 接口 + 注册；纯 HTTP fetch 的 Agent 能经 HTBP 发现并使用全部工具/Context；空闲月成本近零、成本随用量线性；每层可"对话/界面/命令行"三入口管理同一套接口。
