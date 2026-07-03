# 当前项目状态快照

> 本文档随轮次更新。最后更新：2026-07-03（Round 13，Phase 3 关门）。

## 阶段

- 规格真源：`Docs/{Vision,Architecture,Proto,Plugin,Reference}.md` + `DOD.md`（验收）+ `LOOP.md`（执行契约）。
- Phase 0 已关门（2026-07-02 Round 3）；Phase 1 已关门（2026-07-02 Round 7）；Phase 2 已关门（2026-07-03 Round 10）；**Phase 3（Context Layer）已关门**（2026-07-03 Round 13：质量关口 4 维 review + 对抗核查确认 16 MAJOR 全修（0 误报），DoD 线上全链复验通过，证据 `PROGRESS.md` Round 11/12/13）。
- **下一目标：Phase 4（Tool Layer + Agent Runtime）项 1**——**先派 investigator 调研 tool-bridge 上游现状**（LOOP §2.1 上游通道）。
- Phase 3 遗留：14 条 MINOR backlog（List opts 未校验 NaN、成功响应信封不一致未成文、§11.3a List 权限裁剪只做前缀级等）不阻塞；Phase 3 实现声明簇见 doc-gaps **#26**（core context：TTL 边界含等 / URI 解析 / 前缀段边界匹配 / applyPatch 语义）与 **#27**（关门簇：vector D1 sidecar / unmount 只卸载 / ~help 免认证 / readOnly 403 / 响应信封形状真源）。
- Phase 2 遗留：17 条 MINOR backlog（dedupe check-then-put 并发窗、fetchDeliverer 无超时、~skill #21、cursor 分页 #22 等）不阻塞，随后续 Phase 顺手修；Phase 2 实现声明簇见 doc-gaps #25（source.kind 规约 / HITL 系统投递免 Check / Signal 桩留 Phase 5 / DLQ 重放留 Phase 6 等到期收口项）。
- Phase 路线：0 骨架/部署管道 → 1 Auth+Event 信封 → 2 Event Gateway → 3 Context Layer → 4 Tool+Agent Runtime → 5 Task+Scheduler → 6 飞书+Observability+Management → 7 六条 E2E 验收（详见 [../overview/project-overview.md](../overview/project-overview.md)）。

## 源码现状（Round 13 后，测试共 511 个：shared 6 + core 216 + cli 62 + gateway 227；core 覆盖率 100%（327/327），门禁挂 verify）

- `packages/shared` — `WattError`（规范 7 码，裸 body 契约见 [../memory/decisions/bare-watterror-body.md](../memory/decisions/bare-watterror-body.md)）。
- `packages/core`（@watt/core，平台核心纯逻辑，零 Cloudflare 依赖）：
  - `src/authz/` — `authorize()` §6.4c 四步判定（过期优先于 approved 的判定次序有测试锁死）+ subject 匹配 + 工具动作映射（unknown tool 先查 TOOL_ACTIONS 表再鉴权，read-only 得 400 非 403）。
  - `src/event/` — Event 信封（128KB 上限、DedupeStore 接口）+ `envelope.ts` normalizeEvent **occurredAt 保留语义**：调用方已提供则保留、缺省才补接收时刻（§2.1 Decode 义务，Proto §2.3 已加规范性澄清，doc-gap #24）+ `types.ts` 新增 `eventInputSchema`（Publish 入参 zod 校验层）。
  - `src/auth/` — `jwt.ts`（jose Ed25519 sign/verify/JWKS，密钥注入）+ `device-flow.ts`（RFC 8628 grant 状态机 / token exchange + `normalizeUserCode`）。均为纯逻辑，测试无需 workerd。
  - `src/eventbus/` — 订阅匹配与出入站纯逻辑（Round 8 新增）：`types.ts`（Subscription/OutboundMessage/ChannelConfig zod）、`matches.ts`（订阅匹配：全 AND、缺省跳过、type 后缀通配 `"*"`/`"im.*"` 前缀含点）、`instance-key.ts`（instanceBy 三态 → SpawnRequest.instanceKey 幂等键；session 态缺 session → invalid_argument，doc-gap #23）、`inbound.ts`（processInbound：Verify 失败 permission_denied 拒收短路）、`outbound.ts`（outbound.message → `event://<channel>/<target>` write + authorize() 组合）、`hmac.ts`（WebCrypto HMAC-SHA256 + 常量时间比较，`sha256=<hex>`）。
  - `src/context/`（Round 11 新增，Context Layer 纯逻辑）：`types.ts`（NamespaceMount/ContextEntryMeta/ContextEntry/ContextPatch/ContextEntryInput zod；contextEntryInputSchema 已收紧 content 必须存在，Round 13）、`resolve.ts`（`context://` URI 解析 + namespace 最长前缀**段边界**匹配）、`ttl.ts`（isExpired 纯判定，`nowMs >= expiresMs` 含等即回收，无 ttl 永不过期）、`verbs.ts`（checkIfVersion→conflict / requireExisting→not_found / applyPatch metadata 浅合并 + content 替换）、`help.ts`（generateContextHelp + parseHelpDsl 最小 parser，doc-gap #21 parser 部分收口）。实现声明见 doc-gaps #26。
