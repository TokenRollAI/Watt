import { describe, expect, it } from 'vitest';
import { formatMetricsHuman, parseRangeToMs, resolveRange, sumSeries } from './metrics.ts';

/** metrics CLI 纯逻辑单测（range 语法糖 / series 汇总 / 人读格式）。 */

describe('parseRangeToMs', () => {
  it('parses days/hours/minutes', () => {
    expect(parseRangeToMs('7d')).toBe(7 * 86_400_000);
    expect(parseRangeToMs('24h')).toBe(24 * 3_600_000);
    expect(parseRangeToMs('30m')).toBe(30 * 60_000);
  });
  it('returns undefined for invalid spans', () => {
    expect(parseRangeToMs('7')).toBeUndefined();
    expect(parseRangeToMs('7w')).toBeUndefined();
    expect(parseRangeToMs('abc')).toBeUndefined();
  });
});

describe('resolveRange', () => {
  const NOW = Date.parse('2026-07-03T12:00:00.000Z');
  it('from/to override range', () => {
    const r = resolveRange({ metric: 'tokens', from: 'A', to: 'B', range: '7d' }, () => NOW);
    expect(r).toEqual({ from: 'A', to: 'B' });
  });
  it('range span computes from relative to now', () => {
    const r = resolveRange({ metric: 'tokens', range: '24h' }, () => NOW);
    expect(r.to).toBe(new Date(NOW).toISOString());
    expect(r.from).toBe(new Date(NOW - 86_400_000).toISOString());
  });
  it('defaults to 7 days when no range/from-to', () => {
    const r = resolveRange({ metric: 'tokens' }, () => NOW);
    expect(r.from).toBe(new Date(NOW - 7 * 86_400_000).toISOString());
  });
});

describe('sumSeries / formatMetricsHuman', () => {
  it('sums all points across series', () => {
    expect(
      sumSeries([
        {
          labels: {},
          points: [
            { t: 'a', v: 3 },
            { t: 'b', v: 4 },
          ],
        },
        { labels: {}, points: [{ t: 'c', v: 5 }] },
      ]),
    ).toBe(12);
  });
  it('formats labeled series with totals', () => {
    const text = formatMetricsHuman('tokens', {
      series: [{ labels: { model: 'glm-5.2' }, points: [{ t: 'x', v: 165 }] }],
    });
    expect(text).toContain('model=glm-5.2');
    expect(text).toContain('165');
  });
  it('formats empty as (no data)', () => {
    expect(formatMetricsHuman('cost', { series: [] })).toContain('no data');
  });
});
