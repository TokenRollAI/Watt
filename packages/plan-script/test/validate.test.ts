/**
 * 验收 #5：静态校验拒绝 import / eval / with / 未知全局名，放行合法脚本。
 */
import { describe, it, expect } from 'vitest';
import { validatePlanScript } from '../src/index.js';

describe('static validation', () => {
  it('放行只用 Host API 与安全内建的合法脚本', () => {
    const res = validatePlanScript(`
      const out = [];
      for (let i = 0; i < 3; i++) {
        const r = await run('agent_x', {});
        out.push(JSON.stringify(r));
      }
      return out;
    `);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it('放行 host.<fn> 聚合对象形态', () => {
    const res = validatePlanScript(`return await host.checkpoint('done', []);`);
    expect(res.ok).toBe(true);
  });

  it('拒绝 import 声明', () => {
    const res = validatePlanScript(`import x from 'y'; return x;`);
    expect(res.ok).toBe(false);
    // import 在 async 函数体内是语法错误，体现为 parse_error；属于拒绝路径。
    expect(res.errors.some((e) => e.code === 'parse_error' || e.code === 'forbidden_syntax')).toBe(true);
  });

  it('拒绝动态 import()', () => {
    const res = validatePlanScript(`const m = await import('y'); return m;`);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.message.includes('import'))).toBe(true);
  });

  it('拒绝 eval', () => {
    const res = validatePlanScript(`return eval('1+1');`);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'forbidden_global' && e.message.includes('eval'))).toBe(true);
  });

  it('拒绝 new Function', () => {
    const res = validatePlanScript(`const f = new Function('return 1'); return f();`);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.message.includes('Function'))).toBe(true);
  });

  it('拒绝 with 语句', () => {
    const res = validatePlanScript(`const o = {}; with (o) { return 1; }`);
    expect(res.ok).toBe(false);
    expect(
      res.errors.some(
        (e) => (e.code === 'forbidden_syntax' && e.message.includes('with')) || e.code === 'parse_error',
      ),
    ).toBe(true);
  });

  it('拒绝引用未知全局名', () => {
    const res = validatePlanScript(`return someUndeclaredThing.foo();`);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'unknown_global' && e.message.includes('someUndeclaredThing'))).toBe(
      true,
    );
  });

  it('拒绝引用 Date / Math.random 源（Date 在禁名单）', () => {
    const dateRes = validatePlanScript(`return Date.now();`);
    expect(dateRes.ok).toBe(false);
    expect(dateRes.errors.some((e) => e.code === 'forbidden_global' && e.message.includes('Date'))).toBe(true);
  });

  it('拒绝 fetch / setTimeout', () => {
    expect(validatePlanScript(`return fetch('http://x');`).ok).toBe(false);
    expect(validatePlanScript(`setTimeout(() => {}, 0); return 1;`).ok).toBe(false);
  });

  it('局部声明遮蔽不误报为未知全局', () => {
    const res = validatePlanScript(`
      function helper(x) { return x * 2; }
      const { a, b } = { a: 1, b: 2 };
      const arr = [a, b].map((v) => helper(v));
      return arr;
    `);
    expect(res.ok).toBe(true);
  });

  it('错误位置映射回原始源码（行号从 1 起）', () => {
    const res = validatePlanScript(`const ok = 1;\nreturn badGlobal;`);
    expect(res.ok).toBe(false);
    const err = res.errors.find((e) => e.code === 'unknown_global');
    expect(err).toBeDefined();
    // badGlobal 在原始源码第 2 行。
    expect(err!.line).toBe(2);
  });
});
