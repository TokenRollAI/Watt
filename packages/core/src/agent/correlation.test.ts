import { WATT_ERROR_CODES } from '@watt/shared';
import { describe, expect, it } from 'vitest';
import {
  type CorrelationTable,
  genCorrelationId,
  InMemoryCorrelationTable,
  validateCorrelationId,
  type Waiter,
} from './correlation.ts';

/**
 * correlationId 校验 + CorrelationTable 状态机（Proto §3.4）。
 * oracle：断言字符集/长度边界、状态机的 register/hasPending/resolve/expire/failWaiter 语义。
 */

// ═══ validateCorrelationId（§3.4 L444）═══════════════════════════════════

describe('validateCorrelationId', () => {
  it('接受合法字符集 [A-Za-z0-9_-]', () => {
    expect(validateCorrelationId('abc-DEF_123')).toBeNull();
  });
  it('接受长度 80 的边界', () => {
    expect(validateCorrelationId('a'.repeat(80))).toBeNull();
  });
  it('拒绝空串 → invalid_argument', () => {
    const e = validateCorrelationId('');
    expect(e?.code).toBe('invalid_argument');
    expect(e?.retryable).toBe(false);
  });
  it('拒绝长度 81 → invalid_argument', () => {
    const e = validateCorrelationId('a'.repeat(81));
    expect(e?.code).toBe('invalid_argument');
  });
  it('拒绝含非法字符（.、空格、/）→ invalid_argument', () => {
    for (const bad of ['a.b', 'a b', 'a/b', 'a@b', 'a:b']) {
      const e = validateCorrelationId(bad);
      expect(e?.code).toBe('invalid_argument');
      expect([...WATT_ERROR_CODES]).toContain(e?.code);
    }
  });
});

// ═══ genCorrelationId ════════════════════════════════════════════════════

describe('genCorrelationId', () => {
  it('合法 id 原样保留且必过校验', () => {
    const id = genCorrelationId(() => 'clean_id-1');
    expect(id).toBe('clean_id-1');
    expect(validateCorrelationId(id)).toBeNull();
  });
  it('净化非法字符为 -（如 UUID 的点/冒号）', () => {
    const id = genCorrelationId(() => 'a.b:c d');
    expect(validateCorrelationId(id)).toBeNull();
    expect(id).toBe('a-b-c-d');
  });
  it('截断超长到 ≤80 且仍合法', () => {
    const id = genCorrelationId(() => 'x'.repeat(200));
    expect(id.length).toBe(80);
    expect(validateCorrelationId(id)).toBeNull();
  });
  it('产物纯非法被截空时兜底合法占位', () => {
    // genId 产纯非法且长度恰好被净化/截断成空的极端：全部非法字符先被替换为 '-'，
    // 故实际不会空；用真正会截空的路径（空串产物）验证兜底。
    const id = genCorrelationId(() => '');
    expect(id).toBe('c');
    expect(validateCorrelationId(id)).toBeNull();
  });
});

// ═══ CorrelationTable 状态机 ═════════════════════════════════════════════

function waiter(id: string, kind: Waiter['kind'] = 'agent'): Waiter {
  return { kind, id };
}
function table(): CorrelationTable {
  return new InMemoryCorrelationTable();
}

describe('CorrelationTable.register + hasPending + resolve', () => {
  it('register 后 hasPending=true；resolve 首次返回 waiter', () => {
    const t = table();
    t.register('c-1', waiter('inst-A'), 1000);
    expect(t.hasPending('c-1')).toBe(true);
    expect(t.resolve('c-1')).toEqual(waiter('inst-A'));
  });

  it('规则 6 去重：resolve 首次生效，再次返回 null（记录仍在，hasPending=true）', () => {
    const t = table();
    t.register('c-1', waiter('inst-A'), 1000);
    expect(t.resolve('c-1')).toEqual(waiter('inst-A'));
    expect(t.resolve('c-1')).toBeNull();
    expect(t.hasPending('c-1')).toBe(true); // 已 settled 但记录仍在（区分 drop-duplicate vs drop-no-waiter）
  });

  it('从未 register 的 correlationId：hasPending=false，resolve=null', () => {
    const t = table();
    expect(t.hasPending('ghost')).toBe(false);
    expect(t.resolve('ghost')).toBeNull();
  });

  it('register 同 id 覆盖（幂等 upsert）', () => {
    const t = table();
    t.register('c-1', waiter('inst-A'), 1000);
    t.register('c-1', waiter('inst-B'), 2000);
    expect(t.resolve('c-1')).toEqual(waiter('inst-B'));
  });

  it('接受 task kind waiter', () => {
    const t = table();
    t.register('c-1', waiter('task-7', 'task'), 1000);
    expect(t.resolve('c-1')).toEqual({ kind: 'task', id: 'task-7' });
  });
});

describe('CorrelationTable.expire (规则 3 超时代发判定源)', () => {
  it('到期未 settled 的 correlation 被返回并标记 settled', () => {
    const t = table();
    t.register('c-1', waiter('inst-A'), 1000);
    t.register('c-2', waiter('inst-B'), 3000);
    expect(t.expire(2000)).toEqual(['c-1']); // c-2 未到期
    // 幂等：再次 expire 同时刻不重复返回（已 settled）
    expect(t.expire(2000)).toEqual([]);
  });

  it('timeoutAtMs == nowMs 视为到期（<=）', () => {
    const t = table();
    t.register('c-1', waiter('inst-A'), 1000);
    expect(t.expire(1000)).toEqual(['c-1']);
  });

  it('已 resolve 的 correlation 不再被 expire 返回', () => {
    const t = table();
    t.register('c-1', waiter('inst-A'), 1000);
    t.resolve('c-1');
    expect(t.expire(5000)).toEqual([]);
  });

  it('规则 3 幂等锁定：expire 后真实结果晚到 → resolve 返回 null（drop-duplicate 语义源）', () => {
    const t = table();
    t.register('c-1', waiter('inst-A'), 1000);
    expect(t.expire(2000)).toEqual(['c-1']); // 超时代发
    expect(t.hasPending('c-1')).toBe(true); // 记录仍在
    expect(t.resolve('c-1')).toBeNull(); // 真实结果晚到被丢弃
  });
});

describe('CorrelationTable.failWaiter (规则 4 终止即失败)', () => {
  it('返回该 waiter 名下全部未 settled correlation 并标记 settled', () => {
    const t = table();
    t.register('c-1', waiter('inst-A'), 1000);
    t.register('c-2', waiter('inst-A'), 2000);
    t.register('c-3', waiter('inst-B'), 3000);
    const failed = t.failWaiter('inst-A').sort();
    expect(failed).toEqual(['c-1', 'c-2']);
    // inst-B 不受影响
    expect(t.resolve('c-3')).toEqual(waiter('inst-B'));
  });

  it('已 settled 的不再计入 failWaiter', () => {
    const t = table();
    t.register('c-1', waiter('inst-A'), 1000);
    t.resolve('c-1');
    expect(t.failWaiter('inst-A')).toEqual([]);
  });

  it('无匹配 waiter → 空列表', () => {
    const t = table();
    t.register('c-1', waiter('inst-A'), 1000);
    expect(t.failWaiter('inst-Z')).toEqual([]);
  });
});
