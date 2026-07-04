/**
 * 飞书 channel-adapter plugin 的 Worker 宿主（Proto §2.1 自持回调型 + §11.4 平台→plugin HTBP 面）。
 *
 * 路由：
 *  - POST /webhook/event   —— 飞书事件订阅回调（自持）：验签+解密（verifyAndExtract）→ url_verification
 *      challenge 短路 → decode → 以 WATT_PLUGIN_TOKEN 调平台 POST /htbp/platform/event Publish（dedupeKey=
 *      event_id 幂等）。飞书要求 1s 内响应——decode+Publish 同步完成后 200。
 *  - POST /               —— §11.4 方法调用 {tool,arguments}：Send（tenant token+REST 投递+SendReceipt）/
 *      Encode（拼报文，供检视/测试）。认证 = platform-token（Bearer，经平台 JWKS 验签）。
 *  - GET  /~describe /~help /~skill /healthz —— PluginLifecycle + HTBP 自描述（§11.2/§3.2）。
 *
 * 分层：本文件是宿主（副作用），经 createFeishuWorker(deps) 注入 verifyPlatformToken/fetch/now/tokenCache
 *   便于测试；纯逻辑全在 adapter/。生产 wiring 见 src/index.ts。
 */

import { wattError } from '@watt/shared';
import { fetchBotOpenId } from './adapter/botinfo.ts';
import {
  decodeFeishuEvent,
  encodeFeishuOutbound,
  extractChallenge,
  type FeishuSendConfig,
  type FeishuVerifyConfig,
  memoryTokenCache,
  type OutboundMessage,
  sendFeishuMessage,
  type TokenCache,
  verifyAndExtract,
} from './adapter/index.ts';

export interface FeishuWorkerEnv {
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  /** 事件订阅加密密钥（配置后：验签 + AES-256-CBC 解密；推荐）。 */
  FEISHU_ENCRYPT_KEY?: string;
  /** 明文模式来源校验 token（未配 ENCRYPT_KEY 时比对）。 */
  FEISHU_VERIFICATION_TOKEN?: string;
  FEISHU_BASE_URL?: string;
  /** 回调平台 Publish 的 Bearer（PluginRegistry.Write 签发的 pluginToken）。 */
  WATT_PLUGIN_TOKEN?: string;
  /** 平台基址（Publish 入口 + 缺省 JWKS 派生）。 */
  WATT_BASE_URL?: string;
  /** 显式 JWKS URL（缺省 WATT_BASE_URL + /.well-known/jwks.json）。 */
  WATT_JWKS_URL?: string;
  WATT_JWT_ISSUER?: string;
  WATT_JWT_AUDIENCE?: string;
}

export interface FeishuWorkerDeps {
  env: FeishuWorkerEnv;
  fetchImpl?: typeof fetch;
  now?: () => string;
  /** 验证平台 token（platform-token）；缺省经 JWKS 验签。测试注入 fake。 */
  verifyPlatformToken?: (token: string) => Promise<boolean>;
  /** token 缓存（缺省 isolate 内存）。 */
  tokenCache?: TokenCache;
}

const DEFAULT_FEISHU_BASE = 'https://open.feishu.cn';
const DEFAULT_ISSUER = 'watt-platform';
const DEFAULT_AUDIENCE = 'watt-api';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 裸 WattError body（§0.2，与平台一致——无信封）。 */
function errResponse(
  code: Parameters<typeof wattError>[0],
  message: string,
  status: number,
  retryable = false,
): Response {
  return json(wattError(code, message, retryable), status);
}

function lowerHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

/** ~help Help DSL（方法集合 = channel-adapter 出站面 Encode/Send；注册时契约校验用）。 */
const HELP_DSL = {
  htbp: 'draft',
  kind: 'channel-adapter',
  title: 'feishu channel adapter',
  commands: [
    {
      cmd: 'Send',
      summary:
        'Deliver an OutboundMessage to feishu (tenant_access_token + REST; idempotent by X-Watt-Request-Id).',
      arguments: { message: 'OutboundMessage {channel,target,content{text?,actions?}}' },
      returns: 'SendReceipt {ok, channelMessageId?, error?, retryable?}',
    },
    {
      cmd: 'Encode',
      summary: 'Encode an OutboundMessage into a feishu REST payload (inspection/testing).',
      arguments: { message: 'OutboundMessage' },
      returns: 'FeishuOutboundPayload {receive_id, msg_type, content}',
    },
  ],
};

