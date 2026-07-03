/**
 * `watt cron list|create|trigger|rm`（Proto §7 Scheduler / DoD §7）。
 *
 * 挂载点：POST /htbp/platform/scheduler `{tool,arguments}`（复用 client.ts htbpCall）。
 * 动词映射（DoD §7：create→Write、rm→Delete）：
 *  - list    → List    arguments:{opts:{limit?}}                        → 裸 { items }（CronJob）
 *  - create  → Write   arguments:{job:{id,description,schedule,enabled,action}} → { job }（CronJob）
 *  - trigger → Trigger arguments:{jobId}                                 → { eventId }
 *  - rm      → Delete   arguments:{jobId}                                → { deleted:true }
 *  - get     → Get     arguments:{jobId}                                 → { job }（CronJob）
 *
 * action 三型（create --action-kind）：
 *  - publish：--event-type + --payload(json?) + --session?
 *  - agent  ：--definition + --input(json?) + --instance-by(singleton|event)?
 *  - script ：--script-ref + --grants(json：Grant[])
 *
 * createdBy 由 gateway 从 claims.sub 注入（非入参，防伪造）——create 的 job 体不含 createdBy。
 * 响应形状真源：gateway packages/gateway/test/platform-scheduler.test.ts（§34 禁双形态兜底）。
 */

import { type HttpDeps, htbpCall } from './client.ts';

/** CronJob 视图（list/create/get 展示）——createdBy 由 gateway 回填。 */
export interface CronJobView {
  id: string;
  description: string;
  schedule: string;
  enabled: boolean;
  action: Record<string, unknown>;
  createdBy: string;
}

interface CronJobPage {
  items: CronJobView[];
}

/** create 的 job 体（不含 createdBy，gateway 从 claims 注入）。 */
export interface CronJobInput {
  id: string;
  description: string;
  schedule: string;
  enabled: boolean;
  action: Record<string, unknown>;
}

export async function cronList(
  base: string,
  token: string,
  opts: { limit?: number },
  deps: HttpDeps = {},
): Promise<CronJobView[]> {
  const arg: { opts?: { limit?: number } } = {};
  if (opts.limit !== undefined) arg.opts = { limit: opts.limit };
  const body = (await htbpCall(base, token, 'scheduler', 'List', arg, deps)) as CronJobPage;
  return body.items;
}

export async function cronGet(
  base: string,
  token: string,
  jobId: string,
  deps: HttpDeps = {},
): Promise<CronJobView> {
  const body = (await htbpCall(base, token, 'scheduler', 'Get', { jobId }, deps)) as {
    job: CronJobView;
  };
  return body.job;
}

export async function cronCreate(
  base: string,
  token: string,
  job: CronJobInput,
  deps: HttpDeps = {},
): Promise<CronJobView> {
  const body = (await htbpCall(base, token, 'scheduler', 'Write', { job }, deps)) as {
    job: CronJobView;
  };
  return body.job;
}

export async function cronTrigger(
  base: string,
  token: string,
  jobId: string,
  deps: HttpDeps = {},
): Promise<{ eventId: string }> {
  return (await htbpCall(base, token, 'scheduler', 'Trigger', { jobId }, deps)) as {
    eventId: string;
  };
}

export async function cronRm(
  base: string,
  token: string,
  jobId: string,
  deps: HttpDeps = {},
): Promise<void> {
  await htbpCall(base, token, 'scheduler', 'Delete', { jobId }, deps);
}

/** 单个 job 的人类可读行（制表符分隔）。 */
export function formatCronLine(j: CronJobView): string {
  const kind = typeof j.action.kind === 'string' ? j.action.kind : '?';
  return `${j.id}\t${j.enabled ? 'on' : 'off'}\t${j.schedule}\t${kind}\t${j.description}`;
}

export function formatCronListHuman(jobs: CronJobView[]): string {
  if (jobs.length === 0) return '(no cron jobs)';
  return jobs.map(formatCronLine).join('\n');
}
