import { describe, expect, it } from 'vitest';
import type { AgentSpec, ContextPackage, RunEvent } from '@watt/protocol';
import type {
  ChatRequest,
  ModelClient,
  NormalizedChatResponse,
  ToolCall,
} from '@watt/model-deepseek';
import {
  RUN_EVENTS,
  runAgent,
  type EventEmitter,
  type Tool,
} from '../src/index.js';

// ---- 测试辅助 ----

/** 构造一条 finish/give_up/业务工具调用的助手响应（带 costUsd）。 */
function toolCallResponse(
  calls: Array<{ name: string; args: unknown; id?: string }>,
  costUsd = 0.001,
): NormalizedChatResponse {
  const tool_calls: ToolCall[] = calls.map((c, i) => ({
    id: c.id ?? `call_${i}`,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.args) },
  }));
  return {
    model: 'deepseek-chat',
    message: { role: 'assistant', content: null, tool_calls },
    finishReason: 'tool_calls',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheHitTokens: 0,
      cacheMissTokens: 10,
      totalTokens: 15,
    },
    costUsd,
  };
}

/** 纯文本响应（无 tool_calls）。 */
function textResponse(text: string, costUsd = 0.001): NormalizedChatResponse {
  return {
    model: 'deepseek-chat',
    message: { role: 'assistant', content: text },
    finishReason: 'stop',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheHitTokens: 0,
      cacheMissTokens: 10,
      totalTokens: 15,
    },
    costUsd,
  };
}

/** 脚本化 fake model：按调用次序返回预设响应序列。 */
class FakeModel implements ModelClient {
  calls = 0;
  readonly requests: ChatRequest[] = [];
  constructor(
    private readonly script:
      | NormalizedChatResponse[]
      | ((turn: number, req: ChatRequest) => NormalizedChatResponse),
  ) {}
  async chat(request: ChatRequest): Promise<NormalizedChatResponse> {
    this.requests.push(request);
    const turn = this.calls++;
    if (typeof this.script === 'function') return this.script(turn, request);
    const res = this.script[turn];
    if (!res) throw new Error(`fake model script exhausted at turn ${turn}`);
    return res;
  }
}

/** 收集事件的 emitter。 */
class CollectingEmitter implements EventEmitter {
  readonly events: RunEvent[] = [];
  emit(event: RunEvent): void {
    this.events.push(event);
  }
}

const VALID_WORKSPACE = 'ws_01KTX5FHN825SCPY4X18SA18R7';
const VALID_RUN = 'run_01KTX5FHN825SCPY4X18SA18R7_01KTX5FHN825SCPY4X18SA18R8';

function makeIds(now: () => number = () => 1_000) {
  return { workspaceId: VALID_WORKSPACE, runId: VALID_RUN, now };
}

/** 基础 AgentSpec：outputSchema 要求 { summary: string } 必填。 */
function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    instructions: '你是调研 Agent，负责收集并总结资料。',
    outputSchema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
      additionalProperties: false,
    },
    tools: [{ tool: 'web_search' }],
    model: { id: 'deepseek/deepseek-chat', temperature: 0.7 },
    runtime: 'worker',
    lifecycle: 'ephemeral',
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ContextPackage> = {}): ContextPackage {
  return {
    objective: '调研 QuickJS gas 计量',
    inputs: [],
    budget: { maxCostUsd: 1, maxWallClockMs: 600_000, maxToolCalls: 10 },
    expectedOutput: '一句话摘要',
    permissions: { contextScope: [] },
    ...overrides,
  };
}

// ---- 测试 1：finish follow-up 催促后合规 ----

