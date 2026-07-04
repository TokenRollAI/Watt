# 决策：密钥 runtime 化——SecretStore（AES-256-GCM + 专用加密根密钥）

- 日期：2026-07-04（Round 33）
- 状态：已定案并线上实证（default provider 的 LLM_RELAY_KEY 仅存 KV，模型调用成功）

## 决定

1. 平台运行时密钥（provider secretRef、plugin 凭据等）不再只能走 wrangler secret，新增 **SecretStore**：`POST /htbp/platform/secret` 四动词（set/list/rm/…），**永不回显值**；CLI `watt secret`（值走 stdin）。
2. 加密：**AES-256-GCM**，根密钥为**专用 `WATT_SECRET_ENCRYPTION_KEY`**（gateway wrangler secret）；**AAD = 密钥名字**（防密文换位重放）；密文存 **KV_TENANTS 的 `secret:` 前缀**。
3. 读取链：**resolveSecret env 优先 → KV 回退**——env 里已配的（如 ANTHROPIC_API_KEY）不受影响，KV 是补充面。
4. **明确排除项**：`keys.ts` 的 JWT 私钥不进 SecretStore——它是信任根，若经 SecretStore 读取会形成信任根循环（解密 SecretStore 需要的信任面又依赖它自己）。

## 理由

1. **不从 JWT 私钥派生加密密钥**：JWT 私钥有轮换语义（--rotate），派生会导致每次轮换毁掉全部已存密文；专用 key 让"签名轮换"与"密文根"解耦。
2. AAD 绑定名字：同一根密钥下，A 名下的密文不能被搬到 B 名下解出（GCM 认证失败）。
3. 永不回显 + 值走 stdin：密钥不落 shell history / 日志 / API 响应。
4. runtime 可写（不需 redeploy）是 `watt init` 向导与 dashboard 配置页的前提。

## 影响

- gateway 新增 secret `WATT_SECRET_ENCRYPTION_KEY`（deploy-all secrets 检查已收录）。
- ModelProvider 的 secretRef 解析接 resolveSecret（default provider kv-relay 即实证）。
- dashboard SecretsView / ProvidersView（secretRef 下拉）消费此面。
