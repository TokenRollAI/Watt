# Watt 重定位设计稿（v0）

状态：草案，待 review。目的：回应"现状像又一个 Agent SDK、缺基础设施价值"的判断，
把 Watt 重新校准回 `vision.md` / `architecture.md` 设定的"Agent 运行基础设施"定位，
并给出能力层、可靠交付、分阶段路线。本文不替代 `architecture.md`（仍是边界权威），
只做一次"定位复核 + 落地次序"的收口。

---

## 0. 一句话定位

> Watt 不是"帮你写并运行一个 Agent 的框架"，而是"让大量 Agent 长期、廉价、可靠运行的
> 基础设施"。Agent 跑在 Watt 上，**自动获得**持久化、可观测、可回滚、配额保障与原子
> 能力注入——就像 Pod 跑在 K8s 上自动获得调度、重启、网络、存储、配额。

判定标准（用来回答"我为什么不直接用 Cloudflare Agent SDK / Flue"）：
**凡是 Agent 自己要操心的事，都不算 Watt 的价值；凡是平台替 Agent 兜住、且单个 Agent
框架给不了的事，才是 Watt 的价值。**

| 框架（CF Agent SDK / Flue）给你 | Watt 在其之上必须额外给你（否则没有存在价值） |
| --- | --- |
| 定义一个 Agent、给它工具、跑起来 | 跑**一群** Agent，且每个都有身份、Run 记录、事件流、可回滚 |
| 单个 agent loop | Intent→Mission→Plan→Run 的**可靠交付链**与**确定性调度** |
| 你手动给工具 | **能力层默认注入**：Agent 声明权限，平台提供原子能力 |
| 进程活着才在 | 7x24 可寻址、可唤醒、按事件恢复 |
| 自己看日志 | 控制台：所有 Run/Agent 在跑什么、花了多少、状态如何 |

---

## 1. 现状诊断：我们造好了"执行引擎"，没造"平台"

已落地（可用、有测试）：
- `protocol`：资源/ID/事件/Host API 契约（设计权威已成代码）。
- `runtime-core`：Agent turn loop（runAgent）+ 预算计 + finish/give_up 机械验证。
- `model-deepseek`：薄模型层。
- `plan-script`：QuickJS 沙箱 + replay/journal + 静态校验（Script Runner 的核心）。
- `storage`：五个窄 store 接口 + **内存实现**（RunStore 含事件日志与 journal）。
- 3 个 Worker（agent-gateway / research-team / web）：把上述拼成可跑的 demo。

**结构性缺口（= 用户批评的根因）**：所有 Worker 都把执行**活在单个 HTTP 请求的内存里**，
storage 的五个 store 接口**一个都没接进 Worker**，没有 Cloudflare adapter（D1/DO/R2）。
于是：

| 用户的批评 | 根因（架构层） | docs 里其实早有设计 |
| --- | --- | --- |
| 工具不原子、Agent 自带一堆工具 | 没有**能力层**：工具是 per-app 手塞的 | architecture「Tool Layer / Integration Layer」、protocol `ToolGrant` 授权模型 |
| 缺持久化/查看/回滚，笨重 | Run 不是持久资源，事件不落库，无 checkpoint 回滚 | architecture「Run Coordinator / Run Store / Checkpoint」 |
| 目标转化没做 | 没有 Mission Layer，用户原话直接进 objective | architecture「Mission Layer：Intent→Mission→Task」 |
| Manager 不是真 Manager | 产出 PlanScript 即当场跑，无"确认→派发→监工→交付"闭环 | architecture「决策 1：Planner 产数据、Scheduler 调度」+「Delivery」 |
| Context 不透明、预算太死、无 compact | ContextPackage 不可见、预算是硬常量、runtime 无上下文压缩 | architecture「Context Layer」、protocol `ContextPackage`、flue-ref 第 5 节（compaction） |
| 没有给非技术用户的运行/成本视图 | 无控制台（只有一次性结果页） | architecture「Web UI：查看 Run 状态/事件/成本」 |

结论：**几乎不需要新设计，需要的是把 architecture.md 已设计、storage 已留接口的"平台层"
真正落地，并把现有 demo 的应用逻辑下沉为平台能力。** 这与"保留、演进式重构"一致。

---

## 2. 能力层（Capability Layer）——你点名的核心

定位：Agent **不自带工具**。它在 AgentVersion 里**声明需要哪些能力**（`ToolGrant` 白名单），
平台在派发时**注入**对应原子能力的实现，并审计每次使用。这对应 architecture 的 Tool Layer +
Integration Layer，是目前完全缺失、最该先补的一层。

