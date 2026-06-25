/**
 * runAgent：Agent Runtime 的 turn loop 入口。
 *
 * 执行形状（docs/flue-reference.md 已定案）：一次 AgentRun 的完整 loop 在单个
 * 调用内跑完，无跨 step 可重入状态机。
 *
 * loop：messages → 模型调用 → 解析 tool calls → 执行工具 → 工具结果 append 回
 * messages → 循环，直到 finish 校验通过 / give_up / 预算耗尽 / follow-up 超限。
 *
 * 不变量落地：
 * - 成本是一等公民：每次模型与工具调用累计 costUsd，结果给总账。
 * - 预算由确定性代码在每次调用前检查，BUDGET_EXCEEDED 不可被模型绕过。
 * - 工具白名单 ∩ toolScope 决定可用工具，越界调用被拒绝（回给模型纠正）。
 * - 平台无关：不 import 任何 Cloudflare API。
 */

import type { AgentSpec, ContextPackage } from '@watt/protocol';
import type {
  AssistantMessage,
  ChatMessage,
  FunctionToolDef,
  ModelClient,
  ToolCall,
  ToolResultMessage,
} from '@watt/model-deepseek';
import { BudgetExceededError, BudgetMeter } from './budget.js';
import { EventContext, EventEmitter, RUN_EVENTS, RunEventSink } from './events.js';
import {
  FINISH_TOOL,
  GIVE_UP_TOOL,
  makeFinishToolDef,
  makeGiveUpToolDef,
  validateOutput,
} from './finish.js';
import { allowedToolNames, type Tool } from './tools.js';

/** follow-up 催促上限（照抄 flue-reference 第 4 节）。超限走失败路径。 */
export const MAX_FOLLOW_UPS = 32;

/** runAgent 的失败码（与 protocol TypedError.code 对齐的稳定字符串）。 */
export type RunFailureCode =
  | 'GiveUp' // 模型显式投降
  | 'FollowUpExhausted' // 催促超限
  | 'BudgetExceeded' // 预算耗尽（透传 BUDGET_EXCEEDED）
  | 'ModelError'; // 模型层不可重试错误

export interface RunAgentParams {
  spec: AgentSpec;
  ctx: ContextPackage;
  /** 实现 ModelClient 接口（真实 DeepSeekClient 或测试 fake）。 */
  model: ModelClient;
  /** 业务工具（不含 finish / give_up，二者由 runtime 注入）。 */
  tools: Tool[];
  /** 事件发射器（窄接口）。 */
  emitter: EventEmitter;
  /** 事件标识与时钟。now 注入便于测试预算/墙钟。 */
  ids: EventContext;
}

/** runAgent 返回的结构化结果。 */
export interface AgentRunOutcome {
  status: 'ok' | 'failed';
  /** ok 时为过了 schema 校验的对象 */
  output?: unknown;
  /** failed 时的类型化错误 */
  error?: { code: RunFailureCode; message: string };
  /** 成本总账（USD）：所有模型与工具调用之和 */
  costUsd: number;
  /** 跑了多少 turn（模型调用次数） */
  turns: number;
}

/**
 * 组装 system prompt：静态前缀（职责 + 期望输出说明）。
 * objective 等易变内容不进 system，放到 user 消息（保护 prefix cache）。
 */
function buildSystemPrompt(spec: AgentSpec, ctx: ContextPackage): string {
  return [
    spec.instructions,
    '',
    '## 输出要求',
    ctx.expectedOutput,
    '',
    `完成任务后调用 \`${FINISH_TOOL}\` 工具提交结果，参数必须严格符合输出 schema。`,
    `若任务无法完成，调用 \`${GIVE_UP_TOOL}\` 工具并说明原因。`,
  ].join('\n');
}

/** 拆 model id："provider/model" → "model"（裸 id 给 DeepSeek）。 */
function bareModelId(id: string): string {
  const slash = id.indexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/** 解析 tool_call 的 JSON 实参；失败返回 undefined。 */
function parseArgs(call: ToolCall): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(call.function.arguments || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return undefined;
  }
}

