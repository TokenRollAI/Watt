# 决策：云资源命名、D1 多库拆分与 provision 方案

- 日期：2026-07-02（Round 2，Phase 0）
- 状态：已实施（资源已真实创建，`pnpm verify` / smoke 回归绿）

## 1. 统一 `watt-` 前缀

- **决策**：所有云资源统一加 `watt-` 前缀（D1/KV/R2/Queue/Vectorize 全部）。
- **偏离**：附B 原文 KV namespace 无前缀。
- **理由**：该 Cloudflare 账户内有大量其他项目资源，无前缀会混淆，且不利于脚本按名匹配。
- **后续**：与附B 原文的偏差可在 Phase 0 关门时回写附B（见 `PROGRESS.md` Round 2 遗留）。

## 2. D1 采用多库而非单库

- **决策**：四个独立 D1 库——`watt-policies` / `watt-providers` / `watt-audit` / `watt-events`。
- **理由**：对应附B 四条目分属不同模块（policies→M5、providers→M8、audit→M9、events→M1），按 ownership 边界拆库，避免跨模块共享 schema。

## 3. Vectorize 维度与模型

- **决策**：`watt-context-index`，1024 维，cosine，embedding 用 `@cf/baai/bge-m3`。
- **理由**：中文 IM 场景，bge-m3 多语言召回表现好；1024 维为该模型原生输出维度。

## 4. provision 入口与幂等

- **入口**：`pnpm provision`（`scripts/provision.mjs`），幂等可重跑——先 list 判存在（资源名 substring 匹配，因 `--json` 支持不齐 + banner 污染，见 [../../guides/toolchain-pitfalls.md](../../guides/toolchain-pitfalls.md) §7），不存在才 create。
- **wrangler.jsonc 回填**：走 marker 段（脚本只改标记区间，不动手写配置）。