- `packages/gateway`（Hono Worker，入口 `export default {fetch, queue}` + export EventRouter）：
  - `src/authz/` — `policy-store.ts`（D1 四动词 + Delete；`list` 遵守 §0.2/§6.2 ListOptions/Page 契约，cursor 延后见 doc-gap #22）、`identity-mapper.ts`、`seed.ts`（幂等 + isolate 级 once-guard，导出 `resetSeedGuardForTests`）、`device-store.ts`（KV 双索引 + expirationTtl）、`keys.ts`。
  - `src/event/`（Round 9/10 新增）— `event-store.ts`（D1 list/get/put/delete/findByDedupeKey，挂 watt-events 库）、`channel-store.ts`（ChannelConfig 四动词）、`event-bus.ts`（publish 服务：authorizeOutbound → normalizeEvent → 128KB 校验 → dedupe 幂等短路 → EventStore.put → queue.send；**queue.send 失败补偿**为 best-effort 删留痕防 dedupe 吞重试，返回 unavailable/retryable；channelUser→IdentityMapper.Resolve 接线，未映射→`user:anonymous`）、`event-router.ts`（首个 DO：原生 DurableObject + ctx.storage.sql，订阅表 + session_instances 粘性映射，单例 `idFromName('router')`，RPC subscribe/unsubscribe/listSubscriptions/matchSubscriptions）、`consumer.ts`（queue handler：webhook sink fetch 投递 ack/retry；**§1.1 HITL system subscriber**：task.checkpoint→带 actions 的 outbound.message 卡片、im.action→TaskSignaler 桩留 Phase 5；**§2.3 规则 2**：im.bot_joined→defaultAgent 的 session 订阅，(definition,session) 去重）、`adapters/webhook.ts`（§2.1 全四义务：Verify 对 bodyRaw 原文验签、Decode 产 webhook.received + dedupeKey 取 `x-watt-delivery-id`）。
  - `src/context/`（Round 12/13 新增，Context Layer I/O 面）— `context-registry.ts`（ContextRegistry DO：mounts 表 + 惰性 TTL + alarm 兜底；**TTL 过期物理清理**真实清 R2 前缀/D1 namespace 行/Vectorize 向量，best-effort；unmount 只卸载不清 provider 数据，实现声明 doc-gap #27②）+ 三 provider：`object`（R2，customMetadata 承载 meta、自管整数 version、put onlyIf etagMatches/etagDoesNotMatch 条件写）/ `structured`（DB_CONTEXT，D1 `UPDATE ... WHERE version=?` + changes 判定并发条件写）/ `vector`（**D1 sidecar 架构**：权威数据在 DB_CONTEXT entries 表（与 structured 同表，mounts 唯一键防 namespace 撞名），Vectorize 只存 embedding+引用——修掉 2048 截断丢数据、List unavailable、read-after-write 不可靠三条；Search namespace filter 下推 + 本地双保险；metadata-only Update 不重算 embedding）。
  - `src/http/` — `auth.ts` / `errors.ts` / `oauth.ts`；`routes.ts`（JWKS 公开 + `/htbp/platform/{whoami,policy,audit}` + `/htbp/platform/event`（List/Get/Publish/Subscribe/Unsubscribe/ListSubscriptions；Publish 入参 eventInputSchema 校验 400 + **无条件规约 `source.kind='webhook'`**，doc-gap #25①）+ `/htbp/platform/channel` 四动词 + `/htbp/platform/context` 管理面五动词（platform://context read/manage））；`context-routes.ts`（消费面 `/htbp/context/<ns>` 四动词 + Search + Delete（context://<ns>/<path> read/write 拦截，readOnly 写→403，TTL 过期→404）+ GET `~help` **免认证**，doc-gap #27③）；`inbound.ts`（真实化 `/channels/:id/inbound`：无认证验签即认证；**bodyRaw 字节精确**——arrayBuffer 严格 UTF-8 解码、失败转 base64；404 未知 channel / 403 disabled·错签 / 非 webhook adapter 显式 501）。
  - `src/index.ts` — notFound/onError 兜底 + 剩余规范树 501 占位（platform/{agent,task,scheduler}、tools），注册在认证中间件之前（501 优先于 401）。
  - `migrations/0001_auth_core.sql`（watt-policies 库）+ `migrations-events/0001_event_gateway.sql`（events 表 + 5 索引 + channels 表，watt-events 库）+ `migrations-context/0001`（entries 复合主键表，watt-context 库）。
  - **关键语义（Round 13 锁定）**：并发条件写（D1 WHERE version / R2 onlyIf；残余窗口声明见 doc-gap #27⑤）；成功响应信封形状（消费面 Get→{entry}、Write/Update→{meta}、List→裸 Page；管理面 Write→{mount}）**以 gateway 路由测试为真源**，CLI 精确解包禁双形态兜底（doc-gap #27⑥，漂移曾三次致线上 bug）。
