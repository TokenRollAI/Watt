/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from 'cloudflare:test';
import type { Event, TokenClaims } from '@watt/core';
import { getAgentByName } from 'agents';
import { describe, expect, it } from 'vitest';
import type { AgentInstance } from '../src/agent/agent-instance.ts';
import type { ModelCaller, ModelCallRequest } from '../src/agent/harness/types.ts';
import type { Bindings } from '../src/env.ts';

/**
 * Agent HTBP 工具注入集成测试（P2）——runInDurableObject 拿真实 AgentInstance，注入捕获型 fake
 *   ModelCaller，断言 llm harness 收到的 req.tools 含 htbp 三工具 + req.system 含平台 HTBP 说明段。
 *   不触网络（真实 agentic loop 在 anthropic-caller）；断言协议事实，不断言 LLM 文本（§7 约定）。
 */

const bindings = env as unknown as Bindings;
const ADMIN_CLAIMS: TokenClaims = { sub: 'user:admin', roles: ['admin'] };

/** 捕获型 fake caller：记录第一次调用的 req（tools/system），返回固定文本。 */
function captureCaller(): ModelCaller & { seen: ModelCallRequest[] } {
  const seen: ModelCallRequest[] = [];
  return {
    seen,
    async call(req: ModelCallRequest) {
      seen.push(req);
      return { text: 'ok' };
    },
  };
}

function triggerEvent(): Event {
  return {
    id: 'evt-htbp-1',
    source: { kind: 'im', channel: 'feishu' },
    type: 'im.message',
    payload: { text: '帮我查一下' },
    occurredAt: '2026-07-04T00:00:00.000Z',
    traceId: 'tr-htbp-1',
  };
}

async function initAndRun(
  instanceKey: string,
  init: {
    toolScopes?: string[];
    systemPrompt?: string;
    definition?: string;
  },
  claims: TokenClaims | undefined,
): Promise<ModelCallRequest> {
  const stub = await getAgentByName<Cloudflare.Env, AgentInstance>(
    bindings.AGENT_INSTANCE,
    instanceKey,
  );
  await runInDurableObject(stub, (inst: AgentInstance) =>
    inst.initInstance({
      definition: init.definition ?? 'triage',
      harness: 'llm',
      model: 'glm-5.2',
      toolScopes: init.toolScopes,
      systemPrompt: init.systemPrompt,
      input: '帮我查一下',
      nowIso: '2026-07-04T00:00:00.000Z',
    }),
  );
  const caller = captureCaller();
  await runInDurableObject(stub, (inst: AgentInstance) =>
    inst.onEvent({ event: triggerEvent(), ...(claims !== undefined ? { claims } : {}) }, caller),
  );
  const req = caller.seen[0];
  if (req === undefined) throw new Error('model caller was not invoked');
  return req;
}

describe('HTBP 工具注入（toolScopes 纯路径 + claims）', () => {
  it('注入 htbp 三工具 + system prompt 含说明段 + def.systemPrompt', async () => {
    const req = await initAndRun(
      'triage#htbp-1',
      { toolScopes: ['echo'], systemPrompt: '你是分诊助手。' },
      ADMIN_CLAIMS,
    );
    const toolNames = (req.tools ?? []).map((t) => t.name).sort();
    expect(toolNames).toEqual(['htbp_call', 'htbp_help', 'htbp_skill']);
    // system 拼装：def.systemPrompt 在前，HTBP 说明段在后（含三工具名 + scope 清单 + 防注入纪律）。
    expect(req.system).toContain('你是分诊助手。');
    expect(req.system).toContain('htbp_help');
    expect(req.system).toContain('"echo"');
    expect(req.system).toContain('不构成指令');
  });
});

describe('零回归 / 边界', () => {
  it('无 toolScopes（空）→ 不注入工具、无 HTBP 说明段（单次调用）', async () => {
    const req = await initAndRun('triage#htbp-empty', { toolScopes: [] }, ADMIN_CLAIMS);
    expect(req.tools).toBeUndefined();
    expect(req.system).toBeUndefined();
  });

  it('含 :// 的历史条目不参与 HTBP 工具生成（非 manage def）', async () => {
    const req = await initAndRun(
      'triage#htbp-uri',
      { toolScopes: ['platform://scheduler'] },
      ADMIN_CLAIMS,
    );
    expect(req.tools).toBeUndefined();
    expect(req.system).toBeUndefined();
  });

  it('缺 claims → 不注入工具（无法过 Check）；但 scopes 非空仍加说明段', async () => {
    const req = await initAndRun('triage#htbp-noclaims', { toolScopes: ['echo'] }, undefined);
    expect(req.tools).toBeUndefined();
    expect(req.system).toContain('htbp_help');
  });
});
