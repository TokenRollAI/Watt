# 决策：飞书渠道走 WebSocket 长连接（push 型），不走 webhook

- 日期：2026-07-02
- 状态：**已被取代**（2026-07-04 Round 33：主路径改为独立 channel-adapter plugin + 自持 webhook 回调，见 [feishu-plugin-webhook.md](feishu-plugin-webhook.md)；WS `channel connect` 降为 dev-only 备用。以下原文保留作历史依据）
- 原状态：已定案（Phase 6 实现依据；DOD §8/§9 已按此写入）

## 决定

飞书 ChannelAdapter 采用**长连接 push 型**接入（飞书后台订阅方式选"使用长连接接收事件"，无需配置 inbound URL），不走 webhook 回调。webhook 型（`FEISHU_WEBHOOK_URL`/`FEISHU_VERIFICATION_TOKEN`）保留为备用路径。

## 理由

1. 免公网回调 URL 与验签/加密配置，开发与部署都更简单；`FEISHU_ENCRYPT_KEY` 在 WS 方案下非必需。
2. 与 Plugin 契约兼容：push 型 ChannelAdapter 可豁免 Verify/Decode（capabilities 声明 `push`，Plugin.md §2 / Proto §2.1），规约义务（session/channelUser/dedupeKey=event_id）在 Adapter 内自行完成，以 plugin token 调 `EventBus.Publish`。
3. 出站路径（Encode/Send，飞书 REST API 含 actions 卡片）已于 2026-07-02 实测通过（测试群 "Tipsy Agent Infra"）。

## 宿主约束（关键实现注意）

`@larksuiteoapi/node-sdk` 的 WSClient 是 Node SDK，**不能跑在 Workers isolate**。连接进程宿主：

- 生产：Container（M2 Heavy Runtime）。
- 开发期：由 CLI 承载——`watt channel connect feishu-main` 在本地维持长连接并把事件转发进 `EventBus.Publish`。

## 影响

- Phase 0 的 `POST /channels/<id>/inbound` webhook 入口仅为通用 ChannelAdapter 保留占位，飞书不用。
- Phase 6 单测须覆盖 WS 断线重连与事件去重（dedupeKey=event_id）。
- 相关文档：[../../reference/external-facts.md](../../reference/external-facts.md)、[../../must/current-state.md](../../must/current-state.md)。