### 2.1 设计原则
- **原子性**：能力是最小可授权单元（`web.search` / `web.fetch` / `artifact.write` /
  `memory.read` / `agent.spawn` / `bash.exec`），不是"research 工具"这种复合体。
- **默认提供**：平台预置一组标准能力，新建 Agent 即可用；应用不再在代码里临时拼工具。
- **声明即获得**：Agent 只写 `tools: [{tool:'web.search'}]`，实现由平台注入（现状是
  app 手动 `makeWebTools()` 塞进 runAgent——正是要消除的反模式）。
- **开放可扩展**：能力是注册表里的条目，新增能力走常规发布（决策 3：新代码走发布，
  不在运行时部署）。第三方/用户可注册自有能力。
- **像 K8s 探针那样的标准底层能力**：除业务工具外，平台还应提供"Agent 健康/就绪"这类
  **平台标准能力**——见 2.3。

### 2.2 两类能力来源
1. **平台原生原子能力**（预置、注入）：`web.search`、`web.fetch`、`artifact.{read,write}`、
   `memory.{read,write}`、`agent.spawn`、`checkpoint`、`approval` 等。映射到 Host API 与
   Tool 注册表。这是"默认 Agent 能力"的主体。
2. **Bash / Container 逃生舱**（开放扩展）：提供 `bash.exec`（跑在 Sandbox/Container 里的
   bash），让 Agent 能做平台没预置的任意事（装包、跑脚本、操作 repo）。这对应
   architecture「Sandbox Runtime」+「Containers」。原则：**能用原子能力就用原子能力
   （可审计、可计费、可授权），兜底才用 bash**。bash 出站走 outbound handler 代理（凭证
   注入 + 白名单），与 architecture「Sandbox 出站控制」一致。

### 2.3 平台标准能力（K8s 类比）
借 K8s 的 readiness/liveness 思路，Watt 应把若干"运行契约"做成**平台标准能力/钩子**，
而非每个 Agent 自己实现：
- **readiness**：Agent 是否已就绪可接活（AgentVersion 校验通过、依赖能力可用、预算未超）。
- **liveness / 心跳**：长任务 Agent 周期性写心跳到 Run Coordinator，平台据此判定卡死并重试。
- **机械验证（已有雏形）**：finish/give_up 的 schema 校验就是"输出就绪探针"，应升格为平台
  标准交付门，而非藏在 runtime-core 内。
- **预算/配额准入**：派发前的预算检查应是平台准入控制器（admission），不是应用层 if。

### 2.4 默认 Agent
预置几个开箱即用、能力由平台原生赋予的 Agent（对应 vision「一开始只有少量内置 Agent」）：
- **Researcher**（带 `web.search`/`web.fetch`/`memory`）
- **Reporter / Synthesizer**（带 `artifact.write`）
- **Coder / Operator**（带 `bash.exec` + sandbox）
- **Manager**（见第 3 节，带 `agent.spawn`/`plan` 能力）
用户不必定义工具即可用这些 Agent；要自定义时再声明能力或注册新能力。

---

## 3. 可靠交付链——把 Manager 变成真 Manager

现状：Manager = 一次性 PlanScript 生成器。目标：Manager 是**贯穿一次交付的角色**，
落地 vision 的 `Intent → Mission → Context → Plan → Run → Checkpoint → Artifact → Memory`。

### 3.1 目标转化（Mission Layer，对应批评 3a）
- 新增**意图转化**步骤：用户自然语言 → 结构化 Mission/Task（目标、约束、成功标准、预算、
  期望产出）。V1 按 architecture 边界先以"带结构化字段的 Task"表达，不引入独立 Mission 资源。
- 用户看到的是"我的目标被理解成了什么"，可确认/修正——而不是原话直接进 prompt。

### 3.2 Manager 闭环（对应批评 3b）
当前 `生成 PlanScript → 立即执行`，改为：
```
Intent → (Mission) → Manager 生成 PlanScript（PlanVersion v1，持久化、可见、可校验）
       → 用户/策略确认（可编辑脚本 → PlanVersion v2）        ← 新增确认/编辑环节
       → Scheduler 派发执行（Run，事件落库，可观测）
       → Manager 监工（失败/审批/重新计划，受白名单硬事件触发）
       → Delivery 交付（报告 + artifact + 验证摘要 + memory 候选）
```
关键：PlanScript 成为**可见、可编辑、可版本化的资源**（`plan_<run>_<rev>`），这直接回答
用户上一轮的三个问题（怎么看/怎么改/怎么版本化）。

