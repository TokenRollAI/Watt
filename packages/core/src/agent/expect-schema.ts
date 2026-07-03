import { type WattError, wattError } from '@watt/shared';
import type { AgentFailedPayload } from './types.ts';

/**
 * ExpectSpec.schema 校验 + 重试策略（Proto §3.2 L374-382 / §3.4）——无 I/O。
 *
 * 平台在回送 agent.result 前用 ExpectSpec.schema（JSON Schema）校验 output；不符 → 携带
 * 校验错误退回子实例重试最多 N 次，仍失败 → agent.failed(reason='invalid_output')。
 *
 * JSON Schema 校验选型（实现声明）：zod 4.x 有 z.toJSONSchema（zod→JSON Schema）但无可靠的
 *   反向 from-json-schema（fromJSONSchema 非稳定 API）。为不引新依赖，此处实现 JSON Schema
 *   最小子集校验器，支持五关键字：type / properties / required / items / enum。
 *   子集范围（不支持）：$ref、allOf/anyOf/oneOf、format、pattern、min/max、additionalProperties
 *   的布尔外形态、number/integer 的区分（integer 按 number 校验）。超出子集的关键字被忽略
 *   （宽松：不因未知关键字判失败）——够用于 fan-in 结构化结果的形状约束。
 */

// 支持校验的 JSON Schema type 关键字取值。
type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

interface JsonSchemaNode {
  type?: JsonSchemaType;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  enum?: unknown[];
}

/** 校验失败详情：JSON Pointer 风格路径 + 原因（携带回子实例的重试提示）。 */
export interface SchemaViolation {
  path: string; // "" 为根，"/a/0/b" 为嵌套
  message: string;
}

/** JSON Schema 子集校验结果。 */
export type ValidateOutcome = { valid: true } | { valid: false; violations: SchemaViolation[] };

function typeOf(value: unknown): JsonSchemaType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') return 'number';
  if (t === 'string') return 'string';
  if (t === 'boolean') return 'boolean';
  return 'object';
}

/** type 是否匹配（integer 要求 number 且为整数；number 接受任意数值）。 */
function typeMatches(expected: JsonSchemaType, value: unknown): boolean {
  if (expected === 'integer') {
    return typeof value === 'number' && Number.isInteger(value);
  }
  return typeOf(value) === expected;
}

function validateNode(value: unknown, schema: JsonSchemaNode, path: string): SchemaViolation[] {
  const violations: SchemaViolation[] = [];

  if (schema.type !== undefined && !typeMatches(schema.type, value)) {
    violations.push({ path, message: `expected type '${schema.type}', got '${typeOf(value)}'` });
    // type 不符时不再深入 properties/items（形状已错，避免噪声级联报错）。
    return violations;
  }

  if (schema.enum !== undefined) {
    const inEnum = schema.enum.some((e) => e === value);
    if (!inEnum) {
      violations.push({ path, message: `value not in enum ${JSON.stringify(schema.enum)}` });
    }
  }

  if (schema.type === 'object' && typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) {
        violations.push({ path: `${path}/${req}`, message: `missing required property '${req}'` });
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) {
        violations.push(...validateNode(obj[key], sub, `${path}/${key}`));
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, i) => {
      violations.push(...validateNode(item, schema.items as JsonSchemaNode, `${path}/${i}`));
    });
  }

  return violations;
}

/**
 * 用 JSON Schema 子集校验 agent.result.output（§3.4 「平台在回送前校验」）。
 * schema 为 unknown（ExpectSpec.schema 是开放 JSON Schema object）——非对象 schema → 视为无约束放行。
 */
export function validateAgentOutput(output: unknown, schema: unknown): ValidateOutcome {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return { valid: true };
  }
  const violations = validateNode(output, schema as JsonSchemaNode, '');
  return violations.length === 0 ? { valid: true } : { valid: false, violations };
}

// ─── 重试策略（§3.2 L379「最多 N 次，实现声明」）────────────────────────

/**
 * 默认最大尝试次数（实现声明，doc-gap：Proto 未定量 ExpectSpec 的 N）。
 * 取 3：首次 + 2 次重试。gateway 调用方可覆盖。
 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * 是否还应重试（§3.4 校验不符退回子实例重试）。
 * attempt 从 1 计（第 1 次尝试为 attempt=1）；attempt < maxAttempts 时还可重试。
 */
export function shouldRetry(attempt: number, maxAttempts: number = DEFAULT_MAX_ATTEMPTS): boolean {
  return attempt < maxAttempts;
}

/**
 * 重试耗尽后构造 agent.failed(reason='invalid_output') 的 payload（§3.4 L380-381）。
 * error 携带首个校验违规摘要，供等待方/人类可读。
 */
export function invalidOutputFailure(
  correlationId: string,
  instanceId: string,
  violations: SchemaViolation[],
): AgentFailedPayload {
  const summary =
    violations.length === 0
      ? 'output failed schema validation'
      : violations.map((v) => `${v.path || '<root>'}: ${v.message}`).join('; ');
  const error: WattError = wattError('invalid_argument', summary, false);
  return { correlationId, instanceId, reason: 'invalid_output', error };
}
