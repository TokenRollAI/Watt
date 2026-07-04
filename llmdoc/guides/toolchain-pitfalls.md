# 工具链安装与测试配置的坑

> 适用场景：在本机安装依赖、配置 vitest-pool-workers 测试、调整 TS 工程、跑 wrangler provision/deploy 时。§1~5 为 Round 1（Phase 0 骨架）、§6~11 为 Round 2（资源 provision + 部署）、§12~14 为 Round 3（Phase 0 关门）、§15~20 为 Round 4~6（Phase 1 Auth）、§21~25 为 Round 7（Phase 1 关门）、§26~29 为 Round 9/10（Phase 2 Event Gateway + 关门）、§30~34 为 Round 12/13（Phase 3 Context Layer + 关门）、§36~40 为 Round 14~18（Phase 4 Tool+Agent + 关门）、§41~45 为 Round 19~21（Phase 5 Task+Scheduler）实测踩坑与已验证解法。

## 1. 大二进制下载超时（npm registry）

- 现象：`@cloudflare/workerd-darwin-arm64`（约 32MB）经默认 npm registry 在本机反复 `UND_ERR_SOCKET` 超时。
- 解法：`pnpm install --registry https://registry.npmmirror.com`。

## 2. pnpm 11.9 的 build 门禁

- workerd / esbuild / sharp 的 postinstall 需在 `pnpm-workspace.yaml` **同时**配置 `onlyBuiltDependencies` + `allowBuilds`。
- 缺一则报 `ERR_PNPM_IGNORED_BUILDS`，workerd 二进制不落地（症状：wrangler/测试起不来）。

## 3. vitest-pool-workers 0.18（Vitest 4 时代）的新 API

- 旧写法已移除：`defineWorkersConfig`（from `@cloudflare/vitest-pool-workers/config`）。
- 新写法：

  ```ts
  import { defineConfig } from 'vitest/config';
  import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

  export default defineConfig({
    plugins: [cloudflareTest({ wrangler: { configPath } })],
  });
  ```

- 类型引用：`/// <reference types="@cloudflare/vitest-pool-workers/types" />`。
- 版本锚点：wrangler 锁 4.107.0 devDependency，对齐 vitest-pool-workers 0.18 捆绑版本（见 [../must/current-state.md](../must/current-state.md)）。

## 4. TS 工程决策：noEmit + `.ts` 扩展名导入

- **不用** `tsc -b` / composite——与 `.ts` 扩展名导入冲突。
- 采用：全局 `noEmit` + `allowImportingTsExtensions`；每包类型检查跑 `tsc --noEmit`；Node 26 原生 strip types 直接执行 `.ts`。
- 坑：残留的 `dist/*.test.js` 会被 vitest 误抓——`dist/` 必须 gitignore 且不留旧产物。

## 5. Cloudflare 凭据验证

- 只用 `wrangler whoami`；`/user/tokens/verify` 对 Account-scoped token 必然误报。详见 [../must/current-state.md](../must/current-state.md) 凭据一节（此处仅交叉引用，不重复）。

## 6. wrangler 配 `routes` 后 workers.dev 默认关闭

- 现象：wrangler.jsonc 加了 `routes`（custom domain）后再 deploy，workers.dev 子域返回 404。
- 原因：配置 `routes` 时 wrangler 默认把 workers.dev 子域关掉。
- 解法：显式加 `"workers_dev": true` 保双 URL（custom domain + workers.dev 并存）。

## 7. wrangler env-token 模式的 stdout 污染与 `--json` 支持不齐

- env-token 模式（`CLOUDFLARE_API_TOKEN` 环境变量）下，**每条命令的 stdout 都会先打一段 whoami banner**，直接污染 `--json` 输出——不能天真 `JSON.parse(stdout)`。
- 且 `--json` 支持不齐：`d1 list` / `kv namespace list` / `vectorize list` 支持；**`queues list` / `r2 bucket list` 不支持**。
- 脚本判断资源是否存在的稳妥做法：对 list 输出做**资源名 substring 匹配**（`scripts/provision.mjs` 即此方案）。

