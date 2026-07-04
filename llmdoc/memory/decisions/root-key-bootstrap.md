# 决策：Root Key 持久引导凭据（仅展示一次，换发制）

- 日期：2026-07-04（Round 35）
- 状态：已实现上线（Proto §6.5e 规范先行）

## 决定

新增一把持久引导凭据 **Root Key**（`wrk_` + 32B base64url）：平台只存 SHA-256 摘要（gateway secret `WATT_ROOT_KEY_HASH`），明文在生成时**仅展示一次**（set-root-key.mjs / watt init 收尾）。Root Key 不能直接调用任何接口，唯一用途是经 `POST /oauth/root/token` **换发** §6.5a 形状的 admin user token（TTL 缺省 7d、钳 30d；成功/失败都写 `platform://auth` `root-exchange` 审计）。

## 理由

1. 消解引导死角：此前 admin token（1h/7d）过期后唯一自救 = 轮换 JWT 私钥重签 → **吊销全部存量 token 连坐 pluginToken** → 还要重跑 setup feishu（又会触发 §63 def 覆盖坑）。Root Key 换发用当前私钥签名，与轮换完全解耦。
2. 摘要比对天然常数时间；明文不落盘/不落库/不回显，泄露时重跑 set-root-key 覆写即失效（存量 JWT 不受影响自然过期）。
3. 消费面覆盖 TUI/WEB：`watt login --root`（stdin）、dashboard Settings 密码框。

## 关联

- [../../guides/toolchain-pitfalls.md] §63（def Write 整体覆盖）——Root Key 上线后轮换频率骤降，该坑触发面同步收窄。
- Proto §6.5c′（init 本地签发首 token）仍保留：init 现在同时产出 Root Key，两者互补（首 token 立即可用，Root Key 管长期）。
