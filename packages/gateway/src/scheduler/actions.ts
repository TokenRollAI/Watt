/**
 * Cron action 执行 + 双留痕（Proto §7 三 action / script 四条执行语义）——SchedulerHub 到点/Trigger 调用。
 *
 * 到点/Trigger 统一路径（§7 L757-759 / L775-780）：
 *   ① Publish `cron.fired`（payload={jobId, scheduledAt, actionKind}）——恒发，返回其 eventId；
 *   ② 执行 action：
 *      - publish：event-bus publish（principal=createdBy，claims 由 IdentityMapper 实时解析，
 *        source.kind='cron'）。cron.fired/completed 之外的纯发事件，做什么由订阅决定。
 *      - agent：AgentRuntime.spawn（instanceBy singleton|event → instanceKey）+ input（即发即忘，
 *        与 CronJob 的 agent action 语义"等价 Spawn/Send + input"一致）。
 *      - script：见 script-runner.ts（一次性隔离 isolate + grants 声明的平台 RPC stub，
 *        每次调用过 Authorizer.Check，链追加 cron:<jobId> 系统段，§6.4c 步骤 3）。
 *   ③ Publish `cron.completed`（script/agent 必发，含结果/错误；publish 动作亦发以统一留痕面）。
 *
 * claims 构造（§7 步骤 3 / §6.4c 步骤 3）：principal=job.createdBy，roles 由
 *   IdentityMapper.ResolvePrincipal 触发时实时解析（权限被收窄后 job 自然失效，无僵尸授权）；
 *   script 的每次平台调用经 Authorizer.Check，claims.chain 追加 `cron:<jobId>` 系统段——上限即
 *   job.action.grants（core authorize 步骤 3 已实现该段判定，此处只需传对 chain + cronJobs 索引）。
 *   **Write 时不做 grants≤createdBy 静态校验**（§7 步骤 3，推迟到运行时）。
 */

import { type SchedulerCronJob as CronJob, normalizeEvent, type TokenClaims } from '@watt/core';
import type { WattError } from '@watt/shared';
import { AgentRuntime, defaultRuntimeDeps } from '../agent/agent-runtime.ts';
import { Authorizer } from '../authz/authorizer.ts';
import { IdentityMapper } from '../authz/identity-mapper.ts';
import { PolicyStore } from '../authz/policy-store.ts';
import type { Bindings } from '../env.ts';
import { EventStore } from '../event/event-store.ts';
import { runScriptAction, type ScriptRunner } from './script-runner.ts';

export type { ScriptRunner } from './script-runner.ts';

const CRON_FIRED_TYPE = 'cron.fired';
const CRON_COMPLETED_TYPE = 'cron.completed';

export interface ExecuteArgs {
  env: Bindings;
  job: CronJob;
  /** 触发来源（scheduled=到点自动 / manual=Trigger 手动补跑）——留痕注记，不改执行语义。 */
  trigger: 'scheduled' | 'manual';
  /** 测试注入的 ScriptRunner（真 isolate 本地不可用时用 fake）；缺省用 LOADER 真 isolate（部署侧）。 */
  scriptRunner?: ScriptRunner;
}

export interface ExecuteResult {
  eventId: string;
}

/**
 * 执行一个 CronJob 的 action（三 action + 双留痕）。返回本次 cron.fired 的 eventId（§7 Trigger 返回）。
 * 执行失败（action 内部错）不阻塞 cron.completed 留痕——错误摘要进 completed payload（§7 步骤 4）。
 */