## 8. JSONC 注入陷阱（wrangler.jsonc 回填）

- 现象：向末尾带行注释的 wrangler.jsonc 追加属性后，wrangler 的 JSONC parser 报 `CommaExpected`。
- 原因：逗号被补在了注释之后。逗号必须补在**最后一个真实 JSON token 后**（注释之前/之外），不能跟在行注释后面。
- 隐蔽点：**爆点在 test 阶段而非 typecheck**（vitest-pool-workers 加载 wrangler 配置时才解析），typecheck 全绿也可能带着坏配置。

## 9. 新部署 Worker 的边缘传播窗口

- 现象：`wrangler deploy` 成功后立即 curl，首击可能 500 `error code: 1104`。
- Round 7 补充：deploy 后**首批 curl 还可能命中旧 isolate**（观测到 404 纯文本 / 旧版本 body）——验证新行为前等几秒或重测一次，勿凭首击结果下结论。
- 解法：验证脚本必须带重试（`scripts/smoke.ts` 已内置 5 次重试）。

## 10. Vectorize 绑定在本地测试环境

- vitest-pool-workers / miniflare 对 Vectorize 绑定只打 WARNING，不报错。
- 本地测试**无需**从 wrangler.jsonc 注释掉 Vectorize 绑定。

## 11. 本机网络：ISP DNS 污染 `watt.pdjjq.org`

- 现象：本机解析 `watt.pdjjq.org` 得到假 IP → TLS reset；CF 边缘本身正常（非平台问题）。
- workaround：本机验证/E2E 用 workers.dev URL（`watt-gateway.shuaiqijianhao.workers.dev`），或 curl 加 `--doh-url https://1.1.1.1/dns-query`。

## 12. Biome 强制单行 import

- Biome formatter 会把 import 语句压成单行；手工拆成多行会在 `pnpm verify`（lint 阶段）fail。
- 写代码时直接保持单行 import，或改完跑一次 `biome format --write` 再 verify。

## 13. `scripts/lib/*.mjs` 在 typecheck 范围外

- `scripts/tsconfig.json` 只 `include: ["smoke.ts"]`（且 `checkJs: false`），`scripts/lib/*.mjs` 不进 typecheck。
- 后果：`.mjs` 脚本库的类型错误 verify 抓不到。
- 约定：新脚本库保持 `.mjs`（接受无类型检查），或者写 `.ts` 时**必须**主动加进 `scripts/tsconfig.json` 的 include。

## 14. provision 幂等的金标准检查

- 金标准 = **重跑 `pnpm provision` 后 `wrangler.jsonc` 字节级一致**（跑前跑后 MD5 对比）。
- 仅看输出全 [exists] 不够——回填逻辑仍可能重写 marker 段造成 diff/绑定漂移；MD5 一致才证明真正幂等。
- 关联坑：给某类绑定加 per-binding 新字段（如 D1 的 `migrations_dir`）时，必须同步改 provision 的 bindingsBlock 生成逻辑，否则重跑会把新字段抹掉（MD5 检查即为此设）。

## 15. 块注释内的 `*/` 字面提前闭合（oxc PARSE_ERROR）

- 现象：在 `/* ... */` 块注释里写含 `*/` 的字面文本（如描述通配符 `agent_*/chain`），注释提前闭合 → oxc 报 PARSE_ERROR，**且报错行号定位到别处，极具误导性**。
- 解法：块注释内避免 `*/` 序列（改写为 `agent_* / chain` 或用行注释 `//`）。遇到定位不明的 PARSE_ERROR，先全文搜块注释里的 `*/`。

## 16. vitest-pool-workers 跑 D1 migrations 的接线三件套

缺一即测试里 D1 无表（`no such table`）：

