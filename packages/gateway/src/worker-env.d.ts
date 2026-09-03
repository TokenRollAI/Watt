// Agents SDK 需要全局 `Env`（= Cloudflare.Env）作 Agent<Env,State> 泛型 + getAgentByName<Env>。
// Watt 用 src/env.ts 的 Bindings 作运行时绑定真源；此处声明合并 Cloudflare.Env extends Bindings，
// 使 src 编译期 `Env` 全局解析到 Bindings（cf-typegen 的等价物，手写以不引入生成步骤）。
// test/env.d.ts 在此基础上再合并 TEST_* 测试绑定（声明合并，互不冲突）。

import type { Bindings } from './env.ts';

declare global {
  interface Env extends Bindings {
    ASSETS: Fetcher;
    AUTH_BEARER_TOKEN?: string;
    OAUTH_ISSUER?: string;
    OAUTH_JWKS_URI?: string;
    OAUTH_REQUIRED_AUDIENCE?: string;
    MCP_SERVERS_JSON?: string;
    ALLOW_INSECURE_MCP_HTTP?: string;
    HTBP_REMOTE_ALLOWLIST?: string;
    TENANT_MODE?: string;
    TENANTS?: KVNamespace;
  }

  namespace Cloudflare {
    interface Env extends Bindings {}
  }
}
