# Watt 愿景

Watt 要做的不是一个更会聊天的 Agent。

Watt 要做的是一套让 Agent 可以长期、廉价、可靠地工作的基础设施。它让 Agent
从一次性对话，变成可以被大量创建、持续唤醒、稳定编排、接入真实世界并交付
结果的行动单元。

一句话说：

> Watt 把 Agent 从对话产品，变成 7x24 小时工作的基础设施。

## 核心承诺

Watt 的长期价值建立在五个承诺上。

### 1. 7x24 小时在线的 Agent

Watt 中的 Agent 不应该只是一次请求里的临时对象。

它应该长期存在，拥有稳定身份、状态、上下文、权限、运行记录和恢复能力。即使
它没有持续占用 CPU，它也应该始终可寻址、可唤醒、可继续工作。

这意味着用户可以把任务交给 Watt，然后放心离开：

- 明天它还在。
- 一周后它还记得任务背景。
- 任务失败后它能从 checkpoint 恢复。
- 外部事件到来时它能被唤醒。
- 用户回来时它能汇报自己做了什么。

Watt 追求的不是“进程永不退出”，而是“Agent 能力永不消失”。

### 2. 借助廉价 runtime 海量创建 Agent

传统 Agent 很容易变成昂贵资源：一个 Agent 对应一个容器、一个进程、一份长
上下文、一组长期占用的计算资源。这样的模型无法让用户随意创建大量 Agent。

Watt 的判断相反：

> Agent 应该像函数、对象、任务和消息一样便宜，便宜到可以被大量创建。

借助 Cloudflare Workers、Durable Objects、Queues、Workflows、D1、R2、
Containers 这类低成本、按需唤醒的基础设施，Watt 可以让不同类型的 Agent
选择不同运行形态：

- 轻量 Agent 运行在 Worker 或类似 serverless runtime 中。
- 长期有状态 Agent 运行在 actor / Durable Object 类 runtime 中。
- 重型任务 Agent 按需进入 Container、Sandbox 或 Kubernetes Job。
- 临时 Agent 完成任务后可以回收。
- 有价值的 Agent 可以被持久化、版本化、公开和复用。

这会带来一个重要变化：Agent 不再是稀缺角色，而是一种可大量生成的计算组织。

当任务复杂时，Watt 可以生成一组临时 Agent Team；当任务结束后，这些 Agent
可以被删除、沉淀为 memory，或升级成新的 reusable capability。

### 3. 廉价但可靠的运行经济学

Watt 的基础设施路线必须同时满足两个条件：

- 足够便宜。
- 足够可靠。

便宜来自四个方向：

- 廉价 runtime：空闲时不持续烧计算，按事件唤醒。
- 廉价模型：优先使用 DeepSeek 官方 API，并围绕 prefix cache 设计 prompt。
- 廉价存储：用 D1、Durable Object storage、R2 等低成本存储承载状态和工件。
- 廉价编排：用队列、workflow、checkpoint 替代重型常驻进程。

可靠则不能依赖“进程一直活着”。可靠应该来自协议和状态机：

- 每个任务都有 Run。
- 每个阶段都有 checkpoint。
- 每个结果都有 artifact。
- 每个 Agent 有版本。
- 每次工具调用有记录。
- 每个失败都能被观察、重试或解释。

Watt 要证明一件事：低成本不等于脆弱。只要运行模型设计正确，廉价 runtime、
廉价模型和廉价存储也可以组成可靠的 Agent 系统。

### 4. 良好的 Agent 编排与可靠结果交付

Watt 不应该让 Agent 之间随意自然语言聊天，然后期待结果自然出现。

它应该把用户意图转化为可执行结构：

```text
Intent
  -> Mission
  -> Context Package
  -> Agent Spec
  -> Workflow / Run Graph
  -> Checkpoint
  -> Artifact
  -> Memory
  -> Capability
```

这里的重点不是“多个 Agent 互相对话”，而是“任务被可靠交付”。

Watt 应该能够：

- 把用户目标转成 Mission。
- 选择已有 Agent，或自动生成新的 AgentSpec。
- 为每个 Agent 分配清晰职责、输入输出和工具权限。
- 把上下文打包为可传递的 Context Package。
- 把复杂工作拆成 Workflow 和 Run Graph。
- 在关键阶段写 checkpoint。
- 产出 artifact，而不是只产出聊天文本。
- 对结果进行验证、汇报和沉淀。

用户最终应该得到的是：

- 一份清晰报告。
- 一组可打开、可验证的结果工件。
- 一个说明过程和风险的执行摘要。
- 一批可进入长期记忆的经验。

这就是 Watt 和普通 Agent 聊天框的区别：Watt 以交付为中心。

### 5. 全面的基础设施接入

Agent 如果只能留在聊天框里，就无法真正完成工作。

Watt 必须让 Agent 接入真实世界的基础设施：

- GitHub：repo、issue、PR、文档、代码、项目记录。
- 搜索与网页：外部信息获取、调研、监控。
- 文件与对象存储：报告、日志、数据集、产物。
- 代码运行环境：脚本、测试、构建、浏览器自动化。
- 邮件、日历、文档系统：个人工作流。
- 支付、财务、生活服务：更广泛的个人自动化。
- 企业系统：权限、部门、流程、审批、知识库。
- 外部 Agent 协议：未来接入 Codex、Claude Code、OpenCode 等能力。

