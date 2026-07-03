import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_ATTEMPTS,
  invalidOutputFailure,
  shouldRetry,
  validateAgentOutput,
} from './expect-schema.ts';
import { agentFailedPayloadSchema } from './types.ts';

/**
 * ExpectSpec.schema 子集校验 + 重试策略（Proto §3.2 / §3.4）。
 * oracle：断言五关键字（type/properties/required/items/enum）的通过/违规，
 *   shouldRetry 边界，invalid_output 失败 payload 形状。
 */

// ═══ validateAgentOutput：JSON Schema 子集 ═══════════════════════════════

describe('validateAgentOutput — type 关键字', () => {
  it('基础类型匹配通过', () => {
    expect(validateAgentOutput('hi', { type: 'string' }).valid).toBe(true);
    expect(validateAgentOutput(3, { type: 'number' }).valid).toBe(true);
    expect(validateAgentOutput(true, { type: 'boolean' }).valid).toBe(true);
    expect(validateAgentOutput(null, { type: 'null' }).valid).toBe(true);
    expect(validateAgentOutput([], { type: 'array' }).valid).toBe(true);
    expect(validateAgentOutput({}, { type: 'object' }).valid).toBe(true);
  });

  it('integer 要求整数（3.5 不通过，3 通过）', () => {
    expect(validateAgentOutput(3, { type: 'integer' }).valid).toBe(true);
    expect(validateAgentOutput(3.5, { type: 'integer' }).valid).toBe(false);
    expect(validateAgentOutput('3', { type: 'integer' }).valid).toBe(false);
  });

  it('type 不匹配 → 违规带路径与原因', () => {
    const r = validateAgentOutput(42, { type: 'string' });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.violations[0]?.path).toBe('');
      expect(r.violations[0]?.message).toContain("expected type 'string'");
    }
  });

  it('null 不被误判为 object', () => {
    expect(validateAgentOutput(null, { type: 'object' }).valid).toBe(false);
  });
  it('array 不被误判为 object', () => {
    expect(validateAgentOutput([], { type: 'object' }).valid).toBe(false);
  });
});

describe('validateAgentOutput — properties + required', () => {
  const schema = {
    type: 'object',
    properties: { score: { type: 'number' }, label: { type: 'string' } },
    required: ['score'],
  };

  it('满足 required + properties 通过', () => {
    expect(validateAgentOutput({ score: 9, label: 'ok' }, schema).valid).toBe(true);
  });
  it('缺 required → 违规（路径指向缺失键）', () => {
    const r = validateAgentOutput({ label: 'ok' }, schema);
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.violations.some((v) => v.path === '/score' && v.message.includes('required'))).toBe(
        true,
      );
    }
  });
  it('存在但类型错的属性 → 违规（嵌套路径）', () => {
    const r = validateAgentOutput({ score: 'high' }, schema);
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.violations.some((v) => v.path === '/score')).toBe(true);
    }
  });
  it('未在 properties 声明的多余键被忽略（不判失败）', () => {
    expect(validateAgentOutput({ score: 1, extra: true }, schema).valid).toBe(true);
  });
  it('无 properties/required 的 object schema：任意对象通过', () => {
    expect(validateAgentOutput({ a: 1 }, { type: 'object' }).valid).toBe(true);
  });
});

describe('validateAgentOutput — items（数组元素）', () => {
  const schema = { type: 'array', items: { type: 'number' } };
  it('全元素合法通过', () => {
    expect(validateAgentOutput([1, 2, 3], schema).valid).toBe(true);
  });
  it('某元素类型错 → 违规（路径带索引）', () => {
    const r = validateAgentOutput([1, 'x', 3], schema);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.violations.some((v) => v.path === '/1')).toBe(true);
  });
  it('array 无 items 声明：任意元素通过', () => {
    expect(validateAgentOutput([1, 'x', {}], { type: 'array' }).valid).toBe(true);
  });
  it('嵌套 object 数组：深层路径违规', () => {
    const nested = {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    };
    const r = validateAgentOutput([{ id: 'a' }, { id: 5 }], nested);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.violations.some((v) => v.path === '/1/id')).toBe(true);
  });
});

describe('validateAgentOutput — enum', () => {
  const schema = { enum: ['approve', 'reject'] };
  it('取值在 enum 内通过', () => {
    expect(validateAgentOutput('approve', schema).valid).toBe(true);
  });
  it('取值不在 enum 内 → 违规', () => {
    expect(validateAgentOutput('maybe', schema).valid).toBe(false);
  });
  it('enum 与 type 组合校验', () => {
    const combo = { type: 'string', enum: ['a', 'b'] };
    expect(validateAgentOutput('a', combo).valid).toBe(true);
    expect(validateAgentOutput('c', combo).valid).toBe(false);
  });
});

describe('validateAgentOutput — 无约束 / 非对象 schema', () => {
  it('schema 非对象（null）→ 视为无约束放行', () => {
    expect(validateAgentOutput({ anything: true }, null).valid).toBe(true);
  });
  it('schema 为数组 → 视为无约束放行', () => {
    expect(validateAgentOutput(123, [1, 2]).valid).toBe(true);
  });
  it('schema 为字符串 → 视为无约束放行', () => {
    expect(validateAgentOutput(123, 'nope').valid).toBe(true);
  });
  it('空 schema 对象（无关键字）→ 任意通过', () => {
    expect(validateAgentOutput({ a: 1 }, {}).valid).toBe(true);
  });
});

// ═══ 重试策略（§3.4 最多 N 次）══════════════════════════════════════════

describe('shouldRetry / DEFAULT_MAX_ATTEMPTS', () => {
  it('默认 maxAttempts=3（实现声明）', () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(3);
  });
  it('attempt < max 可重试；到达 max 停止（默认 3）', () => {
    expect(shouldRetry(1)).toBe(true);
    expect(shouldRetry(2)).toBe(true);
    expect(shouldRetry(3)).toBe(false);
    expect(shouldRetry(4)).toBe(false);
  });
  it('可覆盖 maxAttempts', () => {
    expect(shouldRetry(1, 1)).toBe(false);
    expect(shouldRetry(4, 5)).toBe(true);
  });
});

describe('invalidOutputFailure', () => {
  it('产 reason=invalid_output 且 error.code=invalid_argument，摘要含违规', () => {
    const payload = invalidOutputFailure('c-1', 'inst-child', [
      { path: '/score', message: 'expected number' },
    ]);
    const parsed = agentFailedPayloadSchema.parse(payload);
    expect(parsed.reason).toBe('invalid_output');
    expect(parsed.error?.code).toBe('invalid_argument');
    expect(parsed.error?.retryable).toBe(false);
    expect(parsed.error?.message).toContain('/score');
    expect(parsed.error?.message).toContain('expected number');
  });

  it('根路径违规摘要用 <root> 占位', () => {
    const payload = invalidOutputFailure('c-1', 'inst-child', [
      { path: '', message: 'type mismatch' },
    ]);
    expect(payload.error?.message).toContain('<root>');
  });

  it('无违规列表时给通用摘要', () => {
    const payload = invalidOutputFailure('c-1', 'inst-child', []);
    expect(payload.error?.message).toBe('output failed schema validation');
  });
});