- `packages/cli`（包名 `watt-cli`，非 @watt/cli）— 八命令族：`status` / `login`（device flow，`--json` 输出 NDJSON）/ `whoami` / `policy list|add|rm` / `audit list` / `event tail|get|subs`（tail = 轮询 List + occurredAt 游标 + `--once`；显式 limit 200 + 游标**含端重查 + 同毫秒 id 去重**（Set 仅存游标毫秒防无界）+ 满页 stderr 截断警告）/ `channel list|set` / `context ls|cat|put|patch|mount|unmount`（消费/管理两挂载点，put 三路 content 输入，mock 全部对齐 gateway 测试锁定的真实形状）。token 读取顺序 `WATT_TOKEN` env > `~/.watt/credentials.json`（0600）；未认证分层：本地无 token exit 2 / 服务端 401 exit 1。
- `scripts/` — provision / deploy-all / gen-dev-vars / smoke + `gen-jwt-keys.mjs` + `sign-admin-token.mjs`（需显式 `--rotate`，put 后轮询 JWKS 传播确认；轮询 base 取 `WATT_JWKS_BASE_URL` 缺省 workers.dev）。

## 部署现状

- **watt-gateway 已部署**（含 DO EventRouter + **DO ContextRegistry** + Queue consumer + **AI 绑定**），双 URL：
  - `https://watt-gateway.shuaiqijianhao.workers.dev` — 本机验证首选；**Round 10 起本机直连也偶发超时**，验证命令需带 `https_proxy=http://127.0.0.1:7890`，Node 脚本（如 sign-admin-token.mjs）另需 `NODE_USE_ENV_PROXY=1`（CF 边缘本身正常，见 toolchain-pitfalls §28）。
  - `https://watt.pdjjq.org` — CF 边缘正常，但本机 ISP DNS 污染持续（假 IP → TLS reset）。`.env` 的 `WATT_BASE_URL` 仍指向该域名——本机验证脚本勿直接复用它。
