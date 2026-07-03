/**
 * AgentRegistry（Proto §3.1 Agent 定义管理）——AgentDefinition 管理面，D1 持久化。
 *
 * 库：watt-providers（binding DB_PROVIDERS），表 agent_definitions（migrations-providers/0002）。
 * 接口（§3.1 四动词）：
 * - list(opts)：§0.2 ListOptions/Page；limit 默认 50 钳 200；非法 filter 键 → invalid_argument。
 * - get(name)：不存在 → not_found（WattError）。
 * - write(def)：幂等 upsert（相同 name 覆盖）；agentDefinitionSchema 校验在路由层。
 * - update(name, patch)：patch 已有；目标不存在 → not_found。
 *
 * 声明式订阅联动（§2.3 规则 1 / §3.1 L334-338）：write 时把 definition.subscriptions[] 的每一项
 *   {match, instanceBy} 转成 EventRouter.subscribe({match, sink:{kind:'agent', definition, instanceBy}})。
 *   幂等：先拉现有订阅，按 (definition, match) 去重——重复 Write 不累积订阅（与 §2.3 规则 2 的
 *   (definition, session) 去重同源思路，此处以完整 match 去重）。订阅副作用经注入的 router stub 执行，
 *   便于测试断言（subscribeAgentSubscriptions 独立函数）。
 *
 * entry/model/grants/contextNamespaces/toolScopes/subscriptions 以 JSON 字符串存（复杂结构）。
 */

import type { D1Database } from '@cloudflare/workers-types';
import {
  type AgentDefinition,
  agentDefinitionSchema,
  type Subscription,
  type SubscriptionMatch,
} from '@watt/core';
import { type WattError, wattError } from '@watt/shared';

/** EventRouter subscribe 的最小 RPC 面（注入以便测试；真实由 EventRouter DO stub 满足）。 */

interface AgentDefinitionRow {
  name: string;
  description: string;
  runtime: string;
  entry_json: string;
  model_json: string | null;
  grants_json: string;
  context_namespaces_json: string;
  tool_scopes_json: string;
  subscriptions_json: string | null;
  created_at: string;
  updated_at: string;
}

function rowToDefinition(row: AgentDefinitionRow): AgentDefinition {
  const def: AgentDefinition = {
    name: row.name,
    description: row.description,
    runtime: row.runtime as AgentDefinition['runtime'],
    entry: JSON.parse(row.entry_json) as AgentDefinition['entry'],
    grants: JSON.parse(row.grants_json) as AgentDefinition['grants'],
    contextNamespaces: JSON.parse(row.context_namespaces_json) as string[],
    toolScopes: JSON.parse(row.tool_scopes_json) as string[],
  };
  if (row.model_json !== null) {
    def.model = JSON.parse(row.model_json) as AgentDefinition['model'];
  }
  if (row.subscriptions_json !== null) {
    def.subscriptions = JSON.parse(row.subscriptions_json) as AgentDefinition['subscriptions'];
  }
  return def;
}

/** Proto ListOptions（§0.2）。 */
export interface ListOptions {
  cursor?: string;
  limit?: number;
  filter?: Record<string, string>;
}

/** Proto Page<T>（§0.2）。cursor 分页延后（对齐 ToolRegistry，doc-gap #22）。 */
export interface Page<T> {
  items: T[];
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** AgentRegistry.List 未声明专门 filter（§3.1）；保守拒一切未知键（对齐 ToolRegistry）。 */
const ALLOWED_LIST_FILTER_KEYS = new Set<string>([]);

/** Update patch 校验：name 不可变、其余字段可选、拒未知键（strict）。 */
const agentDefinitionPatchSchema = agentDefinitionSchema.omit({ name: true }).partial().strict();

/** EventRouter subscribe 的最小 RPC 面（注入以便测试）。 */
export interface SubscriptionSink {
  subscribe(sub: Subscription): Promise<{ subscriptionId: string }>;
  listSubscriptions(opts?: { limit?: number }): Promise<{ items: Subscription[] }>;
}

/** 两个 match 是否等价（浅比较四字段；undefined 视为缺省）——订阅去重用。 */
function matchEquals(a: SubscriptionMatch, b: SubscriptionMatch): boolean {
  return (
    a.type === b.type &&
    a.sourceKind === b.sourceKind &&
    a.channel === b.channel &&
    a.session === b.session
  );
}

/**
 * 把 AgentDefinition.subscriptions[] 转 EventRouter 订阅（§2.3 规则 1 / §3.1）。
 * 幂等：按 (definition, match) 去重——已存在等价 agent 订阅则跳过（重复 Write 不累积）。
 * 独立导出便于路由层与测试直接调用。
 */
export async function subscribeAgentSubscriptions(
  def: AgentDefinition,
  router: SubscriptionSink,
): Promise<void> {
  const subs = def.subscriptions ?? [];
  if (subs.length === 0) return;
  const existing = await router.listSubscriptions({ limit: MAX_LIST_LIMIT });
  for (const decl of subs) {
    const dup = existing.items.some(
      (s) =>
        s.sink.kind === 'agent' &&
        s.sink.definition === def.name &&
        matchEquals(s.match, decl.match),
    );
    if (dup) continue;
    await router.subscribe({
      match: decl.match,
      sink: { kind: 'agent', definition: def.name, instanceBy: decl.instanceBy },
    });
  }
}

export class AgentRegistry {
  constructor(private readonly db: D1Database) {}

