/**
 * 潜伏群聊 agent（Case 3 / E2E-3，R31 B5）——lurker/* 定义的专用 harness 逻辑。
 *
 * 行为（Vision Case 3）：
 *  - 静默：收到 im.message（未触发）→ 写入会话级 TTL scratch namespace（context://scratch/<session>），
 *    **不产生任何出站**（deliverToAgent 无 correlationId → 无 result 事件；本 harness 不 publish）。
 *  - 触发：**渠道无关判定**（P1）——payload.mentionedBot===true（飞书 decode 展开 @机器人）/
 *    payload.chatType==='p2p'（单聊）/ 文本含 '@watt'（字面量兜底，无 decode 结构时用）→
 *    读 scratch 上下文 → 出站回答（outbound.message 经 system 管道，含上下文条数=协议事实）。
 *  - session 粘性由声明式订阅 instanceBy:'session' 保证（同 session 恒同实例）。
 *
 * scratch namespace：惰性挂载 structured provider + TTL（SCRATCH_TTL_SEC）——到期整个 namespace
 *   回收（§4.2），"过期后 List 为空/404" 即 E2E-3 判据②的 TTL 生效面。
 */

import type { AgentDefinition, Event } from '@watt/core';
import type { Bindings } from '../env.ts';
import type { HarnessOutcome } from './harness/types.ts';

/** scratch namespace TTL（秒）——短 TTL 使 E2E 能在分钟级断言过期回收（实现声明）。 */
export const SCRATCH_TTL_SEC = 120;

/** 提及标记（字面量兜底：无 decode 结构（如 API 直投）时的触发判定）。 */
export const MENTION_MARKER = '@watt';

/** 潜伏 agent 内置定义（E2E-3 由脚本注册——不入全局种子：订阅全量 im.message 是部署级决策）。 */
export const LURKER_SCRIBE_DEF: AgentDefinition = {
  name: 'lurker/scribe',
  description:
    '潜伏群聊 agent：静默记录群消息进 TTL scratch namespace，@watt 提及时基于上下文回答。',
  runtime: 'light',
  entry: { kind: 'do-class', className: 'AgentInstance' },
  // 出站能力上限（§6.4c 步骤 2）：def 声明可写 event://（回答出站）；步骤 1 仍需部署侧
  //   allow 策略（subject agent:lurker/scribe）——两关都过才放行。
  grants: [{ resources: ['event://*'], actions: ['write'] }],
  contextNamespaces: ['scratch/'],
  toolScopes: [],
  subscriptions: [{ match: { type: 'im.message' }, instanceBy: 'session' }],
};

