# Round 36 — Dashboard 全量重构（5 worker 共享工作树并行 + 骨架契约与快照漂移教训）

## Task
- Dashboard 全量重构：主 assistant 先落骨架（含共享 `platform.ts` 等 wrapper），再按视图族拆 5 个 worker（view-a~e）在**同一工作树**并行实现，各族文件集互斥，主 assistant 收口跑全包门禁。

## Expected vs Actual
- 预期：骨架期预置的共享 wrapper 可信，worker 照用；并行期各自文件集独立推进，收口一次全绿。
- 实际：五族零文件冲突、全包门禁收口顺利，但——① 骨架 `platform.ts` 里一处凭调查报告写的响应形状与 gateway 真源不符，被 view-e 双证发现；② 并行期两起「快照漂移」（跨 worker 复制旧版模式、基于旧快照的门禁转发）；③ gitignore 遗留规则静默吞掉整个新建 api 层，收尾自查才暴露。

## What Went Wrong
- **骨架期埋契约错误的放大效应**：主 assistant 在骨架 `platform.ts` 里凭调查报告写 `registerPlugin` 响应形状（`{plugin, pluginToken?}`），与 gateway 真源（`{registration: {...}}`）不符。view-e 以 gateway `routes.ts` + `cli/src/plugin.ts` 双证发现，因 `platform.ts` 属禁改文件，在自己文件里正确重实现并上报。教训→**骨架期预置的 wrapper 必须逐个对照真源**，「先写个大概等 worker 用时再校」会让错误形状被下游信任；worker 面对禁改文件里的错误，正确动作 = 新文件重实现 + 上报，而非沉默绕过或擅改禁改文件。
- **并行 worker 的「快照漂移」二连**：
  1. view-b 复制了 `view-c-parts.tsx` 早期版本的 JsonField 写法（useMemo + biome-ignore），而 view-c 期间已重构成纯函数式，view-b 的旧写法在新 biome 配置下报错。教训→**跨 worker 复制模式前以当前磁盘态为准**，重新 Read 目标文件，不用记忆里的版本。
  2. view-d 全包扫描报出的 C/E 族门禁问题，实际 C/E 在收到转发前已自修完——扫描基于旧快照。教训→转发门禁问题清单时**注明扫描时间**；接收方先复核现状再动手修，避免对已修问题二次施工。
- **gitignore 遗留规则的静默吞档**：Python 模板遗留的 `lib/` 规则把整个新建 api 层排除在 git 外，直到 view-e 收尾自查 `git check-ignore` 才暴露。教训→**新目录结构落地时立即 `git status` 核对新文件全部可见**，不要等到提交时。

## Root Cause
- 骨架期对「共享契约代码」与「占位代码」没有区分对待：wrapper 是全体 worker 的信任锚点，其正确性标准应等同真源，但落骨架时按占位代码的松标准写了。
- 共享工作树并行的本质是「无隔离快照」：任何 worker 对磁盘的读取都可能是他人改动前/后的瞬时态，跨族复制与全包扫描两个动作天然携带过期风险，此前无「以当前态为准 / 标注扫描时间」的纪律。
- 项目由 Python 模板起步，语言栈切换后 gitignore 未做全量清查，遗留规则与新目录命名（`lib/`）撞车。

## What Worked（保持）
- **全包门禁 vs 文件集隔离的约定**：多 worker 共享工作树时 `pnpm typecheck`/biome 全包必然互相看到在途红——各 worker 以「本人文件集零 error」自证，主 assistant 收口时跑全包。本轮五族零文件冲突，约定运转良好。
- **有理偏离的良性案例**：view-b 实测 `agent-runtime.ts` Spawn 带 expect 会触发 harness 空跑一次 LLM，主动偏离任务书（改为不带 expect）并写明证据与回退选项。派发词给了「新会话=Spawn 带 expect」的错误细节，worker 用运行时事实纠正——正面例证了**验收指令给意图、不给实现细节**。
- **Docs 先行的低摩擦实践**：EventStore correlationId filter 十行改动，按「Docs 是宪法」先改 Proto §2.4（附动机）再改码，总成本几分钟——小改动走宪法流程并不慢，不必为省事跳过。
- view-e 的双证发现路径（gateway 真源 + CLI 消费方互证）与「重实现 + 上报」的处置，可作为 worker 面对上游错误的标准动作。

## Missing Docs or Signals
- 缺骨架期纪律：共享 wrapper/契约代码落笔时必须逐个对照真源（gateway routes + 一个真实消费方双证），不得以调查报告转述代替。
- 缺共享工作树并行纪律：① 跨 worker 复制模式前重新 Read 当前磁盘态；② 转发门禁清单注明扫描时间、接收方先复核现状；③ 各 worker 以本人文件集零 error 自证 + 主 assistant 收口全包（本轮已实证，应固化成文）。
- 缺项目起步检查项：语言栈/模板切换后全量清查 gitignore；新目录落地即 `git status` 核对可见性。
- 缺派发模板正面条款：验收指令给意图不给实现细节，worker 有权以运行时证据偏离并上报（view-b 案例可引）。

## Promotion Candidates
- `guides/`（并行派发相关）：共享工作树多 worker 的三条纪律（复制以当前态为准 / 门禁转发注明扫描时间 / 文件集自证 + 收口全包）+ 骨架期共享契约代码的真源双证要求。
- `guides/` 或派发模板：worker 面对禁改文件中的错误的标准动作（新文件重实现 + 上报）；验收指令给意图不给实现细节。
- `guides/toolchain-pitfalls.md`：① Python 模板遗留 `lib/` gitignore 规则会吞新建目录，新结构落地即 `git status`/`git check-ignore` 核对；② agent-runtime Spawn 带 expect 触发 harness 空跑一次 LLM。

## Follow-up
- 请 recorder 按 Promotion Candidates 落稳定文档；并行派发 prompt 模板增补共享工作树三纪律与骨架真源双证条款。
- 清查根 gitignore 中 Python 模板遗留规则，删除或改为精确路径，避免再吞新目录。
- 对骨架期其余 `platform.ts` wrapper 做一次逐个对照真源的回扫（本轮只确证了 `registerPlugin` 一处错误）。
