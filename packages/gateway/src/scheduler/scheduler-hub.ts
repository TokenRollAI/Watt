/**
 * SchedulerHub —— Scheduler（Proto §7 / M6）的 CronJob 宿主 + 到点触发引擎。
 *
 * 落地 = Cloudflare Agents SDK 的 `Agent<Env, State>` 基类（LOOP 纪律 4 成熟框架表：
 * "调度 → Agents SDK this.schedule，不手写 DO alarm"）。全部 CronJob 存单例 Hub DO
 * （getAgentByName(env.SCHEDULER_HUB, 'hub')，附B SchedulerHub）；this.schedule() 承载到点/一次性
 * 触发的 alarm 登记（cron 表达式 或 Date），回调 fire(jobId) 走三 action 执行路径。
 *
 * CronJob 持久化 = Agent 内嵌 SQLite（this.sql 模板标签）——与 AgentInstance 的 setState 不同，
 * CronJob 是「多行表」而非「单实例状态」，故用 this.sql 建表存 job 行（不放 this.state 单对象）。
 * schedule 登记键：schedule 返回的 Schedule.id 与 jobId 一一对应存 job 行，Update/Delete 时 cancelSchedule。
 *
 * 规范面（§7 六动词 + Trigger）：
 *  - Write(job)：cronJobSchema 校验（路由侧）→ core parseCronSchedule 校验表达式 → this.schedule 登记
 *    回调（cron 表达式用 cron 型、ISO 一次性用 Date 型 scheduled）→ 存 job 行；enabled=false 不登记 schedule。
 *  - Update(jobId, patch)：合并 patch → 重排 schedule（schedule/enabled 变化 → cancelSchedule 旧的 +
 *    重新登记）；仅元信息（description）变化不动 schedule。
 *  - Delete(jobId)：cancelSchedule + 删 job 行。
 *  - List / Get：读 job 行。
 *  - Trigger(jobId)：手动触发一次，与到点同路径（不影响原计划）→ { eventId }（本次 cron.fired 的 id）。
 *
 * 到点/Trigger 执行经 actions.ts（fire→ ① publish cron.fired ② 执行 action ③ publish cron.completed）。
 * this.schedule 的回调必须是本类方法名（keyof this）——回调 onCronFire 从 payload 取 jobId 走 executeJob。
 *
 * 注（RPC 收窄）：getAgentByName 返回的 stub 判别式方法会收窄成 never（toolchain-pitfalls §31），
 *   调用侧以 SchedulerHubRpc 接口 cast。
 */

import { type SchedulerCronJob as CronJob, parseCronSchedule } from '@watt/core';
import { type WattError, wattError } from '@watt/shared';
import { Agent } from 'agents';
import type { Bindings } from '../env.ts';
import { executeCronAction, type ScriptRunner } from './actions.ts';

/**
 * 一次性 ISO 时刻已过期判定（gateway-local，不改 core parseCronSchedule 的纯语法契约）。
 * parsed 为 cron 型或已过语法校验的 once → 只对 once 且 at <= now 返回 invalid_argument，否则 undefined。
 */
function expiredOnce(
  parsed: Exclude<ReturnType<typeof parseCronSchedule>, WattError>,
): WattError | undefined {
  if (!('kind' in parsed) || parsed.kind !== 'once') return undefined;
  if (Date.parse(parsed.at) <= Date.now()) {
    return wattError('invalid_argument', `one-time schedule is in the past: ${parsed.at}`, false);
  }
  return undefined;
}

/** Hub 无单实例状态（CronJob 存 SQL 表）——state 仅占位。 */
export interface SchedulerHubState {
  initialized: boolean;
}

/** schedule 回调 payload（this.schedule 到点回传给 onCronFire）。 */
interface CronFirePayload {
  jobId: string;
}

/** CronJob SQLite 行（job JSON + schedule 登记键）。 */
interface CronJobRow {
  id: string;
  job_json: string;
  schedule_id: string | null;
}

/** Trigger/执行返回（本次 cron.fired 的 eventId）。 */
export interface TriggerResult {
  eventId: string;
}

/**
 * SchedulerHub 的 DO RPC 面（平台侧调用契约）——判别式方法经 RPC 包装收窄成 never
 * （toolchain-pitfalls §31），调用侧以此接口 cast。
 */