- **Queue `watt-events` consumer 已绑**（Round 9），DLQ `watt-events-dlq` 已建并挂 consumer 配置（Round 10；仅队列存在，DLQ consumer/重放工具留 Phase 6）。
- **JWT 私钥在 wrangler secret `WATT_JWT_PRIVATE_JWK`**（轮换/签 token 用 `scripts/sign-admin-token.mjs --rotate`）。JWKS 经 `/.well-known/jwks.json` 公开。secret put 后有 ~15s 边缘传播窗口。
- `wrangler deploy` 本身不跑 D1 migrations，但 **`pnpm deploy:all` 已内置三库 migrations**：`d1 migrations apply {watt-policies,watt-events,watt-context} --remote`（均幂等）；再有新库带 migrations 时仍须同步扩展。另有根 `pnpm migrate` 独立脚本。
- `scripts/smoke.ts` 内置 5 次重试（边缘传播窗口；deploy 后首批请求还可能命中旧 isolate，见 toolchain-pitfalls §9）。

## 云资源（已真实创建，`pnpm provision` 幂等可重跑）

| 类型 | 资源 |
|---|---|
| D1 ×5 | `watt-policies`（0001 migration） / `watt-providers` / `watt-audit` / `watt-events`（0001 migration，Round 9） / `watt-context`（migrations-context 0001，Round 12） |
| KV ×2 | `watt-authz-cache`（判定缓存，未用） / `watt-tenants`（现兼作 device grant 存储） |
| R2 ×2 | `watt-context-objects` / `watt-artifacts` |
| Queue ×2 | `watt-events`（producer + **consumer 已绑**，Round 9） / `watt-events-dlq`（DLQ，Round 10；重放工具留 Phase 6） |
| Vectorize ×1 | `watt-context-index`（1024 维，bge-m3，cosine；**namespace metadata index 已建**，Round 13，provision 幂等步骤） |
| Workers AI | AI 绑定（bge-m3 embedding，Round 12） |
| DO ×2 | `EVENT_ROUTER`（EventRouter，Round 9） / `CONTEXT_REGISTRY`（ContextRegistry，Round 12） |

命名/多库/维度决策见 [../memory/decisions/resource-naming-and-provision.md](../memory/decisions/resource-naming-and-provision.md)。

## 本机工具链（已实测，全绿）

| 工具 | 版本/状态 |
|---|---|
| node | v26.4.0 |
| pnpm | 11.9.0 |
| wrangler | 4.107.0（devDependency 锁定，对齐 vitest-pool-workers 0.18 捆绑版本） |
| gh | 已登录账户 `Disdjj`，scopes 含 `repo`（可 clone 私有 tool-bridge） |

## 凭据状态（`.env`，已 gitignore；不记录任何秘密值）

- **Cloudflare**：`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` 均存在且 token 有效（Account-scoped，账户 DJJ）。
  - ⚠️ 验证只用 `wrangler whoami`；`/user/tokens/verify` 对 Account API Token 必然误报，勿作判据。
  - whoami 通过 ≠ 有资源写权限；某资源类 `create` 报 `code: 10000` 即缺该资源类写权限（Round 2 实测，已补齐）。
- **模型**：双路径已实测通——① 中转直连 `https://llm.fantacy.live`（Anthropic Messages 格式）；② AI Gateway custom provider（`glm-5.2` / `minimax-m3`）。易错点见 [../reference/external-facts.md](../reference/external-facts.md)。
- **飞书**：WS 长连接 push 型方案已定（见 [../memory/decisions/feishu-websocket-channel.md](../memory/decisions/feishu-websocket-channel.md)）；出站发消息已实测；`E2E_FEISHU_TEST_CHAT_ID` 已在 `.env`。
- **空缺项**：`E2E_FEISHU_ADMIN_OPEN_ID` / `E2E_FEISHU_EMPLOYEE_OPEN_ID`（E2E-4 降级为 API 模拟身份，不阻塞）；`E2E_WEBHOOK_SINK_URL`（可选，不阻塞；Round 9 冒烟用了临时 webhook.site）。

## 外部仓库可达性（已用 gh 核实）

- `TokenRollAI/tool-bridge`：私有，可访问，默认分支 `main`。
- `TokenRollAI/HTBP`：公开。
- Flue = `withastro/flue`（公开）；`TokenRollAI/flue` **不存在**（见 [../memory/decisions/flue-attribution.md](../memory/decisions/flue-attribution.md)）。
