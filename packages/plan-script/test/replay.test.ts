/**
 * 验收 #1/#2/#6/#7/#8 与预算超限：journal 重放语义。
 */
import { describe, it, expect } from 'vitest';
import { replayPlanScript } from '../src/index.js';
import type { JournalEntry } from '@watt/protocol';
import { makeAgentId, makeCtx } from './helpers.js';

describe('replay engine', () => {
  // —— #1 重放确定性 ——
  it('#1 同一 journal 重放两次 → 相同的下一批 pending 调用', async () => {
    const source = `
      const a = await run('agent_A', { objective: 'a', inputs: [], budget: { maxCostUsd: 1, maxWallClockMs: 1000, maxToolCalls: 1 }, expectedOutput: 'x', permissions: { contextScope: [] } });
      const b = await run('agent_B', { objective: 'b', inputs: [], budget: { maxCostUsd: 1, maxWallClockMs: 1000, maxToolCalls: 1 }, expectedOutput: 'y', permissions: { contextScope: [] } });
      return [a, b];
    `;
    const journal: JournalEntry[] = [];
    const r1 = await replayPlanScript({ source, journal });
    const r2 = await replayPlanScript({ source, journal });
    expect(r1.status).toBe('pending');
    expect(r2.status).toBe('pending');
    if (r1.status === 'pending' && r2.status === 'pending') {
      // 第一次只发起 seq=0（脚本在 await a 处挂起），两次结果全等。
      expect(r1.calls).toEqual(r2.calls);
      expect(r1.calls).toHaveLength(1);
      expect(r1.calls[0]!.seq).toBe(0);
      expect(r1.calls[0]!.fn).toBe('run');
      expect((r1.calls[0]!.params as { agent: string }).agent).toBe('agent_A');
    }
  });

  // —— #2 并发 fan-out ——
  it('#2 Promise.all 发起 3 个调用 → seq 0,1,2，完成顺序不影响执行流', async () => {
    const source = `
      const ctx = (n) => ({ objective: n, inputs: [], budget: { maxCostUsd: 1, maxWallClockMs: 1000, maxToolCalls: 1 }, expectedOutput: 'x', permissions: { contextScope: [] } });
      const results = await Promise.all([
        run('agent_0', ctx('0')),
        run('agent_1', ctx('1')),
        run('agent_2', ctx('2')),
      ]);
      return results.map((r) => r.output);
    `;
    // 空 journal：三个调用同时 pending，seq 应为 0,1,2（按发起顺序）。
    const first = await replayPlanScript({ source, journal: [] });
    expect(first.status).toBe('pending');
    if (first.status !== 'pending') return;
    expect(first.calls.map((c) => c.seq)).toEqual([0, 1, 2]);
    expect(first.calls.map((c) => (c.params as { agent: string }).agent)).toEqual([
      'agent_0',
      'agent_1',
      'agent_2',
    ]);

    // 以「不同完成顺序」补全 journal（seq 2 先填、seq 0 后填），重放执行流必须不变 →
    // 三个都完成后脚本应跑到底（completed），返回 [out0, out1, out2]。
    const params = first.calls;
    const journal: JournalEntry[] = [
      // 故意打乱数组顺序，但 seq 字段决定语义；引擎以数组下标=seq 读取，故仍按 seq 放。
      { seq: 0, fn: 'run', params: params[0]!.params, result: { status: 'ok', costUsd: 0.1, output: 'out0' } },
      { seq: 1, fn: 'run', params: params[1]!.params, result: { status: 'ok', costUsd: 0.1, output: 'out1' } },
      { seq: 2, fn: 'run', params: params[2]!.params, result: { status: 'ok', costUsd: 0.1, output: 'out2' } },
    ] as JournalEntry[];
    const done = await replayPlanScript({ source, journal });
    expect(done.status).toBe('completed');
    if (done.status === 'completed') {
      expect(done.value).toEqual(['out0', 'out1', 'out2']);
    }
  });

  it('#2b 部分完成（仅 seq=1 有结果，且数组顺序打乱）→ 仍是同一 frontier', async () => {
    const source = `
      const ctx = (n) => ({ objective: n, inputs: [], budget: { maxCostUsd: 1, maxWallClockMs: 1000, maxToolCalls: 1 }, expectedOutput: 'x', permissions: { contextScope: [] } });
      const results = await Promise.all([
        run('agent_0', ctx('0')),
        run('agent_1', ctx('1')),
        run('agent_2', ctx('2')),
      ]);
      return results.map((r) => r.output);
    `;
    const base = await replayPlanScript({ source, journal: [] });
    expect(base.status).toBe('pending');
    if (base.status !== 'pending') return;
    const p = base.calls;
    // 故意把 seq=1 的「中间」调用先完成，数组顺序也打乱：seq 字段才是键。
    const journal: JournalEntry[] = [
      { seq: 2, fn: 'run', params: p[2]!.params } as unknown as JournalEntry,
      { seq: 1, fn: 'run', params: p[1]!.params, result: { status: 'ok', costUsd: 0.1, output: 'out1' } } as unknown as JournalEntry,
      { seq: 0, fn: 'run', params: p[0]!.params } as unknown as JournalEntry,
    ];
    // 数组下标=seq 是引擎约定，故须按 seq 重排再传入。
    const bySeq: JournalEntry[] = [];
    for (const e of journal) bySeq[e.seq] = e;
    const res = await replayPlanScript({ source, journal: bySeq });
    // seq 0/2 仍未完成 → Promise.all 未 resolve → frontier 仍是 seq 0,1,2（已完成的 1 也
    // 仍在 frontier 集合外？不——seq=1 已 settle，不应出现在 pending 集合）。
    expect(res.status).toBe('pending');
    if (res.status === 'pending') {
      // 已 settle 的 seq=1 不在 pending；仍待执行的是 seq 0 与 2。
      expect(res.calls.map((c) => c.seq)).toEqual([0, 2]);
    }
  });

  it('#2c host.<fn> 聚合对象形态在运行期等价于全局函数', async () => {
    const source = `
      const ctx = { objective: 'o', inputs: [], budget: { maxCostUsd: 1, maxWallClockMs: 1000, maxToolCalls: 1 }, expectedOutput: 'x', permissions: { contextScope: [] } };
      return await host.run('agent_via_host', ctx);
    `;
    const res = await replayPlanScript({ source, journal: [] });
    expect(res.status).toBe('pending');
    if (res.status === 'pending') {
      expect(res.calls).toHaveLength(1);
      expect(res.calls[0]!.fn).toBe('run');
      expect((res.calls[0]!.params as { agent: string }).agent).toBe('agent_via_host');
    }
  });

  // —— #6 已完成调用立即返回缓存结果，脚本据此推进 ——
  it('#6 journal 中已完成调用立即返回缓存结果，脚本依赖该结果继续', async () => {
    const agent = makeAgentId();
    const ctx = makeCtx('step1');
    const source = `
      const first = await run(${JSON.stringify(agent)}, ${JSON.stringify(ctx)});
      // 依赖 first.output 决定下一步：分支必须由缓存结果驱动。
      if (first.output === 'go') {
        return await invoke('next-tool', { from: first.output });
      }
      return 'no-op';
    `;
    const journal: JournalEntry[] = [
      { seq: 0, fn: 'run', params: { agent, ctx }, result: { status: 'ok', costUsd: 0.2, output: 'go' } },
    ] as JournalEntry[];
    const res = await replayPlanScript({ source, journal });
    // first 已缓存 → 脚本进入 if 分支 → 发起第二个调用 invoke（pending）。
    expect(res.status).toBe('pending');
    if (res.status === 'pending') {
      expect(res.calls).toHaveLength(1);
      expect(res.calls[0]!.seq).toBe(1);
      expect(res.calls[0]!.fn).toBe('invoke');
      expect((res.calls[0]!.params as { args: { from: string } }).args.from).toBe('go');
    }
  });

  // —— #7 continue-on-error：Host 返回 status:'failed' 脚本可降级继续 ——
  it('#7 Host 返回 status:failed 时脚本降级继续（不抛异常）', async () => {
    const agent = makeAgentId();
    const ctx = makeCtx('risky');
    const source = `
      const r = await run(${JSON.stringify(agent)}, ${JSON.stringify(ctx)});
      if (r.status === 'failed') {
        // 降级：失败不抛异常，改走回退工具。
        return await invoke('fallback', { reason: r.error.code });
      }
      return r.output;
    `;
    const journal: JournalEntry[] = [
      {
        seq: 0,
        fn: 'run',
        params: { agent, ctx },
        result: { status: 'failed', costUsd: 0.05, error: { code: 'AGENT_TIMEOUT', message: 'too slow' } },
      },
    ] as JournalEntry[];
    const res = await replayPlanScript({ source, journal });
    expect(res.status).toBe('pending');
    if (res.status === 'pending') {
      expect(res.calls[0]!.fn).toBe('invoke');
      expect((res.calls[0]!.params as { args: { reason: string } }).args.reason).toBe('AGENT_TIMEOUT');
    }
  });

  // —— #8 journal mismatch 检测 ——
  it('#8 脚本实际调用与 journal 条目不一致 → journal_mismatch', async () => {
    const agent = makeAgentId();
    const ctx = makeCtx('x');
    // 脚本发起的是 run，但 journal seq=0 记的是 invoke → fn 不一致。
    const source = `return await run(${JSON.stringify(agent)}, ${JSON.stringify(ctx)});`;
    const journal: JournalEntry[] = [
      { seq: 0, fn: 'invoke', params: { tool: 't', args: {} }, result: { status: 'ok', costUsd: 0 } },
    ] as JournalEntry[];
    const res = await replayPlanScript({ source, journal });
    expect(res.status).toBe('journal_mismatch');
    if (res.status === 'journal_mismatch') {
      expect(res.error.expected?.fn).toBe('invoke');
      expect(res.error.actual?.fn).toBe('run');
    }
  });

  it('#8b params 不一致也触发 journal_mismatch', async () => {
    const agent = makeAgentId();
    const source = `return await run(${JSON.stringify(agent)}, ${JSON.stringify(makeCtx('real-objective'))});`;
    const journal: JournalEntry[] = [
      // 同 fn=run，但 ctx.objective 不同 → params 不等。
      { seq: 0, fn: 'run', params: { agent, ctx: makeCtx('WRONG-objective') }, result: { status: 'ok', costUsd: 0 } },
    ] as JournalEntry[];
    const res = await replayPlanScript({ source, journal });
    expect(res.status).toBe('journal_mismatch');
  });

  // —— 预算超限：宿主直接终止，错误不投递进沙箱，状态 budget_exceeded ——
  it('预算超限 → budget_exceeded，且脚本无法捕获', async () => {
    const agent = makeAgentId();
    const ctx = makeCtx('expensive');
    // 脚本试图 try/catch 吞掉错误；但预算超限根本不会作为异常进入沙箱。
    const source = `
      try {
        const r = await run(${JSON.stringify(agent)}, ${JSON.stringify(ctx)});
        return r;
      } catch (e) {
        return 'caught: ' + String(e);
      }
    `;
    const res = await replayPlanScript({
      source,
      journal: [],
      budgetCheck: (call) => call.fn === 'run', // 任何 run 都判超限。
    });
    expect(res.status).toBe('budget_exceeded');
  });

  it('预算超限后脚本立即静止：已 resolve 的分支不再推进、不再发起新 Host 调用', async () => {
    const agent = makeAgentId();
    const ctxA = makeCtx('a');
    const ctxB = makeCtx('b');
    // fan-out：seq=0 有缓存结果、seq=1 触发预算超限。若终止不及时，脚本会在 p0 的
    // .then 继续执行并发起 checkpoint（seq=2）——budgetCheck 将观测到第二次调用。
    const source = `
      const p0 = run(${JSON.stringify(agent)}, ${JSON.stringify(ctxA)});
      const p1 = run(${JSON.stringify(agent)}, ${JSON.stringify(ctxB)});
      const r0 = await p0;
      await checkpoint('should-never-run');
      return 'done';
    `;
    const seen: string[] = [];
    const journal: JournalEntry[] = [
      { seq: 0, fn: 'run', params: { agent, ctx: ctxA }, result: { status: 'ok', costUsd: 0.1, output: 'r0' } },
    ] as JournalEntry[];
    const res = await replayPlanScript({
      source,
      journal,
      budgetCheck: (call) => {
        seen.push(call.fn);
        return true; // 第一个新调用（seq=1 的 run）即超限。
      },
    });
    expect(res.status).toBe('budget_exceeded');
    // 终止信号置位后微任务驱动立即停止：checkpoint 永不应到达宿主。
    expect(seen).toEqual(['run']);
  });

  // —— journal 归一化：以 seq 字段为键，与数组顺序/紧凑度无关 ——
  it('journal 跳号（紧凑数组下标≠seq）仍按 seq 正确重放', async () => {
    const ctxLiteral = `(n) => ({ objective: n, inputs: [], budget: { maxCostUsd: 1, maxWallClockMs: 1000, maxToolCalls: 1 }, expectedOutput: 'x', permissions: { contextScope: [] } })`;
    const source = `
      const ctx = ${ctxLiteral};
      const results = await Promise.all([
        run('agent_0', ctx('0')),
        run('agent_1', ctx('1')),
        run('agent_2', ctx('2')),
      ]);
      return results;
    `;
    const base = await replayPlanScript({ source, journal: [] });
    expect(base.status).toBe('pending');
    if (base.status !== 'pending') return;
    const p = base.calls;
    // 存储层常见形态：按 seq 排序后的「紧凑」数组，seq=1 缺失 → 下标 1 放的是 seq=2。
    const compact: JournalEntry[] = [
      { seq: 0, fn: 'run', params: p[0]!.params, result: { status: 'ok', costUsd: 0.1, output: 'out0' } },
      { seq: 2, fn: 'run', params: p[2]!.params, result: { status: 'ok', costUsd: 0.1, output: 'out2' } },
    ] as JournalEntry[];
    const res = await replayPlanScript({ source, journal: compact });
    // seq 0/2 已完成、seq 1 仍 pending —— 不得误判 journal_mismatch。
    expect(res.status).toBe('pending');
    if (res.status === 'pending') {
      expect(res.calls.map((c) => c.seq)).toEqual([1]);
    }
  });

  it('journal 条目含 zod 会剥离的未知字段 → 归一化后不产生假 mismatch', async () => {
    const agent = makeAgentId();
    const ctx = makeCtx('x');
    const source = `return await run(${JSON.stringify(agent)}, ${JSON.stringify(ctx)});`;
    // 模拟旧客户端写入的额外字段：归一化必须剥离后再比较。
    const entry = {
      seq: 0,
      fn: 'run',
      params: { agent, ctx, legacyField: 'stripped-by-zod' },
      result: { status: 'ok', costUsd: 0.1, output: 'fine' },
    } as unknown as JournalEntry;
    const res = await replayPlanScript({ source, journal: [entry] });
    expect(res.status).toBe('completed');
    if (res.status === 'completed') {
      expect(res.value).toMatchObject({ status: 'ok', output: 'fine' });
    }
  });

  // —— completed：脚本不发起任何 Host 调用直接跑完 ——
  it('completed：纯计算脚本返回完成值', async () => {
    const res = await replayPlanScript({
      source: `const xs = [1,2,3]; return xs.reduce((a,b)=>a+b,0);`,
      journal: [],
    });
    expect(res.status).toBe('completed');
    if (res.status === 'completed') expect(res.value).toBe(6);
  });

  // —— failed：脚本未捕获异常 ——
  it('failed：脚本抛出未捕获异常', async () => {
    const res = await replayPlanScript({
      source: `throw new Error('boom');`,
      journal: [],
    });
    expect(res.status).toBe('failed');
    if (res.status === 'failed') expect(res.error.message).toContain('boom');
  });

  // —— validation_failed：静态校验不过的脚本不进沙箱 ——
  it('validation_failed：含未知全局名的脚本不执行', async () => {
    const res = await replayPlanScript({ source: `return mysteryGlobal();`, journal: [] });
    expect(res.status).toBe('validation_failed');
    if (res.status === 'validation_failed') {
      expect(res.errors.some((e) => e.code === 'unknown_global')).toBe(true);
    }
  });

  // —— Host 调用参数 schema 校验失败 → failed（契约破坏，非 continue-on-error）——
  it('Host 调用参数不合法（ctx 缺字段）→ failed', async () => {
    const source = `return await run('agent_x', { objective: 'only-objective' });`;
    const res = await replayPlanScript({ source, journal: [] });
    expect(res.status).toBe('failed');
    if (res.status === 'failed') {
      expect(res.error.message).toContain('参数校验失败');
    }
  });

  // —— sleep 参数归一化：位置参数 ms → { ms } ——
  it('sleep(ms) 归一化为 { ms } 并作为 pending frontier', async () => {
    const source = `await sleep(5000); return 'woke';`;
    const res = await replayPlanScript({ source, journal: [] });
    expect(res.status).toBe('pending');
    if (res.status === 'pending') {
      expect(res.calls[0]!.fn).toBe('sleep');
      expect((res.calls[0]!.params as { ms: number }).ms).toBe(5000);
    }
  });
});