1. vitest config 顶层 `await readD1Migrations(migrationsDir)` 读出 migrations；
2. 经 `miniflare.bindings`（如 `TEST_MIGRATIONS`）注入测试环境；
3. 测试 setup 里 `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`；
4. 另需 `declare global { interface Cloudflare { Env: ... } }`（或对应 Env 声明）让 `env.TEST_MIGRATIONS` 过 typecheck。

## 17. coverage 产物污染 lint

- `coverage/` 目录不 gitignore 且不在 biome 排除里，会被 lint 抓到爆上百错。
- 解法：`.gitignore` 加 `coverage/`，且 biome 配置 `files.ignore`（或等效排除）同步加。

## 18. `pnpm --filter X test -- --coverage` 不透传

- `--coverage` 经 pnpm `--` 透传到 vitest 会丢失，静默不生效。
- 解法：把 `--coverage`（及覆盖率门禁）直接写进该包 package.json 的 `test` 脚本，不靠命令行透传。

## 19. 脚本 stdout 纯净化模式（供 `$()` 捕获）

- 场景：脚本输出会被 shell `$()` 或管道捕获时（如 `sign-admin-token.mjs` 输出 token），任何子进程/日志混入 stdout 都会污染捕获值。
- 模式：脚本内所有子进程（`wrangler` 等）的 stdout 显式重定向到 stderr（`stdio: ['ignore','inherit'→2,'inherit']` 或 pipe 后写 `process.stderr`），日志一律 `console.error`；**只有最终目标值走 stdout**。

## 20. `wrangler secret put` 后的传播窗口

- secret put 成功返回后，边缘约有 ~15s 传播窗口，期间线上仍用旧值（或无值）。
- 验证脚本在 put 后 `sleep 15`（或重试探测）再断言，否则假失败。

## 21. pnpm `--filter` 以 package.json name 为准，且空匹配 exit 0

- 包名以各包 `package.json` 的 `name` 字段为准，不是目录名：CLI 包是 **`watt-cli`** 不是 `@watt/cli`。
- 更危险的是：**filter 匹配不到任何包时 exit 0**，命令"成功"但什么都没跑——测试假通过。
- 派任务 / 写脚本前先核对包名（`pnpm ls -r --depth -1`）。

## 22. 本机验证脚本的 base_url 缺省

- 本机 fetch 线上的验证脚本，base_url 缺省应取 workers.dev（`watt-gateway.shuaiqijianhao.workers.dev`），留环境变量覆盖（如 `WATT_JWKS_BASE_URL`）。
- **勿直接复用 `.env` 的 `WATT_BASE_URL`**——它指向被本机 DNS 污染的 `watt.pdjjq.org`（见 §11），脚本会假失败。

## 23. vitest-pool-workers 同一测试文件内共享 isolate

- 同一个 test 文件的所有用例跑在同一个 workerd isolate 里：**模块级单例（如 seed 的 once-guard Promise）跨用例存活**。
- 后果：凡是 beforeEach 里 clearDb 的测试文件，种子引导会被 once-guard 短路，后续用例的种子/授权失真。
- 解法：clearDb 的同时 reset 单例（gateway 导出 `resetSeedGuardForTests` 即为此设）。

## 24. Hono matcher 在首个请求后锁定

- Hono app 处理过第一个请求后 route matcher 即构建锁定，之后再 `app.get()` 追加路由会报 **"matcher already built"**。
- 测试里要动态挂路由的，必须在任何 fetch 之前于模块顶层注册。

## 25. 认证中间件先于 notFound 执行（501 占位的注册位置）

- notFound 兜底在中间件链末端：若规范树 501 占位靠 notFound 判前缀实现，请求会先被认证中间件拦成 401。
- §11.3a 语义要求 501 优先于 401——占位路由必须**显式注册在认证中间件之前**（gateway `index.ts` 即此做法）。

## 26. gateway src 直接 import zod 在 workerd 解析失败

