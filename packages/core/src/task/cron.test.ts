import { describe, expect, it } from 'vitest';
import { nextFireTime, type ParsedSchedule, parseCronSchedule } from './cron.ts';

/**
 * Cron 解析（Proto §7 L755）。
 * oracle：五段子集（* / N / a-b / a,b / *​/n）解析 + 范围校验 + 拒绝面；
 *   ISO 一次性判定；nextFireTime cron 逐分钟搜 / once 过期语义。
 */

function asCron(schedule: string): ParsedSchedule {
  const p = parseCronSchedule(schedule);
  if ('code' in p) throw new Error(`expected parse ok, got error: ${p.message}`);
  return p;
}

describe('parseCronSchedule — 一次性 ISO', () => {
  it('含 T 的 ISO 时刻 → once', () => {
    const p = parseCronSchedule('2026-07-03T12:00:00Z');
    expect(p).toEqual({ kind: 'once', at: '2026-07-03T12:00:00Z' });
  });

  it('纯日期（无 T）不当作 once → 落入 cron 段数判定', () => {
    const p = parseCronSchedule('2026-07-03');
    expect('code' in p).toBe(true); // 1 段 ≠ 5 段
  });

  it('含 T 但不可解析 → 落入 cron 段数判定', () => {
    const p = parseCronSchedule('nonsense-T-value');
    expect('code' in p).toBe(true);
  });
});

describe('parseCronSchedule — 空与段数', () => {
  it('空串 → invalid_argument', () => {
    expect(parseCronSchedule('   ')).toMatchObject({ code: 'invalid_argument' });
  });

  it('段数 ≠ 5 → invalid_argument', () => {
    const e = parseCronSchedule('* * *');
    expect(e).toMatchObject({ code: 'invalid_argument' });
    if ('message' in e) expect(e.message).toContain('3');
  });
});

