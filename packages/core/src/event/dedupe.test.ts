import { describe, expect, it } from 'vitest';
import { DEFAULT_DEDUPE_WINDOW_MS, InMemoryDedupeStore, resolveDedupe } from './dedupe.ts';

/**
 * dedupeKey 幂等纯逻辑单测（§1 L117–118 / §2.3）。
 *
 * 时间窗：Proto 未定量（doc-gap #11）。本轮自定默认（见 dedupe.ts 注释）。
 * 报告 §11 建议 5 分钟；任务建议 24h——两者冲突。本实现取 24h（见 dedupe.ts 决策注释），
 * 并把窗口做成可注入参数，测试用注入值不依赖默认常量做 oracle。
 */

describe('resolveDedupe (idempotency within window)', () => {
  it('L3 same dedupeKey within window → returns original eventId + duplicate=true', () => {
    const store = new InMemoryDedupeStore();
    const first = resolveDedupe(store, {
      dedupeKey: 'feishu:msg-1',
      eventId: 'evt-1',
      now: 1000,
      windowMs: 60_000,
    });
    expect(first).toEqual({ eventId: 'evt-1', duplicate: false });

    const second = resolveDedupe(store, {
      dedupeKey: 'feishu:msg-1',
      eventId: 'evt-2',
      now: 2000,
      windowMs: 60_000,
    });
    // 幂等：返回原 id evt-1，标记 duplicate，不采纳 evt-2
    expect(second).toEqual({ eventId: 'evt-1', duplicate: true });
  });

  it('L4 different dedupeKey → two independent eventIds', () => {
    const store = new InMemoryDedupeStore();
    const a = resolveDedupe(store, {
      dedupeKey: 'feishu:msg-1',
      eventId: 'evt-1',
      now: 1000,
      windowMs: 60_000,
    });
    const b = resolveDedupe(store, {
      dedupeKey: 'feishu:msg-2',
      eventId: 'evt-2',
      now: 1000,
      windowMs: 60_000,
    });
    expect(a).toEqual({ eventId: 'evt-1', duplicate: false });
    expect(b).toEqual({ eventId: 'evt-2', duplicate: false });
  });

  it('L4b outside window → not deduped, new eventId recorded', () => {
    const store = new InMemoryDedupeStore();
    resolveDedupe(store, {
      dedupeKey: 'feishu:msg-1',
      eventId: 'evt-1',
      now: 1000,
      windowMs: 60_000,
    });
    // 61 秒后（超窗），同 key 应视为新事件
    const later = resolveDedupe(store, {
      dedupeKey: 'feishu:msg-1',
      eventId: 'evt-3',
      now: 1000 + 61_000,
      windowMs: 60_000,
    });
    expect(later).toEqual({ eventId: 'evt-3', duplicate: false });
  });

  it('L4c at exact window edge (now - stored == windowMs) still within window', () => {
    const store = new InMemoryDedupeStore();
    resolveDedupe(store, { dedupeKey: 'k', eventId: 'evt-1', now: 0, windowMs: 60_000 });
    const edge = resolveDedupe(store, {
      dedupeKey: 'k',
      eventId: 'evt-2',
      now: 60_000,
      windowMs: 60_000,
    });
    expect(edge).toEqual({ eventId: 'evt-1', duplicate: true });
  });

  it('L4d one ms past the edge → expired', () => {
    const store = new InMemoryDedupeStore();
    resolveDedupe(store, { dedupeKey: 'k', eventId: 'evt-1', now: 0, windowMs: 60_000 });
    const past = resolveDedupe(store, {
      dedupeKey: 'k',
      eventId: 'evt-2',
      now: 60_001,
      windowMs: 60_000,
    });
    expect(past).toEqual({ eventId: 'evt-2', duplicate: false });
  });

  it('uses DEFAULT_DEDUPE_WINDOW_MS when windowMs omitted', () => {
    // 默认窗口 = 24h（硬编码 oracle：24 * 60 * 60 * 1000）
    expect(DEFAULT_DEDUPE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    const store = new InMemoryDedupeStore();
    resolveDedupe(store, { dedupeKey: 'k', eventId: 'evt-1', now: 0 });
    // 12h 后仍在默认窗内 → 去重
    const within = resolveDedupe(store, {
      dedupeKey: 'k',
      eventId: 'evt-2',
      now: 12 * 60 * 60 * 1000,
    });
    expect(within).toEqual({ eventId: 'evt-1', duplicate: true });
  });
});