- 现象：gateway 源码直接 `import { z } from 'zod'`，typecheck 绿但 workerd 运行时报 `Cannot find package 'zod'`。
- 原因：zod 被 pnpm workspace hoisting 到别处，gateway 包解析不到。
- 解法：gateway 内用手写 type guard，或需要 zod schema 时**经 `@watt/core` 导出**（core 是 zod 的直接依赖方）。

## 27. TextDecoder `fatal` 须同时给 `ignoreBOM`（TS2345）

- 现象：`new TextDecoder('utf-8', { fatal: true })` 在本工程 lib 类型下报 TS2345。
- 解法：同时给两个选项：`{ fatal: true, ignoreBOM: false }`（或显式 true），否则 typecheck 红。

## 28. 本机代理：workers.dev 直连偶发超时（Round 10 起）

- 现象：本机直连 `watt-gateway.shuaiqijianhao.workers.dev` 也开始偶发超时（此前只有 watt.pdjjq.org DNS 污染，见 §11）；CF 边缘本身正常。
- 解法：验证命令带 `https_proxy=http://127.0.0.1:7890`；**Node 脚本**（如 `sign-admin-token.mjs`）不认 env proxy，需另加 `NODE_USE_ENV_PROXY=1`。

## 29. 多 teammate 共享工作树的并行修复纪律

- typecheck 红时先判断归属：用 `git show HEAD:<file>` 对比基线，确认是自己的在途改动还是他人的——不要见红就修别人的文件。
- **禁用 `git stash`**：会连带他人在途改动一起 stash 掉，恢复时产生冲突/丢改动。

## 30. R2 list 默认不返回 customMetadata

- `bucket.list()` 结果对象缺省不含 customMetadata——用 customMetadata 承载 meta 时，list 出来 meta 全空（Round 12 线上冒烟才暴露）。
- 解法：`bucket.list({ include: ['customMetadata'] })`。**本包 workers-types 未收录该字段**，需类型拓宽（as 或局部接口扩展）才过 typecheck。

## 31. DO RPC 联合返回类型经 type guard 后 narrow 成 never

- DO RPC 方法返回联合类型（如 `Mount | WattError`）时，调用侧过 `isWattError()` guard 后另一分支被 narrow 成 `never`（Cloudflare RPC types 的已知问题——RPC stub 包装破坏了判别式收窄）。
- 解法：guard 之后显式 `as` 标注目标类型，勿指望自动收窄。

## 32. Vectorize 变更异步最终一致，read-after-write 不可靠

- Vectorize upsert/delete 是**异步最终一致**：写后立即 query/getByIds 可能读不到（或读到旧值），List 语义无法可靠实现。
- 解法：**不要把权威数据放 Vectorize metadata**——需要 read-after-write 语义就上 D1 sidecar（权威数据在 D1，Vectorize 只存 embedding+引用；gateway vector provider 即此架构，见 doc-gap #27①）。

## 33. KV namespace list 在 https_proxy 下超时 → provision 误判走 create

- 现象：带 `https_proxy` 环境跑 `pnpm provision`，`kv namespace list` 可能超时/空结果，脚本判定资源不存在走 create，报 already exists 假失败（Round 12 实测）。
- 解法：**跑 provision 前 unset 代理**（provision 走 CF API 不需要本机代理；代理只在 curl workers.dev 验证时用，见 §28）。

## 34. CLI/服务端响应形状以 gateway 路由测试为真源，禁双形态兜底

- 教训：CLI 与 gateway "双方各按自己理解写"，独立 mock 全绿但线上错配——Phase 3 连出三次线上 bug（put 缺必填 contentType / cat 未解包 `{entry}` / put·patch 双形态兜底掩盖漂移）。
- 纪律：响应形状**唯一真源 = gateway 路由测试锁定的形状**（Get→`{entry}`、Write/Update→`{meta}`、List→裸 Page、管理面 Write→`{mount}`）；CLI mock 必须照抄真源并在文件头声明出处；**禁止写"两种形状都能解"的兜底**——它只会把契约漂移从测试期推迟到线上。

