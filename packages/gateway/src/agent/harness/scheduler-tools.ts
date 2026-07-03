/**
 * manage/cron Agent 的 scheduler 工具面（R25 DoD④）——把 Scheduler.Write/List 暴露为模型可调工具。
 *
 * 设计（工具面选型 B，见调研 §3 / memory p6-manage-cron-agent）：不走 builtin Provider 树节点，
 *   而是 llm harness 的 agentic loop（AI SDK generateText tools）直接注入 scheduler_write/scheduler_list
 *   两工具，execute 在 gateway 进程内直调 SchedulerManager——比 A（树配置+tools-proxy 分派+上游 adapter）
 *   便宜且够 DoD④（manage/cron 只需建/看 CronJob）。
 *
 * 授权（M10 委托链 + §6.4d）：工具 execute 内先过 Authorizer.Check（platform://scheduler manage/read），
 *   claims = spawn/send 时透传进来的调用者 claims（agent 替 user 操作，principal 用委托链）。Check 经
 *   newAuthorizer 落一条 AuditRecord（R23，无需在此显式写审计）。deny → 工具返回错误对象（回喂模型，
 *   模型据此告知用户无权限），不抛异常（避免整个 harness failed）。
 *
 * createdBy 防伪造（§7）：CronJob.createdBy = claims.sub（非模型入参），与 routes.ts scheduler Write 同源。
 * cronJobSchema 校验入参（模型给的 job 体）——非法 → 工具错误对象回喂模型（自我修正）。
 */

import {
  type SchedulerCronJob as CronJob,
  schedulerCronJobSchema,
  type TokenClaims,
} from '@watt/core';
import type { WattError } from '@watt/shared';
import type { Authorizer } from '../../authz/authorizer.ts';
import { RES_SCHEDULER, type SchedulerManager } from '../../scheduler/scheduler-manager.ts';
import type { HarnessTool } from './types.ts';

/** WattError 判别（对齐 routes.ts/tools-proxy.ts 的本地 helper；@watt/shared 未导出 guard）。 */
function isWattError(v: unknown): v is WattError {
  return typeof v === 'object' && v !== null && 'code' in v && 'message' in v && 'retryable' in v;
}

/** scheduler 工具的依赖（注入以便测试：manager/authorizer 可 fake）。 */
export interface SchedulerToolsDeps {
  manager: SchedulerManager;
  authorizer: Authorizer;
  /** 调用者 claims（委托链）——createdBy = claims.sub，Check 主体。 */
  claims: TokenClaims;
  /** CronJob id 生成器（缺省 crypto.randomUUID）——模型未给 id 时用。 */
  genId?: () => string;
}

/** scheduler_write 入参 JSON Schema（模型据此构造 job；createdBy 由平台注入，不在此声明）。 */
const WRITE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: 'Optional stable job id (idempotent upsert). Omit to auto-generate.',
    },
    description: { type: 'string', description: 'Human-readable purpose of this cron job.' },
    schedule: {
      type: 'string',
      description:
        'Five-field minute-level cron expression in UTC (e.g. "0 9 * * *" = 09:00 UTC daily), or an ISO-8601 timestamp for a one-time run.',
    },
    enabled: { type: 'boolean', description: 'Whether the job fires on schedule (default true).' },
    action: {
      type: 'object',
      description:
        'What to do when fired. For a report, use kind="publish" with an event of a report type, e.g. {"kind":"publish","event":{"type":"report.daily.tokens","payload":{"target":"<chat>"}}}.',
    },
  },
  required: ['description', 'schedule', 'action'],
};

/** scheduler_list 入参 JSON Schema（只支持 limit，对齐 Hub.listJobs）。 */
const LIST_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    limit: { type: 'number', description: 'Max jobs to return (default 200).' },
  },
};

/** deny 决策 → 工具错误对象（回喂模型，不抛异常）。 */
function deniedResult(action: string, reason?: string): { error: string } {
  return {
    error: `permission denied: cannot ${action} on ${RES_SCHEDULER}${reason ? ` (${reason})` : ''}`,
  };
}

/**
 * 构造 manage/cron 的 scheduler 工具集（scheduler_write + scheduler_list）。
 * 每个 execute：先 Authorizer.Check（deny → 错误对象），再调 SchedulerManager；WattError → 错误对象。
 */
export function createSchedulerTools(deps: SchedulerToolsDeps): HarnessTool[] {
  const genId = deps.genId ?? (() => crypto.randomUUID());

  return [
    {
      name: 'scheduler_write',
      description:
        'Create or update a scheduled cron job. Use for requests like "send a daily token report at 9am". ' +
        'schedule is UTC (five-field cron or ISO timestamp). Returns the created job on success.',
      inputSchema: WRITE_INPUT_SCHEMA,
      async execute(args: Record<string, unknown>): Promise<unknown> {
        const decision = await deps.authorizer.check(deps.claims, RES_SCHEDULER, 'manage');
        if (!decision.allow) return deniedResult('manage', decision.reason);

        // createdBy = 调用者 principal（防伪造，§7）；id 缺省自动生成。
        const merged = {
          ...(args as Record<string, unknown>),
          id: typeof args.id === 'string' && args.id.length > 0 ? args.id : genId(),
          enabled: typeof args.enabled === 'boolean' ? args.enabled : true,
          createdBy: deps.claims.sub,
        };
        const parsed = schedulerCronJobSchema.safeParse(merged);
        if (!parsed.success) {
          return { error: `invalid cron job: ${parsed.error.message}` };
        }
        const written = await deps.manager.write(parsed.data);
        if (isWattError(written)) return { error: written.message };
        return { job: written };
      },
    },
    {
      name: 'scheduler_list',
      description:
        'List existing scheduled cron jobs. Use to check what jobs are already configured.',
      inputSchema: LIST_INPUT_SCHEMA,
      async execute(args: Record<string, unknown>): Promise<unknown> {
        const decision = await deps.authorizer.check(deps.claims, RES_SCHEDULER, 'read');
        if (!decision.allow) return deniedResult('read', decision.reason);

        const limit = typeof args.limit === 'number' ? args.limit : undefined;
        const page = await deps.manager.list(limit !== undefined ? { limit } : {});
        return { items: page.items as CronJob[] };
      },
    },
  ];
}
