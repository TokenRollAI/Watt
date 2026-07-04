/**
 * `watt setup feishu`（P1 飞书 plugin 化）——幂等编排飞书渠道的注册与引导。
 *
 * 五步（全幂等，Write/upsert 语义，可重跑）：
 *  ① plugin register `channel-feishu`（channel-adapter/v1，endpoint = plugin worker HTTPS URL；注册时
 *     平台探活 GET endpoint/healthz——**须先部署 watt-plugin-feishu**）→ 返回 pluginToken（回调平台的 Bearer）。
 *  ② ChannelRegistry.Write `{id:<channel>, adapter:'feishu'}`（出站分发器按约定 channel-<adapter> 解析到
 *     channel-feishu plugin）。
 *  ③ AgentRegistry.Write（lurker/scribe def；声明式订阅 im.message 随 Write 自动建立——潜伏群聊 agent）。
 *  ④ PolicyStore.Write ×2：
 *     - plugin:channel-feishu → platform://event manage（pluginToken 回调 Publish 入站事件的鉴权；
 *       Publish 动作在 platform://event 上判 manage，见 gateway platform-event 路由——**偏离计划书原述的
 *       event://feishu/* write，理由：Publish 的真实鉴权资源是 platform://event，已由 platform-event 测试锁定**）。
 *     - agent:lurker/scribe → event://* write（lurker 出站回答的部署侧 allow，出站两关之一）。
 *  ⑤ 打印部署步骤 + 飞书后台 webhook URL（指向 plugin worker）+ secrets 清单。
 *
 * 依赖注入（fetch）便于单测；LURKER_SCRIBE_DEF 内联（CLI 不能 import gateway，与 gateway/src/agent/lurker.ts
 *   保持一致的数据字面）。
 */

import { channelSet } from './channel.ts';
import { type HttpDeps, htbpCall } from './client.ts';
import { pluginRegister } from './plugin.ts';
import { policyAdd } from './policy.ts';

/** 潜伏群聊 agent 定义（与 gateway/src/agent/lurker.ts LURKER_SCRIBE_DEF 一致的数据字面）。 */
export const LURKER_SCRIBE_DEF = {
  name: 'lurker/scribe',
  description:
    '潜伏群聊 agent：静默记录群消息进 TTL scratch namespace，@提及/单聊时基于上下文回答。',
  runtime: 'light',
  entry: { kind: 'do-class', className: 'AgentInstance' },
  grants: [{ resources: ['event://*'], actions: ['write'] }],
  contextNamespaces: ['scratch/'],
  toolScopes: [],
  subscriptions: [{ match: { type: 'im.message' }, instanceBy: 'session' }],
};

export interface SetupFeishuOptions {
  /**
   * plugin worker endpoint：HTTPS base URL（外部部署）或 `binding:<NAME>`（平台内 Worker 推荐形态——
   * 同账户 workers.dev 互调被平台拦截，同账户部署必须走 gateway service binding，如 binding:FEISHU_PLUGIN）。
   */
  endpoint: string;
  /** 飞书后台事件订阅回调 URL 基址（仅指引打印用）。endpoint 为 binding: 形态时必须由此提供 plugin 公网 URL。 */
  webhookBaseUrl?: string;
  /** 渠道 id（缺省 'feishu'；出站分发器按 adapter='feishu' 解析到 channel-feishu plugin）。 */
  channelId?: string;
  /** 推荐加密模式（仅影响打印指引文案，不改行为）。 */
  encrypt?: boolean;
}

export interface SetupFeishuResult {
  pluginId: string;
  channelId: string;
  endpoint: string;
  webhookBaseUrl?: string;
  pluginToken: string;
  jwksUrl: string;
  platformBaseUrl: string;
  encrypt: boolean;
}

const PLUGIN_ID = 'channel-feishu';