## 35. AI 绑定触发 vitest-pool-workers 远程代理会话

- 现象：wrangler.jsonc 有 `"ai"` 绑定时，vitest-pool-workers 会尝试为 AI 起远程代理会话，多账户非交互环境必失败（`user account selection unavailable`）。
- 解法：vitest.config 里 `remoteBindings: false`；vector provider 等对 AI 的调用走依赖注入 fake（测试从不读 env.AI），真实 embeddings 验证留部署后冒烟（Round 12 实测）。

## 36. agents 包传递依赖 core-js-pure 的 build script 阻塞 vitest

- 现象：装 `agents`（Agents SDK）后，其传递依赖 `core-js-pure` 带 postinstall build script，被 pnpm 门禁 ignore → vitest 的 depsStatusCheck 检出 ignored build 并阻塞测试启动。
- 解法：`pnpm-workspace.yaml` 的 `allowBuilds` 显式声明 `core-js-pure: false`（明确"不构建也没关系"，消除 ignored 状态），vitest 恢复运行。

## 37. ai SDK 版本必须跟 agents 的 peer 走

- 现象：`agents@0.17.3` 的 peer 是 `ai@^6`；直接装最新 `ai@7` 会 peer 冲突（安装期报错或运行时行为漂移）。
- 纪律：装 Vercel AI SDK 前先查 `agents` 当前版本的 peerDependencies，锁对应大版本（本仓库 ai@6 + @ai-sdk/anthropic@3，决策见 memory/decisions/model-call-sdk.md）。升级 agents 时同步核对 ai peer。

## 38. HTBP tools call 的请求形状契约（§34 的请求形状对偶）

- 上游 tool-bridge 契约：**工具名走 URL end-path**（`.../<node>/<toolName>`），**body 是 `{arguments}` 信封**；http adapter 会把 body 整包转发给目标端点。
- 教训：CLI 曾把 `{tool,arguments}` 发到节点级 URL——对 http/mcp provider 必炸，但线上 echo 服务"什么都吞"恰好掩盖（Round 18 BLOCKER）。
- 修法：CLI call 拼 end-path + `{arguments}` 信封；gateway 代理按 provider 归一化——**http 拆信封发裸参数、mcp/builtin 透传**。
- 测试纪律：**fake 必须按节点 type 分派、忠实上游各 provider 语义**——echo 型"什么都吞"的测试替身是契约漂移的天然掩盖器（与 §34 同根：真源只能有一个）。

## 39. 系统代发事件与外部事件共用消费管道时的去重误杀

- 现象：correlation 超时代发 agent.failed 走与外部事件相同的消费/去重管道，**去重判定把自产事件当重复吞掉**——failed 永远到不了 waiter（Round 18 BLOCKER，§3.4 规则 3/4 根因）。
- 纪律：系统代发路径**要么直投**（本仓库解法：AgentCorrelation DO 直投 waiter，绕开 routeResult 去重）、**要么显式标记绕开去重**；不要让自产事件裸走公共去重面。
- 关联修法：routeResult 投递改三态 peek(delivering)→deliver→confirm，失败 rollback + msg.retry，投递成功才 settle。

## 40. R2 条件写用 `.etag`，不是 `.httpEtag`

- R2 对象的 `httpEtag` 带双引号（HTTP 头格式），传给 `onlyIf: { etagMatches }` 会匹配失败/报错；条件写必须用**裸 `.etag`** 字段（gateway `src/context/providers/object.ts` 即此写法）。

## 41. 本地 Workflows 实例 hibernate 时 `status()` 仍报 running

- 现象：vitest-pool-workers 里 Workflows 实例在 `step.waitForEvent` 处 hibernate，`instance.status()` 仍报 `'running'`——靠 `waitForStatus('waiting')` 的断言永远等不到。
- 解法：测试断言以 **TaskStore 状态表为真源**（`waiting_human` 由引擎步骤落库，是平台对外可查的权威态），轮询状态表而非 instance.status（gateway `test/workflow-task.test.ts` 的 `waitForCheckpoint` 即此写法）。