### 3.3 透明 Context + 弹性 runtime（对应批评 3c）
- **Context 透明**：每次 `host.run` 传出的 ContextPackage（objective/inputs refs/budget/
  权限）应可在控制台查看——"这个 subagent 拿到了什么、被授权了什么、预算多少"。
- **预算是策略不是死数**：当前 budget 是 PlanScript 里硬写的常量 + driver 的 floor。应升级为
  workspace/Task 级**预算策略**，按角色派生，超限是平台准入控制而非应用 if。成本逐级汇总
  （AgentRun→Run→Task→workspace），控制台可见（对应批评 4）。
- **runtime 补 compact**：runtime-core 增加上下文压缩（flue-ref 第 5 节：历史树 + compaction
  节点 + 压缩成本计入触发调用），解决"预算太死/长任务上下文爆"的问题。

---

## 4. 控制平面与控制台（对应批评 2、4）

把执行从"内存里的一次性对象"变成**持久、可寻址、可观测的资源**：
- **Run Coordinator（DO）**：每个 Run 一个 DO，持 PlanVersion 引用、事件日志、journal、预算
  计数器（architecture「调度器设计」已详述；flue-ref 证明可行）。决策 4：DO 不 await 模型，
  模型调用在 Worker 请求上下文 / Queue consumer。
- **事件落库 + 查询投影**：RunEvent/SessionEvent 写 DO SQLite，归档 R2，索引投影 D1。
  storage 的 RunStore 接口已就绪，缺 Cloudflare adapter。
- **Checkpoint / 回滚**：Host `checkpoint` 已在协议里；落地为可恢复点，支持回滚重放
  （plan-script 的 journal replay 已支持，缺持久化层接线）。
- **控制台 UI**：面向（含非技术）用户——Run 列表、Run 详情（各 subagent 状态/记录、
  ContextPackage、PlanScript、事件流）、**成本与预算消耗看板**、Agent 注册表与直连会话。
  现有 `apps/web` 演进为此控制台。

---

## 5. 分阶段路线图（演进式，不推翻现有）

每阶段都让"基础设施属性"更实，且保持现有 demo 可跑。

- **M1 — 持久化底座 + 控制台只读**：接 storage 的 Cloudflare adapter（先 D1+R2，Run/事件/
  PlanVersion 落库）；research 流程改为先建 Run、PlanScript 存为 PlanVersion、事件落库；
  控制台加 Run 列表/详情（看状态、看 PlanScript、看各 subagent 记录与成本）。
  → 直接交付用户上一轮三问（看/版本化）+ 本轮的持久化/查看/成本可见。
- **M2 — 能力层**：建 Tool/Capability 注册表，把 web.search/fetch/artifact/memory/spawn 做成
  注入式原子能力；Agent 改为声明权限、平台注入；预置默认 Agent。消除 app 手塞工具。
  → 交付"工具原子性 / Agent 不自带工具 / 默认能力"。
- **M3 — Manager 闭环 + 可编辑 PlanScript**：拆 `生成`/`确认编辑`/`执行` 三步；PlanScript 可
  改可重跑可版本化；Manager 监工与白名单重新计划。
  → 交付"可靠交付 / 真 Manager / PlanScript 可改"。
- **M4 — DO Run Coordinator + 实时**：Run 状态以 DO 为权威，控制台实时（轮询起步，后续 SSE）；
  心跳/readiness 等平台标准能力；bash/Container 逃生舱 + 出站代理。
  → 交付"运行中实时可见 + 平台标准能力 + 开放扩展"。
- **M5 — 弹性 Context/预算 + Delivery**：runtime compact；预算策略化；Delivery 产报告/artifact/
  验证摘要/memory 候选（GitHub 集成作为第一参考）。

每个 M 都是独立可部署、可验证的切片，符合"演进式重构、保留现有"。

---

## 6. 待你拍板的取舍（影响实现次序）

1. M1 持久化先用 **D1+R2 投影**（查询友好、先做"跑完可查"）还是直接上 **DO Run
   Coordinator**（实时但工作量大）？建议先 D1+R2（M1），DO 留 M4。
2. 能力层的 **bash/Container 逃生舱**是否 M2 就要（需要 Container 绑定与出站代理，较重），
   还是 M2 先做原生原子能力、bash 留 M4？建议后者。
3. 默认 Agent 的**最小集**先做哪几个（Researcher/Reporter/Manager 够不够起步）？
4. 控制台是否仍以单 Worker 内联 HTML 演进，还是引入构建链做更完整的前端？