/** session → scratch namespace（session 含 ':'，namespace 段字符收敛为 [a-z0-9-]）。 */
export function scratchNamespace(session: string): string {
  return `scratch/${session.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
}

/** 从 im.message payload 提文本（decode 产物 {text} / 卡片 {content:{text}} 双形状兼容）。 */
function extractText(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const p = payload as { text?: unknown; content?: { text?: unknown } };
  if (typeof p.text === 'string') return p.text;
  if (typeof p.content?.text === 'string') return p.content.text;
  return '';
}

/**
 * 触发判定（P1，渠道无关）：飞书 decode 产出 payload.mentionedBot（@机器人）/ chatType==='p2p'（单聊）；
 * 二者皆无（如 API 直投的裸事件）时退化为文本含 '@watt' 字面量兜底。
 */
function isTriggered(payload: unknown, text: string): boolean {
  if (typeof payload === 'object' && payload !== null) {
    const p = payload as { mentionedBot?: unknown; chatType?: unknown };
    if (p.mentionedBot === true) return true;
    if (p.chatType === 'p2p') return true;
  }
  return text.includes(MENTION_MARKER);
}

/**
 * lurker harness（AgentInstance.runHarness 按 definition 前缀分派）。
 * 非 im.message / 无 session → 忽略（result 但无 correlationId 不外发）。
 */
export async function runLurkerHarness(env: Bindings, event: Event): Promise<HarnessOutcome> {
  if (event.type !== 'im.message' || event.session === undefined) {
    return { kind: 'result', output: { ignored: true } };
  }
  const text = extractText(event.payload);
  const ns = scratchNamespace(event.session);
  await ensureScratchMount(env, ns);

  const { StructuredContextProvider } = await import('../context/providers/structured.ts');
  const provider = new StructuredContextProvider(env.DB_CONTEXT, ns);

  if (!isTriggered(event.payload, text)) {
    // 静默记录：path=event.id（天然幂等），零出站。
    const res = await provider.write(event.id, {
      content: JSON.stringify({ text, at: event.occurredAt, from: event.channelUser?.userId }),
      contentType: 'application/json',
    });
    if ('code' in res) {
      return { kind: 'failed', reason: 'error', errorMessage: `scratch write: ${res.message}` };
    }
    return { kind: 'result', output: { recorded: true } };
  }

  // @提及：读 scratch 上下文 → 出站回答（协议事实：回答含上下文条数）。
  const page = await provider.list('', { limit: 200 });
  const count = 'code' in page ? 0 : page.items.length;
  const question = text.replace(MENTION_MARKER, '').trim();
  const channel = event.source.channel ?? 'feishu-main';
  // target：session 'feishu:chat:<id>' 取末段（渠道内会话 id）；其余形状整段兜底。
  const target = event.session.split(':').pop() ?? event.session;

  // 出站鉴权（R32 关门修正）：lurker 回答是 **agent 主动出站**，非系统内置路由——必须过
  //   Check(event://<channel>/<target>,'write')（Proto §2.3，doc-gaps #25② 豁免面只含系统卡片）。
  //   claims 带 agent_def → 平台 Authorizer 的空 agentDefs 索引会误拒（同 pitfalls §51 cronJobs
  //   教训）——直接 core authorize 播种本 def；审计单独补一条（每个 Check 判定不漏，§10）。
  const { authorize } = await import('@watt/core');
  const { PolicyStore } = await import('../authz/policy-store.ts');
  const claims = {
    sub: `agent:${LURKER_SCRIBE_DEF.name}`,
    roles: [],
    agent_def: LURKER_SCRIBE_DEF.name,
    agent_inst: `agent:${LURKER_SCRIBE_DEF.name}#session:${event.session}`,
  };
  const resource = `event://${channel}/${target}`;
  const candidates = await new PolicyStore(env.DB_POLICIES).resolveCandidatePolicies(claims);
  const decision = authorize({
    claims,
    resource,
    action: 'write',
    policies: candidates,
    agentDefs: { [LURKER_SCRIBE_DEF.name]: LURKER_SCRIBE_DEF },
    cronJobs: {},
    instances: {},
  });
  try {
    const { AuditStore } = await import('../audit/audit-store.ts');
    await new AuditStore(env.DB_AUDIT).write({
      context: {
        principal: claims.sub,
        roles: [],
        traceId: event.traceId,
        agent: { instanceId: claims.agent_inst, chain: [] },
      },
      resource,
      action: 'write',
      decision: decision.allow ? 'allow' : 'deny',
      ...(decision.reason !== undefined ? { detail: { reason: decision.reason } } : {}),
    });
  } catch (err) {
    console.error('lurker: outbound audit write failed', { err: String(err) });
  }
  if (!decision.allow) {
    return {
      kind: 'failed',
      reason: 'rejected',
      errorMessage: `lurker outbound denied: ${decision.reason ?? 'no policy'}`,
    };
  }

  const { publishTaskOutbound } = await import('../task/task-events.ts');
  await publishTaskOutbound(env, {
    channel,
    target,
    text: `（基于本群 ${count} 条上下文）你问：「${question}」——上下文已记录在 context://${ns}。`,
    // 幂等键=源事件 id：队列重投重放本 harness 时不重复答复（R32 关门修正）。
    dedupeKey: `lurker:answer:${event.id}`,
  });
  return { kind: 'result', output: { answered: true, contextCount: count } };
}

/** 惰性挂载 scratch namespace（structured + TTL）；已存在（未过期）则复用。 */
async function ensureScratchMount(env: Bindings, ns: string): Promise<void> {
  const registry = env.CONTEXT_REGISTRY.get(env.CONTEXT_REGISTRY.idFromName('registry'));
  const mount = await registry.get(ns);
  if ('code' in mount) {
    await registry.write({ namespace: ns, provider: 'structured', ttl: SCRATCH_TTL_SEC });
  }
}