export interface SchedulerHubRpc {
  writeJob(job: CronJob): Promise<CronJob | WattError>;
  updateJob(jobId: string, patch: Partial<CronJob>): Promise<CronJob | WattError>;
  deleteJob(jobId: string): Promise<void>;
  getJob(jobId: string): Promise<CronJob | WattError>;
  listJobs(opts?: { limit?: number }): Promise<{ items: CronJob[] }>;
  triggerJob(jobId: string): Promise<TriggerResult | WattError>;
}

export class SchedulerHub extends Agent<Cloudflare.Env, SchedulerHubState> {
  override initialState: SchedulerHubState = { initialized: false };

  /** 测试注入的 ScriptRunner（真 isolate 本地不可用时用 fake）——见 actions.ts。
   *  不进 RPC 面（函数不可跨 DO 边界序列化）：测试用 runInDurableObject 拿 instance 直接设。 */
  scriptRunner?: ScriptRunner;

  /** 惰性建表（CronJob 多行表；与 Agent 基类 state 表并存）。 */
  private ensureTable(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        job_json TEXT NOT NULL,
        schedule_id TEXT
      )
    `;
  }

  /**
   * Write（§7）——校验表达式 → 登记/取消 schedule → 存 job 行（幂等 upsert，同 id 覆盖 + 重排 schedule）。
   * 表达式非法 → invalid_argument（不存、不登记）。enabled=false → 存行但不登记 schedule（禁用不触发）。
   */
  async writeJob(job: CronJob): Promise<CronJob | WattError> {
    this.ensureTable();
    const parsed = parseCronSchedule(job.schedule);
    if ('code' in parsed) return parsed; // 非法 cron/ISO → invalid_argument。
    // 一次性 ISO 且已过期 → invalid_argument（登记过去时刻的 schedule 无意义/立即触发）。
    // core parseCronSchedule 只校验语法不校验时序，过期判定放 gateway（不改 core）；仅 enabled
    //   时拒（禁用不登记 schedule，与"过去 once 无法有效触发"边界一致）。
    if (job.enabled) {
      const expired = expiredOnce(parsed);
      if (expired !== undefined) return expired;
    }

    // 已存在同 id：先取消旧 schedule（重排）。
    const existing = this.readRow(job.id);
    if (existing?.schedule_id) {
      await this.cancelScheduleSafe(existing.schedule_id, job.id);
    }

    const scheduleId = job.enabled ? await this.registerSchedule(job) : null;
    this.sql`
      INSERT INTO cron_jobs (id, job_json, schedule_id)
      VALUES (${job.id}, ${JSON.stringify(job)}, ${scheduleId})
      ON CONFLICT(id) DO UPDATE SET job_json = excluded.job_json, schedule_id = excluded.schedule_id
    `;
    return job;
  }

  /**
   * Update（§7）——合并 patch → 若 schedule/enabled/action 变化则重排 schedule。
   * id 不可改（patch.id 忽略）。表达式变更后非法 → invalid_argument（不落库、保留原 job）。
   */
  async updateJob(jobId: string, patch: Partial<CronJob>): Promise<CronJob | WattError> {
    this.ensureTable();
    const row = this.readRow(jobId);
    if (row === undefined) return wattError('not_found', `cron job not found: ${jobId}`, false);
    const current = JSON.parse(row.job_json) as CronJob;
    const next: CronJob = { ...current, ...patch, id: jobId };

    const parsed = parseCronSchedule(next.schedule);
    if ('code' in parsed) return parsed;
    if (next.enabled) {
      const expired = expiredOnce(parsed);
      if (expired !== undefined) return expired;
    }

    // schedule/enabled/action 变化 → 取消旧 schedule 后按新状态重排（enabled=false → 不登记）。
    const needsReschedule =
      next.schedule !== current.schedule ||
      next.enabled !== current.enabled ||
      JSON.stringify(next.action) !== JSON.stringify(current.action);
    let scheduleId = row.schedule_id;
    if (needsReschedule) {
      if (row.schedule_id) await this.cancelScheduleSafe(row.schedule_id, jobId);
      scheduleId = next.enabled ? await this.registerSchedule(next) : null;
    }
    this
      .sql`UPDATE cron_jobs SET job_json = ${JSON.stringify(next)}, schedule_id = ${scheduleId} WHERE id = ${jobId}`;
    return next;
  }

  /** Delete（§7）——取消 schedule + 删行（幂等：不存在也返回）。 */
  async deleteJob(jobId: string): Promise<void> {
    this.ensureTable();
    const row = this.readRow(jobId);
    if (row === undefined) return;
    if (row.schedule_id) await this.cancelScheduleSafe(row.schedule_id, jobId);
    this.sql`DELETE FROM cron_jobs WHERE id = ${jobId}`;
  }

  /** Get（§7）——读 job 行（不存在 → not_found）。 */
  async getJob(jobId: string): Promise<CronJob | WattError> {
    this.ensureTable();
    const row = this.readRow(jobId);
    if (row === undefined) return wattError('not_found', `cron job not found: ${jobId}`, false);
    return JSON.parse(row.job_json) as CronJob;
  }

  /** List（§7）——读全部 job 行（limit 默认 200）。 */
  async listJobs(opts: { limit?: number } = {}): Promise<{ items: CronJob[] }> {
    this.ensureTable();
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
    const rows = this.sql<CronJobRow>`SELECT * FROM cron_jobs ORDER BY id LIMIT ${limit}`;
    return { items: rows.map((r) => JSON.parse(r.job_json) as CronJob) };
  }

  /**
   * Trigger（§7）——手动触发一次，与到点同路径（不影响原计划）。返回本次 cron.fired 的 eventId。
   * 禁用 job 仍可手动 Trigger（调试/补跑语义，§7 Trigger 注释"立即手动触发一次"未限 enabled）——
   *   实现声明：Trigger 不检查 enabled（enabled 只关到点自动触发，手动补跑不受限）。
   */
  async triggerJob(jobId: string): Promise<TriggerResult | WattError> {
    this.ensureTable();
    const row = this.readRow(jobId);
    if (row === undefined) return wattError('not_found', `cron job not found: ${jobId}`, false);
    const job = JSON.parse(row.job_json) as CronJob;
    return this.executeJob(job, 'manual');
  }

  /**
   * this.schedule 到点回调（keyof this）——从 payload 取 jobId，走 executeJob。
   * job 已删除（读不到行）→ 静默跳过（Delete 已 cancelSchedule，此为竞态防御）。
   */
  async onCronFire(payload: CronFirePayload): Promise<void> {
    this.ensureTable();
    const row = this.readRow(payload.jobId);
    if (row === undefined) return; // 已删除，跳过。
    const job = JSON.parse(row.job_json) as CronJob;
    if (job.enabled === false) return; // 禁用期间不自动触发（防御）。
    await this.executeJob(job, 'scheduled');
  }

  // ─── 内部 ────────────────────────────────────────────────────────────────

  /** 到点/Trigger 统一执行（三 action + 双留痕），委托 actions.ts。 */
  private async executeJob(
    job: CronJob,
    trigger: 'scheduled' | 'manual',
  ): Promise<TriggerResult | WattError> {
    return executeCronAction({
      env: this.env as Bindings,
      job,
      trigger,
      scriptRunner: this.scriptRunner,
    });
  }

  /** 登记 schedule（cron 表达式用 cron 型；ISO 一次性用 Date 型 scheduled）。返回 Schedule.id。 */
  private async registerSchedule(job: CronJob): Promise<string> {
    const parsed = parseCronSchedule(job.schedule);
    // 已在调用前校验合法，此处必为 ParsedSchedule。
    const payload: CronFirePayload = { jobId: job.id };
    if ('kind' in parsed && parsed.kind === 'once') {
      const when = new Date(Date.parse(parsed.at));
      const s = await this.schedule(when, 'onCronFire', payload);
      return s.id;
    }
    // cron 型：直接把原始 cron 表达式交给 Agents SDK（其内部 cron-schedule 解析）。
    const s = await this.schedule(job.schedule, 'onCronFire', payload);
    return s.id;
  }

  /**
   * cancelSchedule 幂等封装（schedule 已触发/不存在 → 不抛，保持 Write/Update/Delete 幂等）。
   * 失败只提升可观测（console.error 带 jobId/scheduleId 上下文）——不改返回形状，调用侧继续重排/删行。
   */
  private async cancelScheduleSafe(scheduleId: string, jobId: string): Promise<void> {
    try {
      await this.cancelSchedule(scheduleId);
    } catch (err) {
      console.error('scheduler hub: cancelSchedule failed (non-fatal, continuing)', {
        jobId,
        scheduleId,
        err: String(err),
      });
    }
  }

  /** 读单行（不存在 → undefined）。 */
  private readRow(jobId: string): CronJobRow | undefined {
    const rows = this.sql<CronJobRow>`SELECT * FROM cron_jobs WHERE id = ${jobId}`;
    return rows[0];
  }
}