const SKILL_MD = `# feishu channel adapter (@watt/plugin-feishu)

Self-hosted webhook channel adapter (Proto §2.1 self-hosted-callback variant).

## Inbound
Point the feishu event-subscription callback URL at \`POST <endpoint>/webhook/event\`.
- **Encrypted mode (recommended)**: set \`FEISHU_ENCRYPT_KEY\` → the adapter verifies
  \`X-Lark-Signature\` (sha256(timestamp+nonce+encrypt_key+body)) and AES-256-CBC decrypts.
- **Plaintext mode**: leave \`FEISHU_ENCRYPT_KEY\` unset → set \`FEISHU_VERIFICATION_TOKEN\`
  so the adapter can validate the event source.

## Outbound
The platform outbound dispatcher calls \`POST <endpoint>\` with \`{"tool":"Send","arguments":{"message":...}}\`
and a \`platform-token\` Bearer + \`X-Watt-Request-Id\` (feishu \`uuid\` idempotency key).

## Token rotation
The plugin's callback token is the \`pluginToken\` from \`PluginRegistry.Write\`. It has no built-in
expiry/rotation; if it stops working re-run \`watt plugin register channel-feishu ...\` and put the
new \`WATT_PLUGIN_TOKEN\` secret on this worker.
`;

/**
 * 构造飞书 plugin Worker（依赖注入）。返回 { fetch }。
 */