Watt 的 Integration Layer 不只是“插件市场”。它应该定义外部能力如何被安全地
接入 Agent 运行：

- 工具能力如何声明。
- 凭证如何保存和注入。
- Agent 能访问哪些上下文。
- 哪些操作需要审批。
- 每次外部副作用如何审计。
- 结果如何变成 artifact 或 memory。

Agent 要能行动，就必须接入基础设施。Watt 要做这层接入。

## 自动生成 Agent 是 Watt 的关键能力

Watt 不应该只运行预先写好的 Agent。

当用户提交一个新任务时，Watt 应该能根据任务、可用工具、历史 memory、上下文
和交付目标，自动生成适合这个任务的 AgentSpec。

一个 AgentSpec 至少应该描述：

- 这个 Agent 的职责。
- 它接受什么输入。
- 它应该产出什么输出。
- 它可以使用哪些工具。
- 它可以读取哪些 context。
- 它应该运行在哪个 runtime。
- 它是临时 Agent 还是可持久化 Agent。
- 它完成任务后如何写 checkpoint。
- 它的结果如何验证。

自动生成 Agent 的完整链路可以是：

```text
Task
  -> Manager 分析目标
  -> 生成 Mission
  -> 生成一个或多个 AgentSpec
  -> 创建 AgentVersion
  -> 部署临时 Agent
  -> 执行 Run
  -> 写入 Checkpoint 和 Artifact
  -> 评估是否持久化为可复用 Agent
```

这样，Watt 会逐渐形成自己的能力库。

一开始它只有少量内置 Agent；随着用户不断完成任务，它会积累新的 Agent、
新的 Workflow、新的 memory 和新的工具组合。系统越用越懂用户，也越能自动
产出合适的执行组织。

## Context 是行动的传递介质

Watt 的 Context 不是一个数据库表，也不是聊天历史。

Context 是 Agent 行动时传递的材料、边界和依据。

当 Manager 把任务交给 Research Agent，不应该只发一句自然语言指令；它应该传
一个结构化 Context Package：

- 任务目标。
- 当前状态。
- 相关 checkpoint。
- 可用 memory。
- artifact 引用。
- 工具输出引用。
- 权限和限制。
- 成本和时间预算。
- 期望输出格式。

大型上下文不应复制给每个 Agent，而应通过引用传递：

- `memory_ref`
- `checkpoint_ref`
- `artifact_ref`
- `repo_ref`
- `external_context_ref`

每个引用都应带有摘要、来源、权限范围、敏感级别和有效期。

这样做有三个好处：

- 成本更低：不重复传递大上下文。
- 结果更可靠：每个 Agent 知道自己依据了什么。
- 权限更清晰：Agent 只能读取被授权的上下文。

Context Package 是 Watt 编排 Agent 的核心媒介。没有它，Agent Team 只是一群
会聊天的角色；有了它，Agent Team 才能成为可审计、可恢复、可交付的执行系统。

## 一个未来场景

用户说：

> 帮我每天跟踪 Cloudflare Agent runtime、DeepSeek 模型和开源 coding agent
> 的变化。重要内容写入 GitHub；每周生成总结；如果发现值得尝试的新技术，
> 自动创建一个实验任务。

Watt 应该这样工作：

1. 把用户意图转成一个长期 Mission。
2. 生成 Daily Research Workflow 和 Weekly Summary Workflow。
3. 创建或复用 Research Agent、Source Tracker Agent、Reporter Agent、
   Memory Agent、Experiment Planner Agent。
4. 为每个 Agent 构造 Context Package。
5. 每天按计划唤醒轻量 Agent 做调研。
6. 对重要材料生成 checkpoint。
7. 把报告写入 GitHub artifact。
8. 每周汇总趋势和变化。
9. 如果发现新机会，自动创建实验任务和临时 Agent Team。
10. 把有价值的流程、AgentSpec、结论沉淀为长期能力。

用户不需要每天重新发 prompt，不需要手动复制链接，不需要重新解释偏好。
Watt 会在低成本基础设施上持续工作，并把结果交付到用户关心的地方。

## Watt 不是什么

Watt 不是单纯聊天 UI。

聊天只是入口之一，真正重要的是持续任务、状态、上下文和交付。

Watt 不是纯控制面。

它有 Control Plane，但同时也有 Runtime Plane、Agent Factory、Context
Fabric、Workflow Orchestrator 和 Integration Layer。

Watt 不是只负责调用外部 Agent 的壳。

它应该优先运行自己的 Agent，并在未来通过协议接入外部 Agent。

Watt 不是通用 Kubernetes 替代品。

它借鉴 Deployment、Controller、Run、Workflow 等思想，但它服务的是 Agent
工作负载，而不是任意容器工作负载。

## 最终图景

Watt 希望让个人拥有一套自己的 Agent 基础设施。

这套基础设施可以低成本地创建大量 Agent，让它们围绕用户目标长期工作；可以把
上下文可靠地传递给合适的 Agent；可以把工作拆解、运行、恢复和验证；可以接入
真实世界的工具和系统；可以把每次任务的经验沉淀为记忆和新能力。

成熟后的 Watt，不是一个“更聪明的助手”，而是一组围绕用户目标持续生长的行动
能力。

它让一个人可以用极低的成本，拥有一支 7x24 小时在线、可大量创建、可持续
学习、能接入基础设施并可靠交付结果的 Agent 队伍。