  /** List（§3.1 / §0.2）——返回 Page<AgentDefinition>，limit 默认 50 钳 200。 */
  async list(opts: ListOptions = {}): Promise<Page<AgentDefinition> | WattError> {
    const filter = opts.filter ?? {};
    for (const key of Object.keys(filter)) {
      if (!ALLOWED_LIST_FILTER_KEYS.has(key)) {
        return wattError('invalid_argument', `unknown filter key: ${key}`, false);
      }
    }
    const rawLimit = opts.limit ?? DEFAULT_LIST_LIMIT;
    const limit = Math.max(1, Math.min(rawLimit, MAX_LIST_LIMIT));
    const { results } = await this.db
      .prepare('SELECT * FROM agent_definitions ORDER BY created_at LIMIT ?')
      .bind(limit)
      .all<AgentDefinitionRow>();
    return { items: results.map(rowToDefinition) };
  }

  /** Get（§3.1 / §0.4）——不存在 → not_found（WattError）。 */
  async get(name: string): Promise<AgentDefinition | WattError> {
    const row = await this.db
      .prepare('SELECT * FROM agent_definitions WHERE name = ?')
      .bind(name)
      .first<AgentDefinitionRow>();
    if (row === null) {
      return wattError('not_found', `agent definition not found: ${name}`, false);
    }
    return rowToDefinition(row);
  }

  /**
   * Write（§0.4）——幂等 upsert（相同 name 覆盖）。
   * router 提供时联动 subscribeAgentSubscriptions（§2.3 规则 1）；缺省不建订阅（纯持久化）。
   */
  async write(
    def: AgentDefinition,
    router?: SubscriptionSink,
    now: string = new Date().toISOString(),
  ): Promise<AgentDefinition> {
    await this.db
      .prepare(
        `INSERT INTO agent_definitions
           (name, description, runtime, entry_json, model_json, grants_json,
            context_namespaces_json, tool_scopes_json, subscriptions_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           description = excluded.description,
           runtime = excluded.runtime,
           entry_json = excluded.entry_json,
           model_json = excluded.model_json,
           grants_json = excluded.grants_json,
           context_namespaces_json = excluded.context_namespaces_json,
           tool_scopes_json = excluded.tool_scopes_json,
           subscriptions_json = excluded.subscriptions_json,
           updated_at = excluded.updated_at`,
      )
      .bind(
        def.name,
        def.description,
        def.runtime,
        JSON.stringify(def.entry),
        def.model === undefined ? null : JSON.stringify(def.model),
        JSON.stringify(def.grants),
        JSON.stringify(def.contextNamespaces),
        JSON.stringify(def.toolScopes),
        def.subscriptions === undefined ? null : JSON.stringify(def.subscriptions),
        now,
        now,
      )
      .run();
    if (router !== undefined) {
      await subscribeAgentSubscriptions(def, router);
    }
    return def;
  }

  /**
   * Update（§0.4）——patch 已有；目标不存在 → not_found。
   * patch 经 strict schema 校验：name 不可变、未知键 → invalid_argument。
   * 若 patch 含 subscriptions 且 router 提供，联动新增订阅（去重）。
   */
  async update(
    name: string,
    patch: Partial<Omit<AgentDefinition, 'name'>>,
    router?: SubscriptionSink,
    now: string = new Date().toISOString(),
  ): Promise<AgentDefinition | WattError> {
    const parsed = agentDefinitionPatchSchema.safeParse(patch);
    if (!parsed.success) {
      return wattError(
        'invalid_argument',
        `invalid agent definition patch: ${parsed.error.message}`,
        false,
      );
    }
    const existing = await this.get(name);
    if ('code' in existing) {
      return existing; // not_found
    }
    const merged: AgentDefinition = { ...existing, ...parsed.data, name };
    await this.write(merged, router, now);
    return merged;
  }
}
