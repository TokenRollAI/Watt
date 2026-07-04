# @watt/plugin-feishu

Watt 的第一个独立可发行 channel-adapter plugin（飞书）。独立 Worker `watt-plugin-feishu`，自包含全部渠道逻辑（验签/解密/decode/encode/send/凭据），与 gateway 零硬编码耦合。采用 Proto §2.1 的**自持回调型**接入。

## 结构

- `src/adapter/` — 纯逻辑（无 I/O 或可注入 I/O），经包入口 `@watt/plugin-feishu` 导出供 CLI `channel connect`（WS dev 路径）复用：
  - `crypto.ts` — 验签 `sha256(timestamp+nonce+encrypt_key+body)` + AES-256-CBC 解密（key=`sha256(encrypt_key)`，iv=密文前 16 字节），全走 Web Crypto。
  - `verify.ts` — 自持回调 Verify + 明文提取（加密模式验签+解密 / 明文模式 verification token 比对）+ `url_verification` challenge。
  - `decode.ts` — 飞书事件 → 平台 Event（迁自 `@watt/core` + mentions 展开：`payload.mentions`/`mentionedBot`/`chatType` + 占位符还原）。
  - `encode.ts` — OutboundMessage → 飞书 REST 报文。
  - `send.ts` — tenant_access_token 换取+缓存 + REST 投递 + SendReceipt/retryable 语义 + uuid 幂等。
  - `botinfo.ts` — 机器人 open_id 自查（判定 @机器人）。
- `src/worker.ts` — Worker 宿主：`POST /webhook/event` 自持回调 + `POST /`（§11.4 `Send`/`Encode`）+ `~describe`/`~help`/`~skill`/`healthz`。`createFeishuWorker(deps)` 工厂注入便于测试。
- `src/index.ts` — wrangler 入口（生产 wiring）。

## Secrets（`wrangler secret put`，plugin worker 自持——gateway 不再持有任何飞书凭据）

| 名字 | 用途 |
|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | tenant_access_token 换取（出站 REST） |
| `FEISHU_ENCRYPT_KEY` | 事件订阅加密（配置后：验签 + AES-256-CBC 解密；**推荐**） |
| `FEISHU_VERIFICATION_TOKEN` | 明文模式来源校验（未配 ENCRYPT_KEY 时比对） |
| `WATT_PLUGIN_TOKEN` | 回调平台 Publish 的 Bearer（`PluginRegistry.Write` 签发的 pluginToken） |
| `WATT_BASE_URL` | 平台基址（Publish 入口 + JWKS 派生验签 platform-token） |

`FEISHU_BASE_URL` 在 wrangler.jsonc `vars`（国际版覆盖为 `https://open.larksuite.com`）。

## 部署与引导

```
pnpm --filter @watt/plugin-feishu exec wrangler deploy      # 或 pnpm deploy:all（含 plugin，--skip-plugins 可跳）
# put 上述 secrets 到 watt-plugin-feishu
watt setup feishu                                           # 幂等：plugin register + channel + lurker def + policy ×2
# 飞书开放平台后台把事件订阅回调 URL 指向 https://watt-plugin-feishu.<subdomain>.workers.dev/webhook/event
```

pluginToken 无过期轮换机制（`roles:[]` 平台 token）：失效时重跑 `watt plugin register channel-feishu ...` 取新 token 并重 `wrangler secret put WATT_PLUGIN_TOKEN`。