/** 构造一条 tool 结果消息（内容统一 JSON 序列化）。 */
function toolMessage(callId: string, payload: unknown): ToolResultMessage {
  return {
    role: 'tool',
    tool_call_id: callId,
    content: typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
}

export async function runAgent(params: RunAgentParams): Promise<AgentRunOutcome> {
  const { spec, ctx, model, tools, emitter, ids } = params;

  const sink = new RunEventSink(emitter, ids);
  const meter = new BudgetMeter(ctx.budget, ids.now);

  // 可用业务工具：白名单 ∩ toolScope（确定性计算，不经模型）
  const allowedNames = allowedToolNames(spec, ctx);
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  // 注入工具定义：finish（参数即 outputSchema）+ give_up
  const finishDef = makeFinishToolDef(spec.outputSchema);
  const giveUpDef = makeGiveUpToolDef();
  // 仅暴露交集内的业务工具定义给模型
  const businessDefs: FunctionToolDef[] = tools
    .filter((t) => allowedNames.has(t.name))
    .map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  const toolDefs: FunctionToolDef[] = [finishDef, giveUpDef, ...businessDefs];

  const systemPrompt = buildSystemPrompt(spec, ctx);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: ctx.objective },
  ];

  const bareModel = bareModelId(spec.model.id);
  let turns = 0;
  let followUps = 0;

  await sink.emit(RUN_EVENTS.started, { objective: ctx.objective, model: spec.model.id });

  try {
    // loop 上限兜底：follow-up 上限 + 预算上限共同终止；额外硬上界防失控
    while (true) {
      // 预算检查在模型调用之前（确定性，不可绕过）
      meter.assertCanCallModel();

      turns += 1;
      const res = await model.chat({
        model: bareModel,
        messages,
        tools: toolDefs,
        toolChoice: 'auto',
        temperature: spec.model.temperature,
        maxTokens: spec.model.maxTokens,
      });
      meter.addModelCost(res.costUsd);
      await sink.emit(RUN_EVENTS.modelCalled, {
        costUsd: res.costUsd,
        turn: turns,
        usage: res.usage,
        finishReason: res.finishReason,
      });

      const assistant: AssistantMessage = res.message;
      messages.push(assistant);

      const calls = assistant.tool_calls ?? [];
      if (calls.length === 0) {
        // 模型没产出工具调用 → 催促一次
        const exhausted = await pushFollowUp(messages, ++followUps);
        if (exhausted) return failFollowUp(meter, turns, sink);
        continue;
      }

      // 处理本轮所有 tool_calls：finish / give_up 终止；其余回填后继续
      let terminated: AgentRunOutcome | undefined;
      let needFollowUp = false;

      for (const call of calls) {
        const name = call.function.name;
        const args = parseArgs(call);

        if (name === GIVE_UP_TOOL) {
          const reason =
            (args && typeof args.reason === 'string' && args.reason) || '模型未给出原因';
          terminated = await finishFailed(meter, turns, sink, {
            code: 'GiveUp',
            message: reason,
          });
          break;
        }

        if (name === FINISH_TOOL) {
          if (args === undefined) {
            messages.push(toolMessage(call.id, { error: 'finish 参数不是合法 JSON' }));
            needFollowUp = true;
            continue;
          }
          const outcome = validateOutput(spec.outputSchema, args);
          if (outcome.ok) {
            terminated = await finishOk(meter, turns, sink, outcome.output);
            break;
          }
          // 校验失败：把错误作为工具结果回给模型（follow-up 催促）
          messages.push(
            toolMessage(call.id, {
              error: 'output 不符合 schema',
              details: outcome.errors,
            }),
          );
          needFollowUp = true;
          continue;
        }

        // 业务工具：先查交集（越界拒绝，作为失败工具结果回传，不执行）
        if (!allowedNames.has(name)) {
          messages.push(
            toolMessage(call.id, {
              error: `工具 "${name}" 不在授权交集内，调用被拒绝`,
            }),
          );
          continue;
        }
        const tool = toolByName.get(name);
        if (!tool) {
          messages.push(
            toolMessage(call.id, { error: `工具 "${name}" 未注册` }),
          );
          continue;
        }
        if (args === undefined) {
          messages.push(toolMessage(call.id, { error: `工具 "${name}" 参数不是合法 JSON` }));
          continue;
        }

        // 预算检查在工具调用之前（确定性，不可绕过）
        meter.assertCanCallTool();
        const result = await tool.execute(args);
        meter.addToolCall(result.costUsd ?? 0);
        await sink.emit(RUN_EVENTS.toolCalled, {
          tool: name,
          costUsd: result.costUsd ?? 0,
          turn: turns,
        });
        messages.push(toolMessage(call.id, result.output));
      }

      if (terminated) return terminated;

      // 本轮出现了 finish 校验失败 / 无效 finish → 计一次催促
      if (needFollowUp) {
        followUps += 1;
        if (followUps > MAX_FOLLOW_UPS) return failFollowUp(meter, turns, sink);
      }
      // 否则（仅执行了业务工具）：带着工具结果进入下一轮，不计催促
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      const typed = err.toTypedError();
      await sink.emit(RUN_EVENTS.finished, {
        status: 'failed',
        costUsd: meter.spentUsd,
        turns,
        error: typed,
      });
      return {
        status: 'failed',
        error: { code: 'BudgetExceeded', message: typed.message },
        costUsd: meter.spentUsd,
        turns,
      };
    }
    // 模型层等其他错误：归类 ModelError
    const message = err instanceof Error ? err.message : String(err);
    await sink.emit(RUN_EVENTS.finished, {
      status: 'failed',
      costUsd: meter.spentUsd,
      turns,
      error: { code: 'ModelError', message },
    });
    return {
      status: 'failed',
      error: { code: 'ModelError', message },
      costUsd: meter.spentUsd,
      turns,
    };
  }
}