describe('finish / follow-up', () => {
  it('第一次 finish 不合 schema → 催促 → 第二次合规 → ok', async () => {
    const model = new FakeModel([
      // 第 1 轮：finish 缺 summary（不合 schema）
      toolCallResponse([{ name: 'finish', args: { wrong: 1 } }]),
      // 第 2 轮：finish 合规
      toolCallResponse([{ name: 'finish', args: { summary: '结论是 X' } }]),
    ]);
    const emitter = new CollectingEmitter();
    const out = await runAgent({
      spec: makeSpec(),
      ctx: makeCtx(),
      model,
      tools: [],
      emitter,
      ids: makeIds(),
    });
    expect(out.status).toBe('ok');
    expect(out.output).toEqual({ summary: '结论是 X' });
    expect(out.turns).toBe(2);
    expect(model.calls).toBe(2);
    // 第 2 次请求 messages 里应回填了第一次 finish 校验失败的 tool 结果
    const secondReq = model.requests[1]!;
    const toolMsgs = secondReq.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(toolMsgs)).toContain('不符合 schema');
    // 事件：started + 2x model.called + finished
    const types = emitter.events.map((e) => e.type);
    expect(types[0]).toBe(RUN_EVENTS.started);
    expect(types.filter((t) => t === RUN_EVENTS.modelCalled)).toHaveLength(2);
    expect(types.at(-1)).toBe(RUN_EVENTS.finished);
    // 成本累计
    expect(out.costUsd).toBeCloseTo(0.002, 9);
  });

  it('模型只回文本（无 tool_calls）也触发 follow-up 催促', async () => {
    const model = new FakeModel([
      textResponse('我想一下……'),
      toolCallResponse([{ name: 'finish', args: { summary: 'ok' } }]),
    ]);
    const out = await runAgent({
      spec: makeSpec(),
      ctx: makeCtx(),
      model,
      tools: [],
      emitter: new CollectingEmitter(),
      ids: makeIds(),
    });
    expect(out.status).toBe('ok');
    expect(out.turns).toBe(2);
    // 第二次请求里应有催促 user 消息
    const lastUser = model.requests[1]!.messages.filter((m) => m.role === 'user');
    expect(JSON.stringify(lastUser)).toContain('尚未提交合规结果');
  });
});

// ---- 测试 2：give_up ----

describe('give_up', () => {
  it('模型投降 → failed + 带原因的 TypedError', async () => {
    const model = new FakeModel([
      toolCallResponse([{ name: 'give_up', args: { reason: '资料不足无法完成' } }]),
    ]);
    const emitter = new CollectingEmitter();
    const out = await runAgent({
      spec: makeSpec(),
      ctx: makeCtx(),
      model,
      tools: [],
      emitter,
      ids: makeIds(),
    });
    expect(out.status).toBe('failed');
    expect(out.error).toEqual({ code: 'GiveUp', message: '资料不足无法完成' });
    expect(out.turns).toBe(1);
    const finished = emitter.events.at(-1)!;
    expect(finished.type).toBe(RUN_EVENTS.finished);
    expect(finished.payload).toMatchObject({ status: 'failed' });
  });
});

// ---- 测试 3：预算中止 ----

describe('预算三限', () => {
  it('maxToolCalls 耗尽 → budget exceeded', async () => {
    // 每轮都调用业务工具 search；maxToolCalls=2，第 3 次工具调用前应中止
    const model = new FakeModel(() =>
      toolCallResponse([{ name: 'web_search', args: { q: 'x' } }]),
    );
    const tool: Tool = {
      name: 'web_search',
      parameters: { type: 'object' },
      execute: () => ({ output: { hits: [] }, costUsd: 0 }),
    };
    const out = await runAgent({
      spec: makeSpec(),
      ctx: makeCtx({ budget: { maxCostUsd: 100, maxWallClockMs: 600_000, maxToolCalls: 2 } }),
      model,
      tools: [tool],
      emitter: new CollectingEmitter(),
      ids: makeIds(),
    });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('BudgetExceeded');
    expect(out.error?.message).toContain('maxToolCalls');
  });

  it('maxCostUsd 超限 → budget exceeded（模型调用前检查）', async () => {
    // 每次模型调用 0.6 USD，maxCostUsd=1：第 2 次模型调用前累计 0.6 < 1 仍放行，
    // 第 3 次前累计 1.2 >= 1 中止
    const model = new FakeModel(() => toolCallResponse([{ name: 'finish', args: { bad: 1 } }], 0.6));
    const out = await runAgent({
      spec: makeSpec(),
      ctx: makeCtx({ budget: { maxCostUsd: 1, maxWallClockMs: 600_000, maxToolCalls: 10 } }),
      model,
      tools: [],
      emitter: new CollectingEmitter(),
      ids: makeIds(),
    });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('BudgetExceeded');
    expect(out.error?.message).toContain('maxCostUsd');
  });

  it('maxWallClockMs 超限 → budget exceeded', async () => {
    // 时钟每次读取 +1000ms；maxWallClockMs=1500：第 2 次模型调用前已超
    let t = 0;
    const now = () => {
      const v = t;
      t += 1000;
      return v;
    };
    const model = new FakeModel(() => toolCallResponse([{ name: 'finish', args: { bad: 1 } }]));
    const out = await runAgent({
      spec: makeSpec(),
      ctx: makeCtx({ budget: { maxCostUsd: 100, maxWallClockMs: 1500, maxToolCalls: 10 } }),
      model,
      tools: [],
      emitter: new CollectingEmitter(),
      ids: { workspaceId: VALID_WORKSPACE, runId: VALID_RUN, now },
    });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('BudgetExceeded');
    expect(out.error?.message).toContain('maxWallClockMs');
  });
});