/** 执行五步引导（全幂等）。返回注册产物（含 pluginToken）供指引打印。 */
export async function setupFeishu(
  base: string,
  token: string,
  opts: SetupFeishuOptions,
  deps: HttpDeps = {},
): Promise<SetupFeishuResult> {
  const channelId = opts.channelId ?? 'feishu';

  // ① 注册 channel-feishu plugin（探活 endpoint/healthz）。
  const reg = await pluginRegister(
    base,
    token,
    {
      id: PLUGIN_ID,
      kind: 'channel-adapter',
      interfaceVersion: 'channel-adapter/v1',
      endpoint: opts.endpoint,
      auth: { kind: 'platform-token' },
      requiredGrants: [{ resources: ['event://'], actions: ['write'] }],
      healthPath: '/healthz',
      enabled: true,
    },
    deps,
  );

  // ② channel Write（adapter='feishu' → 出站分发器解析到 channel-feishu）。
  await channelSet(
    base,
    token,
    { id: channelId, adapter: 'feishu', enabled: true, settings: {} },
    deps,
  );

  // ③ lurker/scribe def Write（订阅随 Write 自动建立）。
  await htbpCall(base, token, 'agent', 'Write', { definition: LURKER_SCRIBE_DEF }, deps);

  // ④ 两条 allow 策略（幂等：固定 id upsert）。
  await policyAdd(
    base,
    token,
    {
      id: 'feishu-plugin-publish',
      subject: `plugin:${PLUGIN_ID}`,
      resource: 'platform://event',
      actions: ['manage'],
      effect: 'allow',
    },
    deps,
  );
  await policyAdd(
    base,
    token,
    {
      id: 'feishu-lurker-outbound',
      subject: `agent:${LURKER_SCRIBE_DEF.name}`,
      resource: 'event://*',
      actions: ['write'],
      effect: 'allow',
    },
    deps,
  );

  return {
    pluginId: PLUGIN_ID,
    channelId,
    endpoint: opts.endpoint.replace(/\/+$/, ''),
    webhookBaseUrl: opts.webhookBaseUrl?.replace(/\/+$/, ''),
    pluginToken: reg.pluginToken,
    jwksUrl: reg.jwksUrl,
    platformBaseUrl: reg.platformBaseUrl,
    encrypt: opts.encrypt === true,
  };
}

/** 人类可读的部署/后台指引（不含把 pluginToken 明文写进日志的风险提示——token 单独一行供复制）。 */
export function formatSetupGuidance(r: SetupFeishuResult): string {
  // binding: 形态无公网 URL——回调基址须经 --webhook-url 提供，否则给占位提示。
  const webhookBase =
    r.webhookBaseUrl ??
    (r.endpoint.startsWith('binding:') ? '<plugin worker public URL>' : r.endpoint);
  const webhookUrl = `${webhookBase}/webhook/event`;
  const lines = [
    `✓ registered plugin ${r.pluginId} (channel-adapter) @ ${r.endpoint}`,
    `✓ channel '${r.channelId}' set (adapter=feishu)`,
    `✓ agent def '${LURKER_SCRIBE_DEF.name}' written (subscribes im.message; session-sticky)`,
    `✓ policies: plugin:${r.pluginId}→platform://event[manage], agent:${LURKER_SCRIBE_DEF.name}→event://*[write]`,
    '',
    'Next — deploy & configure the plugin worker (watt-plugin-feishu):',
    '  1. Deploy it (if not yet):  pnpm --filter @watt/plugin-feishu exec wrangler deploy',
    '  2. Put its secrets (on watt-plugin-feishu, NOT gateway):',
    '       wrangler secret put FEISHU_APP_ID',
    '       wrangler secret put FEISHU_APP_SECRET',
    r.encrypt
      ? '       wrangler secret put FEISHU_ENCRYPT_KEY        # encrypted mode (recommended)'
      : '       wrangler secret put FEISHU_VERIFICATION_TOKEN  # plaintext mode; ENCRYPT_KEY recommended instead',
    `       wrangler secret put WATT_BASE_URL              # = ${r.platformBaseUrl}`,
    '       wrangler secret put WATT_PLUGIN_TOKEN          # = the pluginToken printed below',
    `  3. In the feishu open-platform console, set the event-subscription callback URL to:`,
    `       ${webhookUrl}`,
    '     (encrypted mode recommended: configure Encrypt Key = FEISHU_ENCRYPT_KEY)',
    '',
    'pluginToken (store as WATT_PLUGIN_TOKEN on the plugin worker; shown once):',
    r.pluginToken,
  ];
  return lines.join('\n');
}
