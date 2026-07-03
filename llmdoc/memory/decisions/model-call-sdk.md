# 决策：模型调用 SDK = Vercel AI SDK（ai@6 + @ai-sdk/anthropic@3）

> 2026-07-03。取代此前 `@anthropic-ai/sdk` 选型；再取代更早的手拼 HTTP。

## 决定

`packages/gateway/src/agent/harness/anthropic-caller.ts` 的模型调用用 **Vercel AI SDK**：
`ai` + `@ai-sdk/anthropic` 的 `createAnthropic({ apiKey, baseURL, fetch })` + `generateText`。

## 为什么不是 `@anthropic-ai/sdk`

- **供应商中立**：换 provider（OpenAI 兼容 / 其它中转）只改工厂函数，调用点 `generateText` 不动。用户明确要"兼容更多 provider"。
- **workerd 兼容**：`ai` 是纯 JS、无 native build、无 Vercel 基建依赖，官方支持 Cloudflare Workers；vitest-pool-workers 下全套单测通过（323 passed）。

## 为什么不是 pi SDK（`@earendil-works/pi-coding-agent`）

评估后排除：它是**完整的编码 agent 会话框架**（自带 session/工具执行/事件流），且 **Node.js only**（依赖文件系统会话存储、`~/.pi` 配置目录、`process.cwd()`），文档对非 Node 集成只推荐子进程 RPC——**在 workerd isolate 里起不来**，且与已落地的 Cloudflare Agents SDK（`AgentInstance`）正面冲突。持久化 Agent / agent loop 仍归 Agents SDK，不引 pi。

## 版本锁定（关键约束）

**ai@6（6.0.219）+ @ai-sdk/anthropic@3（3.0.92）**，勿升 ai@7。
原因：`agents@0.17.3`（Agent Runtime 框架）的 peer 是 `ai@^6.0.0`；装 ai@7 会触发 peer 冲突。`@ai-sdk/anthropic` 的 dist-tag `ai-v6` = 3.0.92（配 ai@6），`latest`(4.x) 配 ai@7。zod peer `^3.25.76 || ^4.1.8`，本仓库 zod@4.1.11 满足。

## workerd 适配要点

- **必须用 `createAnthropic()` 工厂显式传 apiKey/baseURL**（从 env binding 取）；禁用裸 `import { anthropic }`——Workers 无 `process.env`，裸 provider 会静默读 env 失败。
- **baseURL 需含 `/v1`**：`createAnthropic` 缺省 baseURL 是 `https://api.anthropic.com/v1`，其后拼 `/messages`。中转期望 `${根}/v1/messages`，故 caller 内 `withV1Suffix` 把中转根（`https://llm.fantacy.live`）补成 `${根}/v1`。

## 边界（LOOP 纪律 4）

- 此 harness = **单次调用**（`generateText`，文本进/文本出）；**schema 校验重试留在 `llm.ts`**（`validateAgentOutput` + `shouldRetry` 循环），保留 Proto §3.4「携带违规反馈退回重发」协议语义，不交给 SDK 的 `generateObject` 黑盒重试。故 schema 路径不依赖中转对 glm-5.2 的原生结构化输出。
- 多轮工具调用循环（Phase 5+ deep-research 等）走 Agents SDK `AIChatAgent` / Claude Agent SDK / Flue，禁止在此文件自增 loop。

## 体积

gateway worker 打包 gzip 491.86 KiB（Total Upload 2788.92 KiB），远低于 Workers 免费档 3 MiB / 付费 10 MiB 门槛。

## 未验证（留 @llm 真实测试 / team-lead）

SDK 真实网络往返 + 中转对 `generateText`/glm-5.2 的响应形状（`{ text }` 提取）——需 `LLM_TESTS=1 ANTHROPIC_API_KEY=<key>` 冒烟。单测用 fake caller 不触网络。

相关：[[flue-attribution]]（Flue = withastro/flue，Phase 5+ agent loop 候选）。