// ---- 测试 4：工具白名单交集 ----

describe('工具白名单 ∩ toolScope', () => {
  it('调用不在交集内的工具 → 拒绝并作为失败工具结果回传，下一轮可纠正', async () => {
    // toolScope 把可用工具收窄为 []（web_search 被排除）
    const model = new FakeModel([
      // 第 1 轮：调用越界工具 web_search
      toolCallResponse([{ name: 'web_search', args: { q: 'x' } }]),
      // 第 2 轮：纠正为 finish
      toolCallResponse([{ name: 'finish', args: { summary: '纠正后完成' } }]),
    ]);
    let executed = false;
    const tool: Tool = {
      name: 'web_search',
      parameters: { type: 'object' },
      execute: () => {
        executed = true;
        return { output: {}, costUsd: 0 };
      },
    };
    const out = await runAgent({
      spec: makeSpec(),
      ctx: makeCtx({ permissions: { contextScope: [], toolScope: [] } }),
      model,
      tools: [tool],
      emitter: new CollectingEmitter(),
      ids: makeIds(),
    });
    expect(out.status).toBe('ok');
    expect(out.output).toEqual({ summary: '纠正后完成' });
    // 工具未被执行（越界拒绝）
    expect(executed).toBe(false);
    // 第二轮请求里有拒绝的 tool 结果
    const toolMsgs = model.requests[1]!.messages.filter((m) => m.role === 'tool');
    expect(JSON.stringify(toolMsgs)).toContain('不在授权交集内');
    // 越界工具定义不应暴露给模型（businessDefs 只含交集内工具）
    const firstReqToolNames = (model.requests[0]!.tools ?? []).map((t) => t.function.name);
    expect(firstReqToolNames).not.toContain('web_search');
    expect(firstReqToolNames).toContain('finish');
    expect(firstReqToolNames).toContain('give_up');
  });

  it('toolScope 缺省时白名单全集可用', async () => {
    const model = new FakeModel([
      toolCallResponse([{ name: 'web_search', args: { q: 'x' } }]),
      toolCallResponse([{ name: 'finish', args: { summary: '完成' } }]),
    ]);
    let executed = false;
    const tool: Tool = {
      name: 'web_search',
      parameters: { type: 'object' },
      execute: () => {
        executed = true;
        return { output: { hits: 1 } };
      },
    };
    const out = await runAgent({
      spec: makeSpec(),
      ctx: makeCtx(), // 无 toolScope
      model,
      tools: [tool],
      emitter: new CollectingEmitter(),
      ids: makeIds(),
    });
    expect(out.status).toBe('ok');
    expect(executed).toBe(true);
  });
});

// ---- 测试 5：follow-up 32 次上限 ----

describe('follow-up 上限', () => {
  it('超过 32 次催促 → FollowUpExhausted 失败', async () => {
    // 每轮都给不合 schema 的 finish，永远触发催促
    const model = new FakeModel(() =>
      toolCallResponse([{ name: 'finish', args: { wrong: true } }], 0),
    );
    const out = await runAgent({
      spec: makeSpec(),
      ctx: makeCtx({ budget: { maxCostUsd: 1000, maxWallClockMs: 10_000_000, maxToolCalls: 1000 } }),
      model,
      tools: [],
      emitter: new CollectingEmitter(),
      ids: makeIds(),
    });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('FollowUpExhausted');
    // 催促上限 32：第 33 次催促触发失败，模型被调用 33 次
    expect(model.calls).toBe(33);
  });
});
