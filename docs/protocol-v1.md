# Protocol V1 设计稿

本文是 `packages/protocol` 的第一版设计稿，定义三组契约：

1. AgentSpec（6 字段最小集）
2. ContextPackage（5 字段最小集）
3. PlanScript Host API（8 函数）

附带 Session 资源与 ID 语法。字段范围已在 architecture.md 拍板，
本文给出具体 schema。状态：已评审定稿（2026-06-12），可据此实现
`packages/protocol`。

约定：schema 用 TypeScript 类型表达（实现期映射为 zod / valibot）；
所有 ID 为带类型前缀的字符串；所有大内容走 `ContextRef`，协议消息
本身保持小（Queues 消息上限 128 KB）。

## ID 语法

ID 前缀编码资源所有权，是结构性强制不变量的第一道防线
（参考 flue 的 run-id 语法，见 `docs/flue-reference.md`）：

```text
ws_<ulid>                          Workspace
task_<ulid>                        Task
run_<task_ulid>_<ulid>             Run（编码所属 Task）
arun_<run_ulid>_<seq>              AgentRun（编码所属 Run，seq 为
                                   Host 调用确定性序号）
trun_<run_ulid>_<seq>              ToolRun（同上）
agent_<ulid>                       Agent
agentv_<agent_ulid>_<rev>          AgentVersion（编码所属 Agent）
sess_<agent_ulid>_<ulid>           Session（编码所属 Agent；
                                   不含 run —— 会话不是 Run）
plan_<run_ulid>_<rev>              PlanVersion（编码所属 Run 与修订号）
ckpt_<ulid>                        Checkpoint
art_<ulid>                         Artifact
mem_<ulid>                         Memory
```

规则：

- `arun` / `trun` 的 `<seq>` 由 PlanScript Host 调用按发起顺序分配，
  保证重放一致性。
- `sess` 语法中没有 run 成分，`run` 语法中没有 session 成分。事件
  字段 `run_id` 与 `session_id` 互斥，schema 层 literal 锁死。
- 直连会话产生的模型调用、工具调用记账到 `session_id` 维度，与
  Run 维度的记账并列汇总到 workspace。

## AgentSpec（V1：6 字段）

Agent Factory 的输出、AgentVersion 的数据本体。纯数据，无代码。

```ts
interface AgentSpec {
  /** 1. 职责：进入 system prompt 的角色与职责描述 */
  instructions: string;

  /** 2. 输出契约：JSON Schema。Runtime 据此注入 finish/give_up
   *  工具，校验通过才算完成（机械验证的 schema 层） */
  outputSchema: JsonSchema;

  /** 3. 工具授权：白名单，引用 Tool 注册表中的工具名 */
  tools: ToolGrant[];

  /** 4. 模型设置 */
  model: {
    /** 形如 "deepseek/deepseek-chat" 的 specifier */
    id: string;
    temperature?: number;
    maxTokens?: number;
  };

  /** 5. Runtime target */
  runtime: 'worker' | 'actor' | 'sandbox';

  /** 6. 生命周期策略 */
  lifecycle: 'ephemeral' | 'persistent';
}

interface ToolGrant {
  tool: string;              // Tool 注册表中的名字
  /** 工具级约束，如 github 工具限定 repo 白名单 */
  scope?: Record<string, unknown>;
}
```

推迟到 V1 后的字段：输入契约、Context 权限细分、checkpoint 规则、
验证方式声明、敏感级别。当前由 ContextPackage 的 `permissions` 和
Runtime 默认策略兜底。

## ContextPackage（V1：5 字段）

Orchestrator / Manager 传给 Agent 的结构化上下文包。所有大内容走
ref，包本身保持小。

```ts
interface ContextPackage {
  /** 1. 目标：本次 AgentRun 要完成什么（自然语言，进入 user turn） */
  objective: string;

  /** 2. 输入引用：Agent 可解析的上下文引用 */
  inputs: ContextRef[];

  /** 3. 预算限制 */
  budget: {
    maxCostUsd: number;        // 模型+工具成本上限
    maxWallClockMs: number;    // 单次 AgentRun 墙钟上限
    maxToolCalls: number;      // 工具调用次数上限
  };

  /** 4. 期望输出：对 outputSchema 的补充说明（格式、语言、详略） */
  expectedOutput: string;

  /** 5. 权限范围 */
  permissions: {
    /** 可解析哪些 ref 类型/前缀，默认仅 inputs 中列出的 */
    contextScope: string[];
    /** 对 AgentSpec.tools 的进一步收窄（运行时交集） */
    toolScope?: string[];
  };
}

interface ContextRef {
  ref: string;                 // ckpt_/art_/mem_ 等带前缀 ID 或外部 URI
  summary: string;             // 一句话摘要，决定 Agent 是否解析
  sizeBytes?: number;
}
```

推迟：来源链、敏感级别、有效期、逐 ref 权限。

## PlanScript Host API（V1：8 函数）

PlanScript 沙箱内唯一可见的全局对象 `host`。所有函数返回
Promise；返回值一律是小型结构或 ContextRef（大结果落 R2）。
所有调用按发起顺序获得确定性 seq，journal 以 seq 为键。

