# protocol 包契约检索地图

`packages/protocol`（`@watt/protocol`，zod v4 + ulid）是协议契约的代码落地。完整规范在 `docs/protocol-v1.md`，本文只做检索地图。

## 5 个 src 文件各管什么

| 文件 | 定义 |
| --- | --- |
| `packages/protocol/src/ids.ts` | 12 种资源 ID 正则（`ID_PATTERNS`）、各 ID zod schema、派生函数（`newRunId` 等，校验父 ID 类型）、`ResourceRef` 联合、幂等 key 派生（`idempotencyKeyForHostCall` / `idempotencyKeyForSessionMessage`） |
| `packages/protocol/src/agent.ts` | `AgentSpec`（6 字段）、`ContextPackage`（5 字段）、`ContextRef`、`Budget`、`ToolGrant`、`ModelSettings`、`JsonSchema` |
| `packages/protocol/src/host.ts` | `HOST_FUNCTIONS`（8 函数）、各函数参数 / 返回值 schema、`JournalEntry`（fn 判别联合）、`TypedError`、`BUDGET_EXCEEDED` |
| `packages/protocol/src/session.ts` | `Session` 资源、`SessionMessageRequest` / `SessionMessageResponse` |
| `packages/protocol/src/events.ts` | `RunEvent` / `SessionEvent` / `WattEvent`（scope 判别联合，run XOR session） |

`src/index.ts` 全量 re-export。

## ID 语法表

前缀编码所有权链，校验 ID 即校验归属（结构防线第一道）：

```text
ws_<ulid>                     Workspace
task_<ulid>                   Task
run_<task_ulid>_<ulid>        Run（编码所属 Task）
arun_<run_ulid>_<seq>         AgentRun（seq 为 Host 调用确定性序号）
trun_<run_ulid>_<seq>         ToolRun（同上）
agent_<ulid>                  Agent
agentv_<agent_ulid>_<rev>     AgentVersion
sess_<agent_ulid>_<ulid>      Session（无 run 成分——会话不是 Run）
plan_<run_ulid>_<rev>         PlanVersion
ckpt_<ulid>                   Checkpoint
art_<ulid>                    Artifact
mem_<ulid>                    Memory
```

派生函数校验父 ID 类型（如 `newRunId` 拒绝非 task id）。`invoke` 幂等 key 不暴露给脚本：Host 以 `run_id:seq` 派生，会话侧以 `session_id:消息序号` 派生。

## AgentSpec（6 字段，纯数据，未知字段被 zod 剥离）

1. `instructions` —— 职责，进入 system prompt。
2. `outputSchema` —— 完整 JSON Schema（runtime 据此注入 finish / give_up）。
3. `tools` —— `ToolGrant[]` 白名单（tool 名 + 可选 scope）。
4. `model` —— `{ id: "provider/model", temperature?, maxTokens? }`。
5. `runtime` —— `worker | actor | sandbox`。
6. `lifecycle` —— `ephemeral | persistent`。

## ContextPackage（5 字段，大内容走 ref）

1. `objective` —— 本次 AgentRun 目标。
2. `inputs` —— `ContextRef[]`（受认资源 ID 或 URL + 一句话摘要）。
3. `budget` —— `maxCostUsd / maxWallClockMs / maxToolCalls` 三限全必填。
4. `expectedOutput` —— 对 outputSchema 的补充说明。
5. `permissions` —— `contextScope` + 可选 `toolScope`（对 AgentSpec.tools 的运行时交集收窄）。

## Host API 8 函数（只加不改）

`run`（派发 AgentRun）/ `invoke`（直接工具调用）/ `spawn`（经 Factory 生成临时 Agent）/ `checkpoint` / `approval`（必伴随出站通知）/ `sleep`（journaled）/ `waitFor`（eventKey 分层字面键 `<integration>/<event>/<correlation>`）/ `artifact`（write / get 判别联合）。

返回值语义：单分支失败返回 `status: 'failed'` + `TypedError`（脚本可 catch 降级），不抛异常；预算超限抛不可捕获的 `BUDGET_EXCEEDED` 终止 Run。`JournalEntry` 以 seq 为键、fn 判别，pending 调用无 result，params 与 fn 不匹配即拒。

## zod v4 用法注意

- 日期时间用 `z.iso.datetime()`，URL 用 `z.url()`（不是 v3 的 `z.string().datetime()` / `z.string().url()`）。
- 自定义报错用 `{ error: '...' }` 参数，不是 v3 的 `message`。
- `z.record` 必须显式给 key schema：`z.record(z.string(), z.unknown())`。

## 测试覆盖的三道防线（`packages/protocol/test/`）

- `ids.test.ts`：ID 语法编码所有权、session 语法无 run 成分、派生函数拒绝错误父类型、幂等 key 确定性。
- `host.test.ts`：journal seq 键 / fn 判别 / pending 无 result / params-fn 不匹配拒绝、事件 run XOR session（错误 scope 的 id 被拒、越界字段被剥离）。
- `agent.test.ts`：AgentSpec 6 字段全必填、纯数据（未知字段剥离）、ContextPackage 预算三限、ref 只收受认资源 ID 或 URL。
