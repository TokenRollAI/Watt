/**
 * UsageStore（Proto §10 Metrics token/cost 明细）——D1 usage 表（库 watt-audit，binding DB_AUDIT）。
 * 每次真实模型调用（llm harness）写一行；Metrics.Query metric=tokens/cost 走本表聚合（GROUP BY）。
 *
 * 选型（调研 §3）：token/cost 用 D1 usage 聚合表（本地 vitest 可完整测）+ AE writeDataPoint 并行打点
 *   （高基数时序，本地 no-op 只能 spy）。本表是本地可测的聚合真源。
 */

import type { AnalyticsEngineDataset, D1Database } from '@cloudflare/workers-types';

/** 一行模型调用用量。 */
export interface UsageRecord {
  provider: string;
  model: string;
  agentDef?: string;
  instance?: string;
  inputTokens: number;
  outputTokens: number;
  cost?: number;
}

export class UsageStore {
  constructor(private readonly db: D1Database) {}

  /** 写一行 usage（模型调用后）。id/at 由 store 生成。 */
  async write(r: UsageRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO usage
           (id, at, provider, model, agent_def, instance, input_tokens, output_tokens, cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        new Date().toISOString(),
        r.provider,
        r.model,
        r.agentDef ?? null,
        r.instance ?? null,
        r.inputTokens,
        r.outputTokens,
        r.cost ?? null,
      )
      .run();
  }
}

/**
 * AE 并行打点（Architecture M9 时序采集面）——写一个 usage data point。
 * 本地 miniflare/workerd：writeDataPoint 是 no-op（无本地 SQL 查询，单测只能 spy binding），
 *   真实查询走远端 AE SQL API（留部署冒烟 @metrics）；绑定缺省（AE 绑定无需 provision，写入自建 dataset）
 *   时跳过（AE_METRICS 可选）。blobs/doubles 顺序固定（远端 SQL 按位置索引）。
 */
export function writeUsageDataPoint(ae: AnalyticsEngineDataset | undefined, r: UsageRecord): void {
  if (ae === undefined) return;
  try {
    ae.writeDataPoint({
      // blobs：维度（provider/model/agent_def/instance）——按位置固定顺序（远端 SQL blob1..blobN）。
      blobs: [r.provider, r.model, r.agentDef ?? '', r.instance ?? ''],
      // doubles：度量（input/output tokens + cost）。
      doubles: [r.inputTokens, r.outputTokens, r.cost ?? 0],
      // index：采样键（按 provider 采样）。
      indexes: [r.provider],
    });
  } catch (err) {
    // AE 打点 best-effort（不阻塞模型调用路径）。
    console.error('metrics: AE writeDataPoint failed', { err: String(err) });
  }
}
