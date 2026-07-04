> 本目录为 GitHub Actions 工作流：
>
> - `ci.yml` — push/PR 到 main 时跑 `pnpm verify`（typecheck + biome + 全部 vitest，gateway 跑真实 workerd）。
> - `release.yml` — 推 `v*` tag（或手动 workflow_dispatch）时构建部署产物并发布 `@token-roll/watt` 到 npm。
>
> 发布认证二选一（release.yml 两者兼容）：
> 1. **Trusted Publishing（推荐，免 token）**：npmjs.com → 包 `@token-roll/watt` → Settings → Trusted Publisher，
>    填 GitHub org `TokenRollAI`、repo `Watt`、workflow `release.yml`。配置后 CI 经 OIDC 免密发布（带 provenance）。
>    注意：需要包已存在（首个版本先本地 `pnpm release:cli` 发布）。
> 2. **NPM_TOKEN secret**：npmjs.com 创建 Granular Access Token（Read and write，Packages and scopes 选 @token-roll），
>    然后 `gh secret set NPM_TOKEN` 写入仓库 secret。