// ---- 终止路径辅助 ----

async function finishOk(
  meter: BudgetMeter,
  turns: number,
  sink: RunEventSink,
  output: unknown,
): Promise<AgentRunOutcome> {
  await sink.emit(RUN_EVENTS.finished, { status: 'ok', costUsd: meter.spentUsd, turns });
  return { status: 'ok', output, costUsd: meter.spentUsd, turns };
}

async function finishFailed(
  meter: BudgetMeter,
  turns: number,
  sink: RunEventSink,
  error: { code: RunFailureCode; message: string },
): Promise<AgentRunOutcome> {
  await sink.emit(RUN_EVENTS.finished, {
    status: 'failed',
    costUsd: meter.spentUsd,
    turns,
    error,
  });
  return { status: 'failed', error, costUsd: meter.spentUsd, turns };
}

async function failFollowUp(
  meter: BudgetMeter,
  turns: number,
  sink: RunEventSink,
): Promise<AgentRunOutcome> {
  return finishFailed(meter, turns, sink, {
    code: 'FollowUpExhausted',
    message: `follow-up 催促超过上限 ${MAX_FOLLOW_UPS} 次仍未产出合规结果`,
  });
}

/**
 * 追加 follow-up 催促消息，返回是否已超限。
 * 催促文本是静态的，不含易变内容（保护 prefix cache）。
 */
async function pushFollowUp(messages: ChatMessage[], followUpCount: number): Promise<boolean> {
  if (followUpCount > MAX_FOLLOW_UPS) return true;
  messages.push({
    role: 'user',
    content: `你尚未提交合规结果。请调用 ${FINISH_TOOL} 工具提交符合 schema 的输出，或调用 ${GIVE_UP_TOOL} 说明无法完成的原因。`,
  });
  return false;
}