## 42. step.do / waitForEvent 泛型 `T extends Rpc.Serializable<T>` 的类型约束

- bare `unknown` 不满足约束；递归 JSON 类型（`Json = ... | Json[]` 类）会触发 **TS2589 深实例化超限**。
- 解法：事件 payload 用**一层深的 FlatRecord**（`{ [k: string]: string|number|boolean|null }`，见 `watt-task-workflow.ts` L80-92）——顶层判定够用；嵌套结构的全量不在 Workflow 侧读，存 TaskStore 时用 `unknown` 承载。

## 43. agents 包无 cron 解析纯函数导出

- `agents/schedule` 只导出给 LLM 生成用的 zod schema（cron 当 `z.string()` 透传）；内部 `getNextCronTime` 依赖第三方 cron-schedule 库但**未 re-export 为纯函数**。
- 后果：core（零运行时依赖）需要 cron 解析时无现成导出可用——自实现分钟级五段子集（`core/src/task/cron.ts`，子集边界与拒绝面在文件头声明）。

## 44. Dynamic Worker Loader：本地无绑定 + env 字段 structured clone 拒收

- ① **本地 vitest-pool-workers 无 LOADER 绑定**（wrangler worker-loader binding 线上 open beta——DJJ 账户已开通实证；本地 workerd 未在 pool-workers 暴露）——依赖 LOADER 的路径必须做成**可注入降级**（ScriptRunner 抽象：生产真 isolate / 测试 fake，见 `gateway/src/scheduler/script-runner.ts` 与 [../memory/decisions/scheduler-script-runner.md](../memory/decisions/scheduler-script-runner.md)）。
- ② **loader 的 `env` 字段走 structured clone**：plain object 的闭包函数和 **RpcTarget 实例都会被拒**（线上部署冒烟两次实测 "could not be cloned"）。能力 binding 必须经 **entrypoint RPC 调用参数**传入——Cap'n Web 只在 RPC 边界把 RpcTarget 转 stub；故脚本入口约定 `run(watt)` 参数注入（script-runner.ts 文件头有完整迭代记录）。

## 45. getAgentByName 的 stub 直接传 runInDurableObject，勿 cast 成实例类

- `getAgentByName` 返回 DO stub；传给 `runInDurableObject(stub, fn)` 时直接用 stub 类型即可，fn 参数里才是真实 instance。
- 把 stub cast 成实例类会撞类型冲突（如 `name` 属性：实例类是 `string`，stub 包装后是 `Promise<string>`）——与 §31 的 RPC 包装破坏收窄同源（gateway `test/scheduler-hub.test.ts` 即正确写法）。

## 46. ai@6 的 `result.usage` 只算最后一步——多步 tool loop 计量必须取 `totalUsage`

