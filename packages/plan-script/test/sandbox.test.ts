/**
 * 验收 #3/#4/#9：沙箱屏蔽非确定性能力、gas 截停、wall-clock 截停。
 *
 * #4 的「双重防线」语义：
 * - 第一道（静态校验）：replayPlanScript 直接拒绝引用 Date / fetch / setTimeout 的脚本。
 * - 第二道（运行期屏蔽）：用 executeInSandbox 跳过静态校验，证明即便绕过第一道，沙箱内
 *   这些能力也不可用（typeof === 'undefined' 或调用抛错）。
 */
import { describe, it, expect } from 'vitest';
import { replayPlanScript, executeInSandbox, validatePlanScript } from '../src/index.js';

describe('sandbox isolation (第二道防线，运行期)', () => {
  // —— #4 Date ——
  it('#4 静态校验拒绝 Date.now', () => {
    expect(validatePlanScript('return Date.now();').ok).toBe(false);
    // replayPlanScript 据此返回 validation_failed。
  });
  it('#4 运行期：沙箱内 Date 被删除（typeof === "undefined"）', async () => {
    const res = await executeInSandbox({ source: `return typeof Date;`, journal: [] });
    expect(res.status).toBe('completed');
    if (res.status === 'completed') expect(res.value).toBe('undefined');
  });

  // —— #4 Math.random（Math 静态放行，random 运行期屏蔽）——
  it('#4 运行期：Math.random 被覆盖为抛错（静态层放行 Math）', async () => {
    // Math 在安全白名单，脚本可正常 await/return；random 访问被运行期屏蔽。
    const res = await replayPlanScript({
      source: `
        const m = Math;
        try { m['random'](); return 'CALLED'; }
        catch (e) { return 'BLOCKED'; }
      `,
      journal: [],
    });
    expect(res.status).toBe('completed');
    if (res.status === 'completed') expect(res.value).toBe('BLOCKED');
  });

  // —— #4 fetch ——
  it('#4 静态校验拒绝 fetch', () => {
    expect(validatePlanScript("return fetch('http://x');").ok).toBe(false);
  });
  it('#4 运行期：沙箱内 fetch 不可用', async () => {
    const res = await executeInSandbox({ source: `return typeof globalThis['fetch'];`, journal: [] });
    expect(res.status).toBe('completed');
    if (res.status === 'completed') expect(res.value).toBe('undefined');
  });

  // —— #4 setTimeout ——
  it('#4 静态校验拒绝 setTimeout', () => {
    expect(validatePlanScript('setTimeout(()=>{},0); return 1;').ok).toBe(false);
  });
  it('#4 运行期：沙箱内 setTimeout 不可用', async () => {
    const res = await executeInSandbox({ source: `return typeof globalThis['setTimeout'];`, journal: [] });
    expect(res.status).toBe('completed');
    if (res.status === 'completed') expect(res.value).toBe('undefined');
  });

  // —— 端到端：replayPlanScript 对 Date/fetch 直接 validation_failed ——
  it('#4 replayPlanScript 对引用 Date 的脚本返回 validation_failed', async () => {
    const res = await replayPlanScript({ source: `return Date.now();`, journal: [] });
    expect(res.status).toBe('validation_failed');
  });

  // —— #3 gas 截停 ——
  it('#3 死循环脚本被 gas 截停 → gas_exceeded', async () => {
    const res = await replayPlanScript({
      source: `let i = 0; while (true) { i = i + 1; }`,
      journal: [],
      gasLimit: 2000, // 低 gas 上限，确保 gas 先于 wall-clock 触发。
      wallClockTimeoutMs: 5000,
    });
    expect(res.status).toBe('gas_exceeded');
  }, 10000);

  it('#3b 无限递归撞栈被截停且不污染宿主（failed）', async () => {
    const res = await replayPlanScript({
      source: `function f() { return f(); } return f();`,
      journal: [],
      gasLimit: 100_000_000,
      wallClockTimeoutMs: 5000,
    });
    // 原生栈溢出被宿主侧兜底归类为 failed；宿主进程不崩溃即为通过。
    expect(['failed', 'gas_exceeded', 'timeout']).toContain(res.status);
  }, 10000);

  // —— #9 wall-clock 截停 ——
  it('#9 高 gas 上限下死循环被 wall-clock 截停 → timeout', async () => {
    const res = await replayPlanScript({
      source: `let i = 0; while (true) { i = i + 1; }`,
      journal: [],
      gasLimit: 1_000_000_000, // 极高，让 gas 不会先触发。
      wallClockTimeoutMs: 300,
    });
    expect(res.status).toBe('timeout');
  }, 10000);
});