describe('parseCronSchedule — 五段子集语法', () => {
  it('全通配 * * * * *', () => {
    const p = asCron('* * * * *');
    if (p.kind === 'cron') {
      expect(p.fields[0]).toHaveLength(60);
      expect(p.fields[4]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
  });

  it('单值 30 2 * * *', () => {
    const p = asCron('30 2 * * *');
    if (p.kind === 'cron') {
      expect(p.fields[0]).toEqual([30]);
      expect(p.fields[1]).toEqual([2]);
    }
  });

  it('列表 0,15,30,45 * * * *', () => {
    const p = asCron('0,15,30,45 * * * *');
    if (p.kind === 'cron') expect(p.fields[0]).toEqual([0, 15, 30, 45]);
  });

  it('范围 * 9-17 * * *', () => {
    const p = asCron('* 9-17 * * *');
    if (p.kind === 'cron') expect(p.fields[1]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('步进 */15 * * * *', () => {
    const p = asCron('*/15 * * * *');
    if (p.kind === 'cron') expect(p.fields[0]).toEqual([0, 15, 30, 45]);
  });

  it('列表含范围 1-3,5 * * * *', () => {
    const p = asCron('1-3,5 * * * *');
    if (p.kind === 'cron') expect(p.fields[0]).toEqual([1, 2, 3, 5]);
  });
});

describe('parseCronSchedule — 拒绝面', () => {
  it('步进非整数 */x', () => {
    expect(parseCronSchedule('*/x * * * *')).toMatchObject({ code: 'invalid_argument' });
  });
  it('步进 <1 (*/0)', () => {
    expect(parseCronSchedule('*/0 * * * *')).toMatchObject({ code: 'invalid_argument' });
  });
  it('单值越界（分 60）', () => {
    expect(parseCronSchedule('60 * * * *')).toMatchObject({ code: 'invalid_argument' });
  });
  it('单值非整数（分 abc）', () => {
    expect(parseCronSchedule('abc * * * *')).toMatchObject({ code: 'invalid_argument' });
  });
  it('范围三段 a-b-c', () => {
    expect(parseCronSchedule('1-2-3 * * * *')).toMatchObject({ code: 'invalid_argument' });
  });
  it('范围非整数边界 a-b', () => {
    expect(parseCronSchedule('a-b * * * *')).toMatchObject({ code: 'invalid_argument' });
  });
  it('范围 lo>hi', () => {
    expect(parseCronSchedule('5-1 * * * *')).toMatchObject({ code: 'invalid_argument' });
  });
  it('范围越界（时 0-24）', () => {
    expect(parseCronSchedule('* 0-24 * * *')).toMatchObject({ code: 'invalid_argument' });
  });
  it('空列表片段（尾逗号）', () => {
    expect(parseCronSchedule('1, * * * *')).toMatchObject({ code: 'invalid_argument' });
  });
  it('日段越界（0）', () => {
    expect(parseCronSchedule('* * 0 * *')).toMatchObject({ code: 'invalid_argument' });
  });
  it('月段越界（13）', () => {
    expect(parseCronSchedule('* * * 13 *')).toMatchObject({ code: 'invalid_argument' });
  });
  it('周段越界（7）', () => {
    expect(parseCronSchedule('* * * * 7')).toMatchObject({ code: 'invalid_argument' });
  });
});

describe('nextFireTime — once', () => {
  it('未来时刻 → 其毫秒', () => {
    const at = '2026-07-03T12:00:00Z';
    const p = asCron(at);
    const from = Date.parse('2026-07-03T11:00:00Z');
    expect(nextFireTime(p, from)).toBe(Date.parse(at));
  });

  it('已过期（≤ fromMs）→ null', () => {
    const p = asCron('2026-07-03T12:00:00Z');
    const from = Date.parse('2026-07-03T13:00:00Z');
    expect(nextFireTime(p, from)).toBeNull();
  });

  it('恰等于 fromMs（边界，非严格大于）→ null', () => {
    const at = '2026-07-03T12:00:00Z';
    const p = asCron(at);
    expect(nextFireTime(p, Date.parse(at))).toBeNull();
  });

  it('at 不可解析 → null（防御）', () => {
    // 直接构造非法 once（绕过 parse），断言 nextFireTime 的 NaN 防御分支
    expect(nextFireTime({ kind: 'once', at: 'not-a-date' }, 0)).toBeNull();
  });
});

describe('nextFireTime — cron', () => {
  it('每小时整点：从 12:30 起下次 13:00', () => {
    const p = asCron('0 * * * *');
    const from = Date.parse('2026-07-03T12:30:00Z');
    const next = nextFireTime(p, from);
    expect(new Date(next as number).toISOString()).toBe('2026-07-03T13:00:00.000Z');
  });

  it('每天 02:30 UTC：从 03:00 起跨到次日', () => {
    const p = asCron('30 2 * * *');
    const from = Date.parse('2026-07-03T03:00:00Z');
    const next = nextFireTime(p, from);
    expect(new Date(next as number).toISOString()).toBe('2026-07-04T02:30:00.000Z');
  });

  it('特定星期（周五=5）09:00', () => {
    const p = asCron('0 9 * * 5');
    // 2026-07-03 是周五
    const from = Date.parse('2026-07-03T08:00:00Z');
    const next = nextFireTime(p, from);
    expect(new Date(next as number).toISOString()).toBe('2026-07-03T09:00:00.000Z');
  });

  it('秒/毫秒被清零后从下一分钟搜（* * * * * 从 12:00:30 起 → 12:01:00）', () => {
    const p = asCron('* * * * *');
    const from = Date.parse('2026-07-03T12:00:30.500Z');
    const next = nextFireTime(p, from);
    expect(new Date(next as number).toISOString()).toBe('2026-07-03T12:01:00.000Z');
  });

  it('不可满足的日月组合（2月30日）→ null（搜索上界耗尽）', () => {
    const p = asCron('0 0 30 2 *');
    const next = nextFireTime(p, Date.parse('2026-01-01T00:00:00Z'));
    expect(next).toBeNull();
  });
});
