/**
 * finish / give_up 注入工具（机制照抄 docs/flue-reference.md 第 4 节）。
 *
 * - finish：参数即 AgentSpec.outputSchema；schema 校验在工具 execute 内进行
 *   （用 @cfworker/json-schema，Workers 兼容、无 eval）。校验通过才终止循环；
 *   校验失败把错误作为工具结果回给模型继续（follow-up 催促）。
 * - give_up：模型显式投降，带原因，AgentRun 以 failed 结束。
 *
 * 结果要么过 schema 校验，要么显式失败，不存在"模型自述完成"的模糊地带。
 */

import { Validator } from '@cfworker/json-schema';
import type { JsonSchema } from '@watt/protocol';
import type { FunctionToolDef } from '@watt/model-deepseek';

/** 注入工具名（保留名，不得与 AgentSpec.tools 冲突）。 */
export const FINISH_TOOL = 'finish' as const;
export const GIVE_UP_TOOL = 'give_up' as const;

/** finish 校验结果：通过则 output 为合规对象；失败则带错误明细。 */
export type FinishOutcome =
  | { ok: true; output: unknown }
  | { ok: false; errors: string[] };

/**
 * 用 outputSchema 校验候选输出（@cfworker/json-schema，draft 2020-12）。
 * 校验在确定性代码里跑，无 eval、Workers 兼容。
 */
export function validateOutput(outputSchema: JsonSchema, candidate: unknown): FinishOutcome {
  // @cfworker 的 Schema 类型比 protocol 的 JsonSchema(record) 宽，安全转换
  const validator = new Validator(outputSchema as Record<string, unknown>, '2020-12');
  const result = validator.validate(candidate);
  if (result.valid) return { ok: true, output: candidate };
  const errors = result.errors.map(
    (e) => `${e.instanceLocation || '/'}: ${e.error} (${e.keyword})`,
  );
  return { ok: false, errors: errors.length ? errors : ['output failed schema validation'] };
}

/**
 * 生成 finish 工具定义（OpenAI 兼容 function tool）。
 * 参数 schema 直接用 outputSchema：模型按目标输出形状调用 finish。
 */
export function makeFinishToolDef(outputSchema: JsonSchema): FunctionToolDef {
  return {
    type: 'function',
    function: {
      name: FINISH_TOOL,
      description:
        '提交最终结果。参数必须严格符合输出 schema；校验通过才结束本次 AgentRun。',
      parameters: outputSchema as Record<string, unknown>,
    },
  };
}

/** 生成 give_up 工具定义：模型在无法完成时显式投降并给出原因。 */
export function makeGiveUpToolDef(): FunctionToolDef {
  return {
    type: 'function',
    function: {
      name: GIVE_UP_TOOL,
      description: '当任务无法完成时显式投降，必须给出原因。调用后本次 AgentRun 失败。',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '无法完成的原因' },
        },
        required: ['reason'],
        additionalProperties: false,
      },
    },
  };
}