export function createFeishuWorker(deps: FeishuWorkerDeps): {
  fetch: (request: Request) => Promise<Response>;
} {
  const env = deps.env;
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = deps.now ?? (() => new Date().toISOString());
  const baseUrl = (env.FEISHU_BASE_URL ?? DEFAULT_FEISHU_BASE).replace(/\/+$/, '');
  const cache = deps.tokenCache ?? memoryTokenCache();
  const sendCfg: FeishuSendConfig = {
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    baseUrl,
    fetchImpl,
    cache,
  };
  const verifyConfig: FeishuVerifyConfig = {
    ...(env.FEISHU_ENCRYPT_KEY !== undefined ? { encryptKey: env.FEISHU_ENCRYPT_KEY } : {}),
    ...(env.FEISHU_VERIFICATION_TOKEN !== undefined
      ? { verificationToken: env.FEISHU_VERIFICATION_TOKEN }
      : {}),
  };

  // bot open_id 自查缓存（isolate 级；bot open_id 不变）。失败不阻断入站（decode 退化 p2p/字面量）。
  let botOpenIdPromise: Promise<string | undefined> | null = null;
  const getBotOpenId = (): Promise<string | undefined> => {
    if (botOpenIdPromise === null) {
      botOpenIdPromise = (async () => {
        try {
          const cacheGet = await cache.get('feishu:tenant_access_token');
          let token = cacheGet ?? undefined;
          if (token === undefined && env.FEISHU_APP_ID && env.FEISHU_APP_SECRET) {
            // 触发一次 token 换取（send 路径同源缓存）——用 fetchBotOpenId 前需 token。
            const res = await fetchImpl(
              `${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  app_id: env.FEISHU_APP_ID,
                  app_secret: env.FEISHU_APP_SECRET,
                }),
              },
            );
            const body = (await res.json()) as {
              code?: number;
              tenant_access_token?: string;
              expire?: number;
            };
            if (body.code === 0 && body.tenant_access_token) {
              token = body.tenant_access_token;
              await cache.put('feishu:tenant_access_token', token, (body.expire ?? 7200) - 60);
            }
          }
          if (token === undefined) return undefined;
          return await fetchBotOpenId(baseUrl, token, fetchImpl);
        } catch {
          botOpenIdPromise = null; // 允许下次重试
          return undefined;
        }
      })();
    }
    return botOpenIdPromise;
  };

  const verifyPlatformToken =
    deps.verifyPlatformToken ?? defaultPlatformTokenVerifier(env, fetchImpl);

  async function handleWebhook(request: Request): Promise<Response> {
    const body = await request.text();
    const raw = { headers: lowerHeaders(request), body };
    const result = await verifyAndExtract(raw, verifyConfig);
    if (!result.ok) {
      // 验签/来源校验失败 → 拒收（不 Publish）。
      return errResponse('permission_denied', `feishu webhook rejected: ${result.reason}`, 401);
    }
    // url_verification 握手：原样返回 challenge（1s 内）。
    const challenge = extractChallenge(result.payload);
    if (challenge !== undefined) return json({ challenge });

    const botOpenId = await getBotOpenId();
    const decoded = decodeFeishuEvent(result.payload, {
      now,
      ...(botOpenId !== undefined ? { botOpenId } : {}),
    });
    if (decoded.skip) {
      // 未知/畸形事件：静默 ack（承载不因单事件断流）。
      return json({ ok: true, skipped: decoded.reason });
    }

    // 以 pluginToken 调平台 Publish（保留 source.kind='im'，dedupeKey=event_id 幂等）。
    const pluginToken = env.WATT_PLUGIN_TOKEN;
    const platformBase = (env.WATT_BASE_URL ?? '').replace(/\/+$/, '');
    if (!pluginToken || platformBase.length === 0) {
      return errResponse(
        'unavailable',
        'WATT_PLUGIN_TOKEN / WATT_BASE_URL not configured',
        503,
        true,
      );
    }
    const pubRes = await fetchImpl(`${platformBase}/htbp/platform/event`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${pluginToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tool: 'Publish', arguments: { event: decoded.event } }),
    });
    if (!pubRes.ok) {
      const detail = await pubRes.text().catch(() => '');
      // Publish 失败 → 返回 500 retryable（飞书会重推同 event_id，平台侧 dedupe 兜底）。
      return errResponse(
        'internal',
        `platform Publish failed: HTTP ${pubRes.status} ${detail}`,
        502,
        true,
      );
    }
    return json({ ok: true });
  }

  async function handleHtbpCall(request: Request): Promise<Response> {
    const auth = request.headers.get('authorization') ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (token.length === 0 || !(await verifyPlatformToken(token))) {
      return errResponse('permission_denied', 'invalid or missing platform-token', 401);
    }
    let call: { tool?: string; arguments?: Record<string, unknown> };
    try {
      call = (await request.json()) as typeof call;
    } catch {
      return errResponse('invalid_argument', 'request body must be JSON', 400);
    }
    const args = call.arguments ?? {};
    switch (call.tool) {
      case 'Send': {
        const message = args.message as OutboundMessage | undefined;
        if (message === undefined || typeof message !== 'object') {
          return errResponse('invalid_argument', 'Send requires arguments.message', 400);
        }
        // 幂等键：优先 X-Watt-Request-Id（平台每次逻辑调用唯一，重试不变），回落 args.dedupeId。
        const requestId =
          request.headers.get('x-watt-request-id') ??
          (typeof args.dedupeId === 'string' ? args.dedupeId : undefined);
        const receipt = await sendFeishuMessage(
          sendCfg,
          message,
          requestId !== undefined ? { dedupeId: requestId } : {},
        );
        // SendReceipt 成功 200；失败按 retryable 映射 HTTP（429/5xx retryable=true 时平台重投，§11.4a）。
        if (receipt.ok) return json(receipt);
        return json(receipt, receipt.retryable ? 503 : 422);
      }
      case 'Encode': {
        const message = args.message as OutboundMessage | undefined;
        if (message === undefined || typeof message !== 'object') {
          return errResponse('invalid_argument', 'Encode requires arguments.message', 400);
        }
        return json(encodeFeishuOutbound(message));
      }
      default:
        return errResponse('invalid_argument', `unknown tool: ${String(call.tool)}`, 400);
    }
  }

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      if (request.method === 'POST' && path === '/webhook/event') return handleWebhook(request);
      if (request.method === 'POST' && path === '/') return handleHtbpCall(request);
      if (request.method === 'GET') {
        switch (path) {
          case '/~describe':
            return json({
              kind: 'channel-adapter',
              interfaceVersion: 'channel-adapter/v1',
              capabilities: ['push'],
            });
          case '/~help':
            return json(HELP_DSL);
          case '/~skill':
            return new Response(SKILL_MD, {
              status: 200,
              headers: { 'content-type': 'text/markdown; charset=utf-8' },
            });
          case '/healthz':
            return json({ healthy: true });
        }
      }
      return errResponse('not_found', `no route for ${request.method} ${path}`, 404);
    },
  };
}

/** 默认 platform-token 验签器（jose JWKS）——生产 wiring。 */
function defaultPlatformTokenVerifier(
  env: FeishuWorkerEnv,
  _fetchImpl: typeof fetch,
): (token: string) => Promise<boolean> {
  const jwksUrl =
    env.WATT_JWKS_URL ??
    (env.WATT_BASE_URL !== undefined
      ? `${env.WATT_BASE_URL.replace(/\/+$/, '')}/.well-known/jwks.json`
      : undefined);
  const issuer = env.WATT_JWT_ISSUER ?? DEFAULT_ISSUER;
  const audience = env.WATT_JWT_AUDIENCE ?? DEFAULT_AUDIENCE;
  // jose createRemoteJWKSet 缓存公钥（workerd 全局 fetch 拉 JWKS）；每 isolate 建一次。
  let jwksState: { verify: (t: string) => Promise<boolean> } | null = null;
  return async (token: string): Promise<boolean> => {
    if (jwksUrl === undefined) return false;
    if (jwksState === null) {
      const { createRemoteJWKSet, jwtVerify } = await import('jose');
      const jwks = createRemoteJWKSet(new URL(jwksUrl));
      jwksState = {
        verify: async (t: string) => {
          try {
            await jwtVerify(t, jwks, { issuer, audience, algorithms: ['EdDSA'] });
            return true;
          } catch {
            return false;
          }
        },
      };
    }
    return jwksState.verify(token);
  };
}
