/**
 * Metrics（Proto §10 Metrics.Query）——最小面查询服务（R23）。
 *
 * 数据源（调研 §3 选型）：
 *   - tokens/cost：D1 usage 表（watt-audit，GROUP BY provider/model/agent/day）——本地可测的聚合真源。
 *   - authz_denials：D1 audit_records 表（watt-audit，decision='deny' COUNT）。
 *   - events：D1 events 表（watt-events，occurred_at 范围 COUNT）。
 *   - tasks：D1 tasks 表（watt-events，created_at 范围 COUNT）。
 *   - agent_instances：usage 表 COUNT(DISTINCT instance)（做过模型调用的实例；实现声明——无持久实例
 *       注册表，DO 实例态不落 D1；DoD ③ 最小面足够）。
 *   - cache_hit_rate/tool_calls：本轮返回空 series（后续轮次接线，实现声明）。
 *
 * range{from,to}：ISO8601 时间窗（含 from 含 to）。groupBy 最小集：provider/model/agent/day。
 * 返回 MetricSeries[]{labels,points:[{t,v}]}（§10 形状）。AE 远端 SQL 查询留部署冒烟（@metrics）。
 */

import type { D1Database } from '@cloudflare/workers-types';

export const METRIC_NAMES = [
  'tokens',
  'cost',
  'cache_hit_rate',
  'agent_instances',
  'tasks',
  'events',
  'tool_calls',
  'authz_denials',
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export type GroupByDim = 'provider' | 'model' | 'agent' | 'channel' | 'day' | 'hour';

export interface MetricQuery {
  metric: MetricName;
  range: { from: string; to: string };
  groupBy?: GroupByDim[];
  filter?: Record<string, string>;
}

export interface MetricSeries {
  labels: Record<string, string>;
  points: { t: string; v: number }[];
}

/** usage 表列 → groupBy 维度的 SQL 表达式（day/hour 从 at 截取；agent=agent_def）。 */
const USAGE_GROUP_SQL: Record<string, string> = {
  provider: 'provider',
  model: 'model',
  agent: 'agent_def',
  day: 'substr(at, 1, 10)', // YYYY-MM-DD
  hour: 'substr(at, 1, 13)', // YYYY-MM-DDTHH
};

export class Metrics {
  constructor(
    private readonly dbAudit: D1Database,
    private readonly dbEvents: D1Database,
  ) {}

  async query(q: MetricQuery): Promise<MetricSeries[]> {
    switch (q.metric) {
      case 'tokens':
        return this.usageMetric(q, 'input_tokens + output_tokens');
      case 'cost':
        return this.usageMetric(q, 'COALESCE(cost, 0)');
      case 'agent_instances':
        return this.usageMetric(q, 'COUNT(DISTINCT instance)', true);
      case 'authz_denials':
        return this.countMetric(this.dbAudit, 'audit_records', 'at', q, "decision = 'deny'");
      case 'events':
        return this.countMetric(this.dbEvents, 'events', 'occurred_at', q);
      case 'tasks':
        return this.countMetric(this.dbEvents, 'tasks', 'created_at', q);
      // 本轮未接线（后续轮次）：返回空 series（不虚构数据）。
      case 'cache_hit_rate':
      case 'tool_calls':
        return [];
    }
  }

  /**
   * usage 表聚合（tokens=SUM/cost=SUM/agent_instances=COUNT DISTINCT）。
   * groupBy 决定 labels 维度；无 groupBy → 单 series（labels 空）。points 恒单点（窗内合计，t=range.to）。
   * isCount：agent_instances 的聚合表达式已含 COUNT（不再包 SUM）。
   */
  private async usageMetric(
    q: MetricQuery,
    valueExpr: string,
    isCount = false,
  ): Promise<MetricSeries[]> {
    const groupBy = (q.groupBy ?? []).filter((g) => g in USAGE_GROUP_SQL);
    const selectValue = isCount ? valueExpr : `SUM(${valueExpr})`;
    const groupCols = groupBy.map((g) => USAGE_GROUP_SQL[g]);
    const selectCols = groupCols.map((col, i) => `${col} AS g${i}`);
    const select =
      selectCols.length > 0
        ? `${selectCols.join(', ')}, ${selectValue} AS v`
        : `${selectValue} AS v`;
    const groupClause = groupCols.length > 0 ? `GROUP BY ${groupCols.join(', ')}` : '';
    const sql = `SELECT ${select} FROM usage WHERE at >= ? AND at <= ? ${groupClause}`;
    const rows = await this.dbAudit
      .prepare(sql)
      .bind(q.range.from, q.range.to)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map((row) => {
      const labels: Record<string, string> = {};
      groupBy.forEach((g, i) => {
        labels[g] = String(row[`g${i}`] ?? '');
      });
      return { labels, points: [{ t: q.range.to, v: Number(row.v ?? 0) }] };
    });
  }

  /**
   * 计数指标（events/tasks/authz_denials）——范围内 COUNT，可带额外 WHERE 条件。
   * groupBy=day/hour 时按时间段分桶（其余维度本轮不拆，单 series）。
   */
  private async countMetric(
    db: D1Database,
    table: string,
    atCol: string,
    q: MetricQuery,
    extraWhere?: string,
  ): Promise<MetricSeries[]> {
    const where = [`${atCol} >= ?`, `${atCol} <= ?`];
    if (extraWhere) where.push(extraWhere);
    const groupBy = (q.groupBy ?? []).filter((g) => g === 'day' || g === 'hour');
    const bucket = groupBy.includes('hour') ? 13 : groupBy.includes('day') ? 10 : 0;
    if (bucket > 0) {
      const sql = `SELECT substr(${atCol}, 1, ${bucket}) AS bucket, COUNT(*) AS v
                   FROM ${table} WHERE ${where.join(' AND ')} GROUP BY bucket ORDER BY bucket`;
      const rows = await db
        .prepare(sql)
        .bind(q.range.from, q.range.to)
        .all<{ bucket: string; v: number }>();
      const dim = groupBy.includes('hour') ? 'hour' : 'day';
      return (rows.results ?? []).map((r) => ({
        labels: { [dim]: r.bucket },
        points: [{ t: r.bucket, v: Number(r.v) }],
      }));
    }
    const sql = `SELECT COUNT(*) AS v FROM ${table} WHERE ${where.join(' AND ')}`;
    const row = await db.prepare(sql).bind(q.range.from, q.range.to).first<{ v: number }>();
    return [{ labels: {}, points: [{ t: q.range.to, v: Number(row?.v ?? 0) }] }];
  }
}
