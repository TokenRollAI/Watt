/**
 * Scheduler 服务层（Proto §7）——编排单例 SchedulerHub DO（Agents SDK Agent + this.schedule）。
 *
 * 动词（§7 L742-749）：List/Get/Write(job)/Update(jobId,patch)/Trigger(jobId)→{eventId}/Delete。
 * 单例 Hub（getAgentByName(env.SCHEDULER_HUB, 'hub')，附B SchedulerHub）承载全部 CronJob +
 *   到点 schedule 登记。服务层只做 stub 转调 + WattError 透传（校验在路由侧 cronJobSchema，
 *   表达式校验在 Hub 内 core parseCronSchedule）。
 *
 * RPC 收窄：getAgentByName 返回的 stub 判别式方法收窄成 never（toolchain-pitfalls §31），
 *   以 SchedulerHubRpc 接口 cast。
 */

import type { SchedulerCronJob as CronJob } from '@watt/core';
import type { WattError } from '@watt/shared';
import { getAgentByName } from 'agents';
import type { Bindings } from '../env.ts';
import type { SchedulerHub, SchedulerHubRpc, TriggerResult } from './scheduler-hub.ts';

/** 单例 Hub stub（Agents SDK getAgentByName 恒路由同名实例，'hub'）。 */
async function hubStub(env: Bindings): Promise<SchedulerHubRpc> {
  const stub = await getAgentByName<Cloudflare.Env, SchedulerHub>(env.SCHEDULER_HUB, 'hub');
  return stub as unknown as SchedulerHubRpc;
}

export class SchedulerManager {
  constructor(private readonly env: Bindings) {}

  /** Write（§7）——校验 + 登记 schedule + 存 job（Hub 内）。非法表达式 → invalid_argument。 */
  async write(job: CronJob): Promise<CronJob | WattError> {
    return (await hubStub(this.env)).writeJob(job);
  }

  /** Update（§7）——合并 patch + 重排 schedule。不存在 → not_found。 */
  async update(jobId: string, patch: Partial<CronJob>): Promise<CronJob | WattError> {
    return (await hubStub(this.env)).updateJob(jobId, patch);
  }

  /** Delete（§7）——取消 schedule + 删行（幂等）。 */
  async delete(jobId: string): Promise<void> {
    await (await hubStub(this.env)).deleteJob(jobId);
  }

  /** Get（§7）——读 job（不存在 → not_found）。 */
  async get(jobId: string): Promise<CronJob | WattError> {
    return (await hubStub(this.env)).getJob(jobId);
  }

  /** List（§7）——全部 job。 */
  async list(opts: { limit?: number } = {}): Promise<{ items: CronJob[] }> {
    return (await hubStub(this.env)).listJobs(opts);
  }

  /** Trigger（§7）——手动触发一次，返回本次 cron.fired 的 eventId。不存在 → not_found。 */
  async trigger(jobId: string): Promise<TriggerResult | WattError> {
    return (await hubStub(this.env)).triggerJob(jobId);
  }
}
