# 当前项目状态快照

> 本文档随轮次更新。最后更新：2026-07-02（Round 8，Phase 2 项 1 完成）。

## 阶段

- 规格真源：`Docs/{Vision,Architecture,Proto,Plugin,Reference}.md` + `DOD.md`（验收）+ `LOOP.md`（执行契约）。
- Phase 0 已关门（2026-07-02 Round 3）；**Phase 1 已关门**（2026-07-02 Round 7：质量关口 1 BLOCKER + 8 MAJOR + 4 MINOR 全修，DoD 全链重跑，证据 `PROGRESS.md` Round 7）。
- **当前进度：Phase 2（Event Gateway）**，项 1 已勾（Round 8），下一目标项 2。注意 Queue consumer 绑定在 Phase 2 才做。DOD.md Phase 1 附有"已知跳过清单"（KV 判定缓存 / agent token 数据面 / ~help·~skill 延后 / cursor 分页）。
- Phase 路线：0 骨架/部署管道 → 1 Auth+Event 信封 → 2 Event Gateway → 3 Context Layer → 4 Tool+Agent Runtime → 5 Task+Scheduler → 6 飞书+Observability+Management → 7 六条 E2E 验收（详见 [../overview/project-overview.md](../overview/project-overview.md)）。

## 源码现状（Round 8 后，测试共 226 个：shared 6 + core 140 + cli 33 + gateway 47；core 覆盖率 100% 门禁挂 verify）

- `packages/shared` — `WattError`（规范 7 码，裸 body 契约见 [../memory/decisions/bare-watterror-body.md](../memory/decisions/bare-watterror-body.md)）。
- `packages/core`（@watt/core，平台核心纯逻辑，零 Cloudflare 依赖）：
  - `src/authz/` — `authorize()` §6.4c 四步判定（过期优先于 approved 的判定次序有测试锁死）+ subject 匹配 + 工具动作映射（unknown tool 先查 TOOL_ACTIONS 表再鉴权，read-only 得 400 非 403）。
  - `src/event/` — Event 信封（128KB 上限、normalizeEvent、DedupeStore 接口）。
  - `src/auth/` — `jwt.ts`（jose Ed25519 sign/verify/JWKS，密钥注入）+ `device-flow.ts`（RFC 8628 grant 状态机 / token exchange + `normalizeUserCode`（RFC 8628 §6.1 大小写/连字符归一化），存储依赖注入）。均为纯逻辑，测试无需 workerd。
  - `src/eventbus/` — 订阅匹配与出入站纯逻辑（Round 8 新增）：`types.ts`（Subscription/OutboundMessage zod）、`matches.ts`（订阅匹配：全 AND、缺省跳过、type 后缀通配 `"*"`/`"im.*"` 前缀含点）、`instance-key.ts`（instanceBy 三态 → SpawnRequest.instanceKey 幂等键；session 态缺 session → invalid_argument，doc-gap #23）、`inbound.ts`（processInbound：Verify 失败 permission_denied 拒收短路）、`outbound.ts`（outbound.message → `event://<channel>/<target>` write + authorize() 组合）。
- `packages/gateway`（Hono Worker）：
  - `src/authz/` — `policy-store.ts`（D1 四动词 + Delete；`list` 遵守 §0.2/§6.2：接受 ListOptions（filter.subject、limit 默认 50 钳 200、非法 filter 键 400），返回 Page `{items}`，cursor 延后见 doc-gap #22）、`identity-mapper.ts`、`seed.ts`（幂等语义：get 不存在才 write / resolvePrincipal 无角色才 bind；isolate 级 Promise once-guard，失败置回 null 可重试，导出 `resetSeedGuardForTests`）、`device-store.ts`（KV 双索引 + expirationTtl + `delete` 双 key：device_code 一次性消费为 best-effort，严格原子需 DO/D1）、`keys.ts`。
  - `src/http/` — `auth.ts`（认证中间件，401 裸 WattError）、`errors.ts`（WattError↔HTTP 映射）、`routes.ts`（JWKS 公开 + `/htbp/platform/{whoami,policy,audit}`）、`oauth.ts`（device flow 三端点）。
  - `src/index.ts` — `notFound`（404 not_found 裸 WattError）+ `onError`（500 internal，retryable、不泄漏细节）兜底；§11.3a 规范树占位路由（platform/{agent,task,scheduler,event}、tools、context → 501 unavailable），**注册在认证中间件之前**（501 优先于 401）。
  - `migrations/0001_auth_core.sql` — policies + identity_mappings（挂 watt-policies 库）。
