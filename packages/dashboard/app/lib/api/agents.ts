/**
 * agents domain wrappers（视图族 B：Agents 全动词 + manage 对话）。
 *
 * 请求形状真源：packages/cli/src/agent.ts（htbpCall 调用点）+ gateway 路由测试
 * （packages/gateway/test/platform-agent.test.ts）。禁自创形状、禁双形态兜底解析（§34）。
 * 动词映射（CLI 动词 → AgentRegistry/AgentRuntime tool）：
 *  - list       → List          {opts:{}}                                → 裸 Page{items}（AgentDefinition）
 *  - get        → Get           {name}                                   → { definition }（含 grants/toolScopes/systemPrompt）
 *  - instances  → ListInstances {opts:{}}                               → 裸 Page{items}（AgentInstanceInfo，全列）
 *  - tree       → ListInstances {opts:{tree:instanceId}}                → 裸 Page{items}（某实例派生子树）
 *  - spawn      → Spawn         {request:{definition,instanceKey?,input?,ttl?,expect?}} → { instance, correlationId? }
 *  - send       → Send          {instanceId,event,expect?}              → { accepted, correlationId? }
 *  - terminate  → Terminate     {instanceId,cascade}                    → { terminated:true }
 *
 * manage 对话：Spawn(manage/*) 拿 instanceId → Send(agent.message + expect) → 轮询 event List
 * {filter:{correlationId}} 取 agent.result/agent.failed（correlationId filter 真源
 * packages/gateway/src/event/event-store.ts ALLOWED_LIST_FILTER_KEYS）。
 */

import { htbp } from './core.ts';
import type { Page } from './types.ts';

/** §3.1 grant：resources（uri 列表）+ actions。 */
export interface AgentGrant {
  resources: string[];
  actions: string[];
}

/** AgentDefinition 完整读投影（Get 展示：runtime/model/grants/toolScopes/systemPrompt）。 */
export interface AgentDefinitionDetail {
  name: string;
  description: string;
  runtime: string;
  model?: { preferred: string; fallback?: string[] };
  grants: AgentGrant[];
  contextNamespaces: string[];
  toolScopes: string[];
  systemPrompt?: string;
  entry?: { kind: string; [k: string]: unknown };
  [k: string]: unknown;
}

/** AgentInstanceInfo（§3.2）——ListInstances/tree 展示。state 四态：idle|running|waiting|terminated。 */
export interface AgentInstanceDetail {
  instanceId: string;
  definition: string;
  state: string;
  parent?: string;
  children: string[];
  createdAt: string;
  lastActiveAt: string;
}

/** Spawn 请求（§3.2 SpawnRequest）。 */
export interface SpawnRequest {
  definition: string;
  instanceKey?: string;
  input?: unknown;
  ttl?: number;
  expect?: { correlationId?: string; timeoutMs?: number; schema?: unknown };
}

/** Send/Spawn 的定向回执约定（§3.4）。 */
export interface AgentExpect {
  correlationId?: string;
  timeoutMs?: number;
  schema?: unknown;
}

/**
 * manage 对话轮询到的结果事件（EventStore.List 投影，只取对话所需字段）。
 * agent.result → payload.output 是模型回复；agent.failed → payload.reason 是错误原因。
 */
export interface ManageResultEvent {
  id: string;
  type: string;
  occurredAt: string;
  payload?: {
    correlationId?: string;
    output?: unknown;
    reason?: string;
    [k: string]: unknown;
  };
}

export const agentsApi = {
  // AgentRegistry.List → 裸 Page{items}（AgentDefinition，含全部字段）。
  listAgentDefs: () => htbp<Page<AgentDefinitionDetail>>('agent', 'List', { opts: {} }),
  // AgentRegistry.Get → { definition }（单形态，精确解包）。
  getAgentDef: (name: string) =>
    htbp<{ definition: AgentDefinitionDetail }>('agent', 'Get', { name }),
  // AgentRuntime.ListInstances 全列（opts 不带 tree——tree=<id> 是「该实例的派生子树」）。
  listAgentInstances: () => htbp<Page<AgentInstanceDetail>>('agent', 'ListInstances', { opts: {} }),
  // AgentRuntime.ListInstances{tree:instanceId} → 某实例派生子树（含自身）。
  listAgentSubtree: (instanceId: string) =>
    htbp<Page<AgentInstanceDetail>>('agent', 'ListInstances', { opts: { tree: instanceId } }),
  // AgentRuntime.Spawn → { instance, correlationId? }。
  spawnAgent: (request: SpawnRequest) =>
    htbp<{ instance: AgentInstanceDetail; correlationId?: string }>('agent', 'Spawn', { request }),
  // AgentRuntime.Send → { accepted, correlationId? }（expect 带 correlationId 时注册定向回执）。
  sendAgent: (instanceId: string, event: Record<string, unknown>, expect?: AgentExpect) =>
    htbp<{ accepted: boolean; correlationId?: string }>(
      'agent',
      'Send',
      expect !== undefined ? { instanceId, event, expect } : { instanceId, event },
    ),
  // AgentRuntime.Terminate → { terminated:true }（cascade 连带子树）。
  terminateAgent: (instanceId: string, cascade: boolean) =>
    htbp<{ terminated: boolean }>('agent', 'Terminate', { instanceId, cascade }),
  // manage 对话取回复：EventStore.List{filter:{correlationId}}（correlationId filter 真源
  //   event-store.ts ALLOWED_LIST_FILTER_KEYS）——匹配 agent.result/agent.failed 的定向回送载荷。
  pollCorrelation: (correlationId: string, limit = 10) =>
    htbp<Page<ManageResultEvent>>('event', 'List', {
      opts: { filter: { correlationId }, limit },
    }),
};

/**
 * 生成合法 correlationId（字符集 [A-Za-z0-9_-]、长度 ≤80）——manage 对话每次 Send 一个新 cid。
 * randomUUID 去掉连字符得 32 位十六进制，稳落白名单。
 */
export function newCorrelationId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}
