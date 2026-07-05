declare global {
  interface Env {
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
}

export {};