export async function executeCronAction(args: ExecuteArgs): Promise<ExecuteResult | WattError> {
  const { env, job, trigger } = args;
  const scheduledAt = new Date().toISOString();

  // ① cron.fired（恒发）——source.kind='cron'（§1 EventSource），留痕 + 入队。
  // payload 的 `trigger` 字段为 additive 扩展（§7 规范 payload={jobId,scheduledAt,actionKind}），
  //   仅为留痕区分 scheduled/manual 补跑，不改事件形状契约，订阅方可安全忽略。
  const firedEvent = normalizeEvent(
    {
      source: { kind: 'cron', ref: job.id },
      type: CRON_FIRED_TYPE,
      payload: { jobId: job.id, scheduledAt, actionKind: job.action.kind, trigger },
    },
    {
      genId: () => crypto.randomUUID(),
      now: () => scheduledAt,
      genTraceId: () => crypto.randomUUID(),
    },
  );
  await new EventStore(env.DB_EVENTS).put(firedEvent);
  await env.QUEUE_EVENTS.send(firedEvent);
  const eventId = firedEvent.id;

  // ② 执行 action，收集结果/错误摘要供 cron.completed。
  let completedPayload: Record<string, unknown>;
  try {
    const outcome = await runAction(args);
    completedPayload = { jobId: job.id, actionKind: job.action.kind, ok: true, result: outcome };
  } catch (err) {
    completedPayload = {
      jobId: job.id,
      actionKind: job.action.kind,
      ok: false,
      // WattError 是纯对象（跨 RPC 边界非 Error 实例），String() 会得 [object Object]——取 message/code。
      error:
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null && 'message' in err
            ? String((err as { message: unknown }).message)
            : String(err),
    };
  }

  // ③ cron.completed（script/agent 必发；publish 动作亦发以统一留痕面，§7 步骤 4）。
  const completedEvent = normalizeEvent(
    {
      source: { kind: 'cron', ref: job.id },
      type: CRON_COMPLETED_TYPE,
      payload: completedPayload,
    },
    {
      genId: () => crypto.randomUUID(),
      now: () => new Date().toISOString(),
      genTraceId: () => crypto.randomUUID(),
      traceId: firedEvent.traceId, // 链路透传（§0.3）：completed 与 fired 同 trace。
    },
  );
  // completed 留痕是 best-effort：fired 已发、action 已执行（副作用已落地）。若此处抛错向上传播，
  //   Agents SDK 会重跑整个 onCronFire → action 二次执行（重复副作用）。宁缺一条 completed 留痕，
  //   也不重放已执行的 action——留痕失败只 console.error（不改幂等语义/返回形状）。
  try {
    await new EventStore(env.DB_EVENTS).put(completedEvent);
    await env.QUEUE_EVENTS.send(completedEvent);
  } catch (err) {
    console.error('scheduler: cron.completed persistence failed (best-effort, not retried)', {
      jobId: job.id,
      actionKind: job.action.kind,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return { eventId };
}

/** 分派三 action（返回值进 cron.completed.result）。 */
async function runAction(args: ExecuteArgs): Promise<unknown> {
  const { env, job } = args;
  switch (job.action.kind) {
    case 'publish':
      return runPublishAction(env, job);
    case 'agent':
      return runAgentAction(env, job);
    case 'script':
      return runScriptAction({
        env,
        job,
        runner: args.scriptRunner,
        buildClaims: () => resolveCronClaims(env, job),
      });
  }
}

/**
 * publish action（§7）：纯发事件——经 event-bus publish（source.kind='cron'，principal=createdBy）。
 * 做什么由订阅决定；返回 { eventId } 进 completed.result。
 */
async function runPublishAction(env: Bindings, job: CronJob): Promise<unknown> {
  if (job.action.kind !== 'publish') return undefined;
  const { publish } = await import('../event/event-bus.ts');
  const claims = await resolveCronClaims(env, job);
  const authorizer = new Authorizer(new PolicyStore(env.DB_POLICIES));
  const result = await publish(
    {
      source: { kind: 'cron', ref: job.id },
      type: job.action.event.type,
      payload: job.action.event.payload,
      session: job.action.event.session,
      principal: claims.sub,
    },
    {
      store: new EventStore(env.DB_EVENTS),
      authorizer,
      queue: { send: async (event) => void (await env.QUEUE_EVENTS.send(event)) },
      claims,
      genId: () => crypto.randomUUID(),
      now: () => new Date().toISOString(),
      genTraceId: () => crypto.randomUUID(),
    },
  );
  if ('code' in result) throw new Error(`publish action failed: ${result.message}`);
  return { eventId: result.eventId };
}

/**
 * agent action（§7）：等价 Spawn + input（即发即忘，无 expect）。instanceBy singleton|event → instanceKey。
 * event 型：以 job.id + 触发时刻构造唯一键（每次触发新实例）；singleton（缺省）：稳定键（同 job 复用实例）。
 */
async function runAgentAction(env: Bindings, job: CronJob): Promise<unknown> {
  if (job.action.kind !== 'agent') return undefined;
  const runtime = new AgentRuntime(defaultRuntimeDeps(env));
  const instanceBy = job.action.instanceBy ?? 'singleton';
  const instanceKey =
    instanceBy === 'event' ? `cron:${job.id}#${crypto.randomUUID()}` : `cron:${job.id}#singleton`;
  const res = await runtime.spawn({
    definition: job.action.definition,
    instanceKey,
    input: job.action.input,
  });
  if ('code' in res) throw new Error(`agent action spawn failed: ${res.message}`);
  return { instanceId: res.instance.instanceId };
}

/**
 * 构造 cron 触发的运行时 claims（§7 步骤 3 / §6.4c 步骤 3）。
 * principal = job.createdBy；roles 经 IdentityMapper.ResolvePrincipal 触发时实时解析；
 * chain 追加 `cron:<jobId>` 系统段（script 每次平台调用的 Authorizer.Check 据此把 job.action.grants
 *   作为该环上限——core authorize 步骤 3 已实现，Authorizer 需能查到本 job）。
 */
async function resolveCronClaims(env: Bindings, job: CronJob): Promise<TokenClaims> {
  const resolved = await new IdentityMapper(env.DB_POLICIES).resolvePrincipal(job.createdBy);
  return {
    sub: job.createdBy,
    roles: resolved.roles,
    chain: [`cron:${job.id}`],
  };
}
