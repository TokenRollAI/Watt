# 决策：Phase 1 Auth 实现选型与边界（2026-07-02，Round 5/6）

> 涉及 Proto §6（Auth）、§6.5d（device flow）。实现位置见 [../../must/current-state.md](../../must/current-state.md) 源码现状节。

## 1. JWT 选型：Ed25519 + jose + JWKS

- **决策**：user/admin token 用 Ed25519 非对称签名，库选 jose，公钥经 `/.well-known/jwks.json` 公开。
- **理由**：Proto §11.2 语境反推需非对称——Plugin/外部方需独立验签，不能共享对称密钥；jose 是 Workers 环境标准库，原生 WebCrypto。
- 实现约束：`packages/core/src/auth/jwt.ts` 密钥全部注入（纯逻辑，测试用 fixture 密钥经 miniflare.bindings 注入）。

## 2. 私钥生命周期

- 生成（内存，`scripts/gen-jwt-keys.mjs`）→ 管道进 `wrangler secret put WATT_JWT_PRIVATE_JWK`（不落盘）→ **put 后不可取回**。
- 后果：验收/运维需要签 admin token 时不能"取私钥再签"，只能走**轮换模式**——`scripts/sign-admin-token.mjs` 生成新密钥对、put 新私钥、同进程用内存私钥直接签 token（顺带解 bootstrap 鸡生蛋：没有 token 就签不了第一个 token）。
- 注意 secret 传播窗口 ~15s（见 [../../guides/toolchain-pitfalls.md](../../guides/toolchain-pitfalls.md) §20）。

## 3. Device grants 存 KV（watt-tenants）而非 D1

- **决策**：device flow 的 grant 状态存 KV，`expirationTtl` 对齐 `expires_in`，双索引（device_code 键 + user_code 键）。
- **理由**：grant 是短命（默认 600s）自过期状态，KV 的 TTL 语义天然贴合；进 D1 要自己扫过期行，且无查询/关联需求。不新增 migration。

## 4. OAuth 端点错误形状边界：RFC 裸形状 vs WattError

- `/oauth/device/authorize` 与 `/oauth/token`：**豁免 WattError**，遵循 RFC 8628/OAuth 错误形状（如 `{error:"authorization_pending"}` HTTP 400）——OAuth 客户端生态按 RFC 形状解析，包 WattError 会破坏互操作。
- `/oauth/device/approve`：**仍走 WattError**——它不是 RFC 端点，而是平台管理动作（admin 带 token 调用），归平台错误契约。
- 边界判据：**RFC 定义的端点按 RFC；平台自有动作按 WattError**。已回写 Proto §6.5d。

## 5. CLI 未认证语义分层

- **本地无 token**（`WATT_TOKEN` 未设且 `~/.watt/credentials.json` 不存在）→ exit 2，提示 `watt login`——用户侧配置问题，不发请求。
- **服务端 401**（有 token 但过期/无效）→ exit 1——服务端判定结果。
- 理由：脚本/CI 可凭退出码区分"没配"和"配错"，两者修复路径不同。

## 6. KV 判定缓存：Phase 1 有意跳过

- §6.4c 允许"实现可用 KV 缓存各段结果"。Phase 1 只有步骤 1（user token 无 agent 链），判定就是一次 D1 查询，缓存收益小而失效逻辑（Policy 变更）成本高。
- 代码注释已声明跳过；`watt-authz-cache` KV 已 provision，留待 agent 链判定（Phase 4/5）真实多段查询时启用。
