# 决策：通用出站分发器（plugin-sender）替换渠道硬编码

- 日期：2026-07-04（Round 33）
- 状态：已定案（gateway `src/event/plugin-sender.ts`；feishu-sender 已删）

## 决定

consumer 的 outbound.message 投递不再按渠道硬编码，统一走通用分发器：

1. **寻址约定**：channel 的 `adapter` → plugin id **`channel-<adapter>`**（channel `settings.pluginId` 可覆盖）→ 查 PluginRegistry。
2. **双形态投递**：plugin endpoint 是 `binding:` 前缀 → 经 **service binding** 调用；否则走 HTTPS，POST §11.4 `{"tool":"Send"}` 信封。
3. **调用契约**：带 platform-token 认证 + `X-Watt-Request-Id` 幂等键 + 10s 超时；retryable 失败走 msg.retry 重投（幂等由请求 id 保证）。

## 理由

1. **同账户 workers.dev 互调被平台拦截是决定性理由**：R33 实测 gateway 经 HTTPS 调同账户 `watt-plugin-feishu.workers.dev` 的探活/Send 一律收 **404**（非文档所述 1042 错误码）——同账户 plugin 只能走 service binding；HTTPS 形态留给跨账户/第三方 plugin。
2. 渠道硬编码（原 feishu-sender）与 Plugin.md 的 channel-adapter 契约冲突：新渠道要改 gateway 源码；分发器 + registry 后新增渠道只需注册 plugin。
3. `channel-<adapter>` 命名约定让零配置场景开箱即用，settings.pluginId 覆盖保留灵活性。

## 影响

- gateway 不再持有任何渠道 SDK/凭据（FEISHU_* 移出）；wrangler 增 service binding `FEISHU_PLUGIN`。
- deploy 顺序：plugin worker 必须先于 gateway 部署（binding 目标先存在）。
- 相关坑：toolchain-pitfalls §54（同账户 404）、§55（workers.dev 境内干扰）。
