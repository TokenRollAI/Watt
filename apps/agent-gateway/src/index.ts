/**
 * Watt Agent Gateway —— 直连会话路径的最小可部署 Worker。
 *
 * 串起三个平台无关库：
 * - @watt/protocol：AgentSpec / ContextPackage / RunEvent 契约（仅类型）。
 * - @watt/model-deepseek：DeepSeek 薄客户端（OpenAI 兼容，非流式）。
 * - @watt/runtime-core：Agent Runtime 的 turn loop（runAgent）。
 *
 * 符合架构「决策 4」的会话路径变体：模型调用发生在**无状态 Worker 的请求
 * 上下文**里——Workers 按 CPU 计费，await 模型期间墙钟等待近乎免费，不占用
 * Durable Object、不破坏「DO 绝不 await 模型调用」。本 Worker 单轮请求-响应
 * （V1 不做流式、不做历史持久化），是「功能可用性」的最小真实证明。
 */

import { DeepSeekClient } from '@watt/model-deepseek';
import { runAgent, type RunAgentParams } from '@watt/runtime-core';
import type { AgentSpec, ContextPackage, RunEvent } from '@watt/protocol';

interface Env {
  /** DeepSeek API key（secret，`wrangler secret put DEEPSEEK_API_KEY`）。 */
  DEEPSEEK_API_KEY: string;
  /** API base URL（vars，默认官方端点）。 */
  DEEPSEEK_BASE_URL?: string;
  /** model specifier "provider/model"（vars）。 */
  MODEL_ID?: string;
}

const DEFAULT_MODEL = 'deepseek/deepseek-chat';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // 健康检查 + 自描述
    if (req.method === 'GET' && url.pathname === '/') {
      return json({
        name: 'watt-agent-gateway',
        ok: true,
        model: env.MODEL_ID ?? DEFAULT_MODEL,
        endpoints: {
          'POST /v1/chat':
            'body { message, instructions?, expectedOutput?, maxCostUsd? } → 跑一次 AgentRun，返回 { status, reply, usage, events }',
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat') {
      return handleChat(req, env);
    }

    return json({ error: 'not_found', path: url.pathname }, 404);
  },
};

interface ChatBody {
  message?: string;
  instructions?: string;
  expectedOutput?: string;
  maxCostUsd?: number;
}

async function handleChat(req: Request, env: Env): Promise<Response> {
  if (!env.DEEPSEEK_API_KEY) {
    return json({ error: 'missing_secret', message: 'DEEPSEEK_API_KEY 未配置' }, 500);
  }

  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return json({ error: 'bad_json', message: '请求体不是合法 JSON' }, 400);
  }

  const message = body.message?.trim();
  if (!message) {
    return json({ error: 'missing_field', message: 'message 必填' }, 400);
  }

  const modelId = env.MODEL_ID ?? DEFAULT_MODEL;

  // AgentSpec：一个通用对话 Agent。输出契约要求模型经注入的 finish 工具
  // 提交 { reply }，schema 校验通过才算完成（机械验证的 schema 层）。
  const spec: AgentSpec = {
    instructions:
      body.instructions ??
      '你是 Watt 平台上的一个通用助理 Agent。请简洁、准确地回答用户的问题。',
    outputSchema: {
      type: 'object',
      properties: {
        reply: { type: 'string', description: '给用户的最终回复（自然语言）' },
      },
      required: ['reply'],
      additionalProperties: false,
    },
    tools: [],
    model: { id: modelId, temperature: 0.7 },
    runtime: 'worker',
    lifecycle: 'ephemeral',
  };

  // ContextPackage：objective 即用户消息；无外部输入引用；预算兜底。
  const ctx: ContextPackage = {
    objective: message,
    inputs: [],
    budget: {
      maxCostUsd: body.maxCostUsd ?? 0.05,
      maxWallClockMs: 60_000,
      maxToolCalls: 4,
    },
    expectedOutput:
      body.expectedOutput ??
      '用 reply 字段返回给用户的自然语言答复，使用与用户相同的语言。',
    permissions: { contextScope: [] },
  };

  const model = new DeepSeekClient({
    apiKey: env.DEEPSEEK_API_KEY,
    baseUrl: env.DEEPSEEK_BASE_URL,
  });

  // 收集 run 事件用于审计（成本是一等公民——事件流也带 costUsd）。
  const events: RunEvent[] = [];
  const params: RunAgentParams = {
    spec,
    ctx,
    model,
    tools: [],
    emitter: {
      emit: (event) => {
        events.push(event);
      },
    },
    ids: {
      workspaceId: 'ws_local',
      runId: 'run_gateway',
      now: () => Date.now(),
    },
  };

  const startedAt = Date.now();
  const outcome = await runAgent(params);
  const wallMs = Date.now() - startedAt;

  const reply =
    outcome.status === 'ok' && outcome.output && typeof outcome.output === 'object'
      ? (outcome.output as { reply?: unknown }).reply
      : undefined;

  return json({
    status: outcome.status,
    reply: typeof reply === 'string' ? reply : undefined,
    output: outcome.output,
    error: outcome.error,
    usage: { costUsd: outcome.costUsd, turns: outcome.turns, wallMs },
    events: events.map((e) => ({ type: e.type, payload: e.payload })),
  });
}