- `packages/cli`（包名 `watt-cli`，非 @watt/cli）— 五命令族：`status` / `login`（device flow 轮询 + `--approve`；**`--json` 输出 NDJSON**：先授权码行（user_code JSON）再结果行）/ `whoami` / `policy list|add|rm` / `audit list`。policy/audit 的 List 读 `items`。token 读取顺序 `WATT_TOKEN` env > `~/.watt/credentials.json`（0600）。未认证语义分层：本地无 token exit 2 / 服务端 401 exit 1（决策见 [../memory/decisions/auth-implementation.md](../memory/decisions/auth-implementation.md)）。
- `scripts/` — provision / deploy-all / gen-dev-vars / smoke + `gen-jwt-keys.mjs` + `sign-admin-token.mjs`（轮换密钥 + 同进程签 admin token，私钥不落盘；现需显式 `--rotate` 才执行，put 后轮询 JWKS 传播确认——比对公钥 x，60s 超时不出 token；轮询 base 取 `WATT_JWKS_BASE_URL` 缺省 workers.dev）。

## 部署现状

- **watt-gateway 已部署**，双 URL：
  - `https://watt-gateway.shuaiqijianhao.workers.dev` — 直连可用（本机验证首选）。
  - `https://watt.pdjjq.org` — CF 边缘正常，但**本机 ISP DNS 污染**（假 IP → TLS reset）。本机用 workers.dev URL 或 curl `--doh-url https://1.1.1.1/dns-query`。`.env` 的 `WATT_BASE_URL` 仍指向污染域名——本机验证脚本勿直接复用它。
- **JWT 私钥在 wrangler secret `WATT_JWT_PRIVATE_JWK`**（put 后不可取回；轮换/验收签 token 用 `scripts/sign-admin-token.mjs --rotate`）。JWKS 公钥经 `/.well-known/jwks.json` 公开。secret put 后有 ~15s 边缘传播窗口。
- `wrangler deploy` 本身不跑 D1 migrations，但 **`pnpm deploy:all` 已内置 `d1 migrations apply watt-policies --remote` 步骤**（幂等）；⚠️ 该步骤硬编码 watt-policies 单库——新库带 migrations 时必须同步扩展（脚本注释已标）。另有根 `pnpm migrate` 独立脚本。
- `scripts/smoke.ts` 内置 5 次重试（边缘传播窗口；deploy 后首批请求还可能命中旧 isolate，见 toolchain-pitfalls §9）。

## 云资源（已真实创建，`pnpm provision` 幂等可重跑）

| 类型 | 资源 |
|---|---|
| D1 ×4 | `watt-policies`（已有 0001 migration） / `watt-providers` / `watt-audit` / `watt-events` |
| KV ×2 | `watt-authz-cache`（判定缓存，Phase 1 未用） / `watt-tenants`（现兼作 device grant 存储） |
| R2 ×2 | `watt-context-objects` / `watt-artifacts` |
| Queue ×1 | `watt-events`（producer 已绑；**consumer 留 Phase 2**） |
| Vectorize ×1 | `watt-context-index`（1024 维，bge-m3，cosine） |

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
- **空缺项**：`E2E_FEISHU_ADMIN_OPEN_ID` / `E2E_FEISHU_EMPLOYEE_OPEN_ID`（E2E-4 降级为 API 模拟身份，不阻塞）；`E2E_WEBHOOK_SINK_URL`（可选，不阻塞）。

## 外部仓库可达性（已用 gh 核实）

- `TokenRollAI/tool-bridge`：私有，可访问，默认分支 `main`。
- `TokenRollAI/HTBP`：公开。
- Flue = `withastro/flue`（公开）；`TokenRollAI/flue` **不存在**（见 [../memory/decisions/flue-attribution.md](../memory/decisions/flue-attribution.md)）。
