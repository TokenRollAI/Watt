# 决策：飞书转正为独立 channel-adapter plugin + 自持 webhook 回调主路径

- 日期：2026-07-04（Round 33）
- 状态：已定案并采证（Phase 6 ② 真实群消息闭环即经此路径）
- 取代：[feishu-websocket-channel.md](feishu-websocket-channel.md)（WS push 型降为 dev-only 备用）

## 决定

1. 飞书接入从「WS push 型 + CLI 本地长驻（`watt channel connect`）」**转正为独立 channel-adapter plugin**：新包 `packages/plugin-feishu`，部署为独立 Worker `watt-plugin-feishu`。
2. **入站主路径 = plugin 自持 webhook 回调**（`/webhook/event`：challenge 握手、验签、AES 解密、decode、mentions 展开，以 pluginToken 调平台 Publish）；出站经 §11.4 Encode/Send 面（gateway 经 service binding 调入）。
3. FEISHU_* 凭据由 plugin worker 自持，移出 gateway。
4. 回调面挂 **custom domain `watt-feishu.pdjjq.org`**（Universal SSL 只盖一级子域）。
5. WS `channel connect` 保留为 **dev-only** 备用路径，不再是主路径。

## 理由

1. **用户要求可独立发行**：channel adapter 作为 watt-plugins/* 独立包/独立 Worker，可单独部署、单独发布，是 Plugin.md 生态的第一个真实实例。
2. **境内 workers.dev 被干扰**：飞书回调方 3s 握手必超时——用 custom domain 解决后 webhook 路径完全可用，原「免公网回调 URL」的 WS 优势不再是必需。
3. **彻底摆脱本地长驻**：WS 方案要求 CLI 进程本机常开（Node SDK 不能跑 Workers isolate），入站可用性绑死在开发机上；webhook plugin 是纯 Workers 常驻，无人值守。

## 影响

- Phase 6 ② 采证经此路径闭环（真实群 @watt 收到回复，events/audit 双留痕）。
- 出站分发经通用 plugin-sender（见 [plugin-outbound-dispatcher.md](plugin-outbound-dispatcher.md)）；gateway `feishu-sender.ts` 已删除。
- `watt setup feishu` 幂等五步负责签 pluginToken + put plugin secrets + 注册。
- 飞书后台「事件发送至开发者服务器」须保持 `https://watt-feishu.pdjjq.org/webhook/event`。
- 验签细节与权限事实见 toolchain-pitfalls §61 与 [../../reference/external-facts.md](../../reference/external-facts.md)。
