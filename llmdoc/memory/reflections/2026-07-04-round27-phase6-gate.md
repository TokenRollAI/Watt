---
标题: Round 27（Phase 6 关门轮）流程反思
日期: 2026-07-04
---

# Round 27 反思（Phase 6 关门轮）

## 1. 验证命令的 exit code 被管道吞掉，差点误报 verify 全绿

`pnpm verify 2>&1 | tail -30`、`... | grep -E "Tests"` 这类写法的 exit code 是 tail/grep 的，不是 verify 的——本轮第一次全量 verify 实际上 lint 失败（5 个格式错误），但因为只看了 tail 输出里的测试计数就当"全绿"继续推进，直到第二次带 `echo "exit: $?"` 的运行才暴露。**规矩：判定绿/红的命令必须显式采集 exit code**（`cmd > log 2>&1; echo "exit: $?"` 或 zsh `${pipestatus}`），测试计数只是佐证不是判据。历史轮次的"exit 0"证据若采集方式同样经管道，可靠性存疑。

## 2. biome 的 "Found N errors" 与逐条输出里的 `!`（warning）不是一回事

排查 lint 红时，`grep -B2 -A8 "×"` 抓到的前几屏全是 `!` 前缀的 warning（noNonNullAssertion），误当成 error 去修了三个无辜文件（后又撤销）。真正的 5 个 error 要用 `--diagnostic-level=error` 过滤才现形（全是本轮新文件的格式/导入排序）。**规矩：biome 排错先 `--diagnostic-level=error`**；warning 面（当前 35 条）是历史容忍区，勿顺手扩大改动面。

## 3. Send 拼错 instanceId 静默回显——"11ms 的 onEvent 不可能调过模型"这类物理不可能性是最快的定位器

DoD ④ 复验时 send 到 `manage/cron#r27-gate`（正确 id 是 spawn 返回的 `r27-gate`），accepted:true 但 cron 不建、无 agent.failed、tokensToday=0。三层排查（event tail → wrangler tail → 带 expect 重发看 output）最后靠 `{"echo":{...}}` 输出才确认命中幽灵 echo DO。两个教训：① **spawn 响应里的 instanceId 才是真源**，别按"definition#key"想当然拼；② 排查静默失败时先对账**物理量**（耗时/token/留痕行数）——11ms 的 onEvent 直接排除了"模型调用失败"整类假设。该缺陷本身已修（Send 未 Spawn → not_found，commit 2b8de74）。

## 4. `.env` 变量"存在"≠"有值"——掩码检查误判了两个空 open_id

用 `sed 's/=.*/=<set>/'` 掩码查看 .env 时，`KEY=`（空值）也显示 `<set>`，据此误判 E2E open_id 已配置并写进了流程假设，浪费了一次 MapIdentity 调用（还留下了 channelUserId='' 的脏行要清）。**规矩：检查凭据存在性用 `grep -c "^KEY=.\+"`（断言非空）**，掩码展示另做。

## 5. 关门轮的质量关口 workflow 继续 0 误报（连续第五个 Phase），对抗核查的价值锚点不变

12/12 MAJOR 确认成立、1 条降级 MINOR、0 驳回。本轮新增价值：对抗核查给出的 codeFacts 精确到"修复要改哪几行、消费方有谁、测试补哪个 reset 钩子"，主 assistant 直接照单实现（用户要求不派 worker），7 簇修复无一返工。派发核查 prompt 里的三要素保持有效：先假设误报、对照规范原文、比对 doc-gaps/PROGRESS 已声明的实现自由。