```ts
interface Host {
  /** 1. 派发 AgentRun：用已注册 Agent 执行一段工作 */
  run(agent: string, ctx: ContextPackage): Promise<AgentRunResult>;

  /** 2. 直接工具调用：不经过模型，确定性执行一个已授权工具 */
  invoke(tool: string, args: Record<string, unknown>): Promise<ToolRunResult>;

  /** 3. 经 Agent Factory 生成临时 Agent，返回本 Run 内可用的句柄 */
  spawn(need: SpawnRequest): Promise<{ agent: string }>;

  /** 4. 写 checkpoint：阶段摘要 + 恢复点 */
  checkpoint(summary: string, refs?: string[]): Promise<{ ref: string }>;

  /** 5. 审批等待：暂停直到用户批准/拒绝；必伴随出站通知。
   *  拒绝即白名单重新计划事件 */
  approval(prompt: string, refs?: string[]): Promise<{ approved: boolean; note?: string }>;

  /** 6. 确定性睡眠（journaled，重放时快进） */
  sleep(ms: number): Promise<void>;

  /** 7. 等待外部事件（webhook、集成回调），带超时 */
  waitFor(eventKey: string, timeoutMs: number): Promise<WaitResult>;

  /** 8. 产物读写：写入 Artifact Store / 读取已有 artifact 元数据 */
  artifact(op: ArtifactOp): Promise<ArtifactResult>;
}

interface SpawnRequest {
  /** 需要什么能力（自然语言，Factory 的输入） */
  need: string;
  /** 工具授权上限：Factory 产出的 spec 不得超出 */
  maxTools?: string[];
  lifecycle?: 'ephemeral' | 'persistent';
}

interface AgentRunResult {
  status: 'ok' | 'failed';
  /** outputSchema 校验通过的结果（小型）或落 R2 后的 ref */
  output?: unknown;
  outputRef?: string;
  costUsd: number;
  /** failed 时的类型化错误，脚本可 catch 后降级（continue-on-error） */
  error?: { code: string; message: string };
}

interface ToolRunResult {
  status: 'ok' | 'failed';
  output?: unknown;
  outputRef?: string;
  costUsd: number;
  error?: { code: string; message: string };
}

interface WaitResult {
  status: 'received' | 'timeout';
  payload?: unknown;
}

type ArtifactOp =
  | { op: 'write'; name: string; contentRef: string; kind: string }
  | { op: 'get'; ref: string };

interface ArtifactResult {
  ref: string;
  name: string;
  kind: string;
  url?: string;
}
```

语义要点：

- 并发：脚本可一次发起大量 `run` / `invoke`（Promise.all /
  race / any），Host 按配额放行，超出排队，对脚本透明。
- 失败：单分支失败返回 `status: 'failed'` 而不是抛异常，脚本可
  catch 类型化错误降级；未捕获异常使 Run 进入失败状态。
- 预算：每次 `run` / `invoke` / `spawn` 前 Host 检查 Run Coordinator
  预算计数器，超限抛不可捕获的 BudgetExceeded，终止脚本。
- `spawn` 产出的 Agent 默认 ephemeral，Run 结束后回收；持久化走
  评估流程，不在脚本内决定。

## Session 资源（直连对话）

```ts
interface Session {
  id: string;                  // sess_<agent_ulid>_<ulid>
  agentId: string;
  agentVersionId: string;      // 创建时绑定的版本
  title?: string;
  createdAt: string;
  lastActiveAt: string;
  status: 'active' | 'archived';
}

/** POST /agents/:agentId/sessions/:sessionId/messages */
interface SessionMessageRequest {
  message: string;
  /** 可携带 ref，让用户把 artifact/checkpoint 拽进对话 */
  refs?: string[];
}

interface SessionMessageResponse {
  reply: string;
  usage: { totalTokens: number; costUsd: number };
  /** 会话内工具调用的审计摘要 */
  toolCalls?: { tool: string; status: string }[];
}
```

语义要点：

- 一个 Agent 任意多个 Session；同一 Session 内单飞（并发消息返回
  409，提示开新 Session）。
- 会话历史与 hot context 住 per-Agent actor（DO）；模型调用在无状态
  Worker 中执行，结果写回 actor（决策 4 的会话路径变体）。
- 会话不是 Run：无 plan、无 run id、不进 Run Store。事件带
  `session_id`，schema 与 run 事件互斥。
- 会话消息走与 AgentRun 相同的预算 / 成本 / 审计记账，按
  session 维度汇总。
- V1 同步请求-响应，不做流式；历史分页拉取。

## 与存储的映射

- AgentSpec / AgentVersion → Registry Store（D1）。
- ContextPackage 不落库：作为 AgentRun 命令的一部分进队列，
  超 128 KB 部分以 ref 外置 R2。
- PlanScript 本体 → Artifact Store（R2），PlanVersion 索引 → Run
  Store。
- Session 元数据 → Registry Store；会话历史 → per-Agent DO storage。
- Host journal → Run Coordinator（DO SQLite），Run 结束归档 R2。

## 已决问题

- `outputSchema` 用完整 JSON Schema（draft 2020-12），不做受限
  子集。实现注意：Workers 禁用 eval，不能用 ajv 默认编译模式，
  选用 Workers 兼容的解释型校验器（如 `@cfworker/json-schema`）；
  Planner 的 prompt 应引导模型生成尽量扁平的 schema，复杂度靠
  约定而非协议限制。
- `waitFor` 的 eventKey 用分层字面键：`<integration>/<event>/
  <correlation>`，如 `github/pr_merged/<owner>-<repo>-<pr>`、
  `approval/<run_id>-<seq>`。Integration Service 收到外部 webhook
  后按同一语法投递，waitFor 字面匹配；不做结构化过滤器。
- Session 历史 V1 就做模型压缩：超阈值时用廉价模型生成摘要，以
  压缩节点替换早期消息（参照 flue 的 compaction entry 进历史树的
  模式，见 `docs/flue-reference.md`）；摘要生成成本计入该 Session
  记账。上下文窗口溢出时的兜底仍是截断。
- `invoke` 不暴露幂等 key 参数：Host 以 `run_id + seq` 自动派生，
  脚本无感知；直连会话的工具调用以 `session_id + 消息序号` 派生。
  重放一致性由 seq 的确定性分配天然保证。