`generateText` 带 tools + `stopWhen: stepCountIs(N)` 时跑多步；`result.usage` 语义是"最后一步的用量"、`result.totalUsage` 才是全步累计（ai@6.0.219 类型定义原文）。取 usage 会系统性漏账前面所有 step 的 token（manage/* 对话恰是大头）。无 tools 单步时二者相等，零回归。锁定测试：fake fetchImpl 两步应答（tool_use→end_turn）断言 usage=两步之和（`test/anthropic-caller-usage.test.ts`）。

## 47. DO `idFromName` 对任意名字隐式创建幽灵实例——投递面必须先查索引

`idFromName(<拼错的 id>)` 不报错，直接创建一个 INITIAL_STATE 的新 DO（AgentInstance 缺省 harness=echo、不在实例索引里）。Send 直投这种幽灵会**静默回显**而非报错——R27 实测把 `r27-gate` 误写成 `manage/cron#r27-gate`，send accepted、onEvent ok、无任何事件留痕，排查耗时显著（tail 日志才看出 11ms onEvent 不可能调过模型）。修复模式：对外的投递入口先查权威索引（correlation 实例表），未 Spawn → not_found。教训通用：**任何 idFromName 消费面都要考虑"名字不存在"不是错误而是隐式创建**。

## 48. vitest-pool-workers 0.18（Vite 插件 API）没有 `fetchMock` 导出

`import { fetchMock } from 'cloudflare:test'` 得 undefined（dist 里根本没有该实现）。测试里拦截 Worker 出站 fetch 的替代：被测模块暴露 `set<X>FetchForTests(fetchImpl)` 模块级钩子（对齐 resetSeedGuardForTests 习惯）——SELF.fetch 与测试代码共享同一 isolate 的模块态，钩子对路由生效（plugin-registry 注册探活即此模式）。

## 49. 飞书 WSClient（node-sdk 1.68.0）构造参数有未导出的 `onReady`/`onError` 回调

`start()` 是 async 且内部自持重连，正常路径永不返回也永不抛——把它包进只在同步 throw 时 reject 的 Promise 是死代码（连接后永不 settle，外层监督循环不可达）。SDK 全部终态放弃路径（鉴权失败/重连耗尽/autoReconnect 关）都必然 `safeInvoke('onError')`（lib/index.js L89250/89264 等）——正确写法：构造参数传 `onError: reject`（类型未导出，经 Record 注入），并 `Promise.resolve(start()).catch(reject)` 接住异步 rejection 防 unhandledRejection。SDK 自愈型断线走 onReconnecting，不 settle。

## 50. node --experimental-strip-types 不支持 constructor parameter properties

`constructor(readonly x: number)` 在 strip-only 模式抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX（参数属性是需要代码生成的 TS 语法，不是纯类型注解）。scripts/ 下直接 node 跑的 .ts 文件要用显式字段声明 + 构造函数赋值。enum、namespace 同理。

## 51. script 的 watt.publish 发 outbound.message 会触发出站 Check——注入的 Authorizer 必须播种 cronJobs

event-bus publish ① 对 type=outbound.message 做 Check(event://<channel>/<target>,'write')，claims 带 cron:<jobId> 链段；平台 newAuthorizer 的 cronJobs 索引恒空 → core authorize 步骤 3 查无此 job → 误判 "cron job disabled/deleted"（R28 E2E-6 实测：job 明明 enabled）。修复模式 = script 侧传本 job 播种的判定包装（cronJobs: {[job.id]: job}）。通用教训：**凡 claims 带链段（cron:/instance）的调用路径，判定点必须能解析链段对应的数据面**——用平台默认 Authorizer 前先查它的索引是不是空的。另注意 grants 前缀通配要显式星号（`event://*`；`event://` 是精确匹配，match.ts §6.2）。

## 52. E2E 长跑最常见 FAIL 源 = admin token 1h 过期

`sign-admin-token.mjs` 签发的 token TTL 1h；六条 E2E 串行 + 部署间隔很容易越界，症状是脚本中途 401（"invalid or expired token"）——不是代码问题。纪律：**每次全量 e2e 前重签**（需双身份时 `--rotate --extra user:staff=staff` 同轮换双签——两次 --rotate 会互相吊销）。另一个模式：E2E 脚本的清理必须有 `process.on('exit')` 兜底（断言失败即 process.exit(1) 会跳过顺序清理——e2e-6 曾因此可能遗留每天 09:00 真实触发的 CronJob）；注意 exit 钩子引用的 let 变量声明须在顶层 await 之前（TDZ）。

## 53. 平台 Authorizer 空索引对带 agent_def 的 claims 同样误拒（§51 的 agent 面）

newAuthorizer 的 agentDefs/cronJobs/instances 恒空——claims 带 agent_def 时 core authorize 步骤 2 查无此 def 即 deny "agent definition not found"。agent 主体（如 lurker 出站）要过 Check 必须播种本 def（`agentDefs: {[def.name]: def}`）走 core authorize，审计单独补。与 §51（cron 链段）同根：**判定点必须能解析 claims 引用的数据面**。
