/**
 * script action 执行（Proto §7 script 四条执行语义）——一次性隔离 isolate + grants 声明的平台 RPC stub。
 *
 * §7 规范（L775-780）：
 *  ① 脚本内容存 `context://automations/<id>`（可审计）——从 scriptRef 经 ContextRegistry.resolve +
 *     structured provider get 读出（测试可直接向 structured provider 写入脚本文本）。
 *  ② 到点在一次性隔离 Worker isolate（Code Mode / Dynamic Worker Loader，Reference §1.4）执行，
 *     只注入 grants 声明的平台接口绑定，凭证不进脚本运行时。
 *  ③ 脚本对平台的每次调用照常过 Authorizer.Check（principal=createdBy、链追加 cron:<jobId>、
 *     上限=job.action.grants，§6.4c 步骤 3）——权限只能衰减。
 *  ④ fired/completed 留痕（在 actions.ts）。
 *
 * 落地与降级（调研 §3）：
 *  - 真 isolate = Dynamic Worker Loader（env.LOADER.load）。本地 vitest-pool-workers 的 LOADER 绑定
 *    实测不可用（wrangler worker-loader binding 线上 open beta，本地 workerd 亦未在 pool-workers 暴露）——
 *    故 ScriptRunner 抽象为可注入接口：生产用 LoaderScriptRunner（部署侧真 isolate，留冒烟），
 *    测试注入 FakeScriptRunner（同一 watt binding 面 + 同一 Authorizer.Check 路径，验能力表与鉴权）。
 *  - env 注入 = grants 声明的平台 RPC stub。最小实现：注入一个 `watt` binding，支持 publish 一个能力
 *    （满足 DoD §7"查一个桩指标→Publish 出站事件"）；每次 publish 过 Authorizer.Check（cron 链段）。
 *    globalOutbound 禁网（LOADER 支持时）——凭证不进运行时。
 *
 * 能力表（watt binding，注释声明）：
 *  - publish(event): 经 Authorizer.Check(claims{cron:<jobId>}, event://<...>|platform://event, 'write'|'manage')
 *    → deny 则抛 permission_denied；allow 则 event-bus publish。最小面只暴露 publish（DoD 足够）；
 *    未来扩 metrics.read 等按同一 Check 门控接线。
 */

import {
  authorize,
  type SchedulerCronJob as CronJob,
  type Grant,
  type TokenClaims,
} from '@watt/core';
import { wattError } from '@watt/shared';
import { PolicyStore } from '../authz/policy-store.ts';
import type { Bindings } from '../env.ts';
import { publish } from '../event/event-bus.ts';
import { EventStore } from '../event/event-store.ts';

/** script 运行时注入给脚本的平台能力 binding（§7 步骤 2 grants 声明的接口）——最小面：publish。 */
export interface WattScriptBinding {
  /**
   * 发布一个平台事件（脚本出站）。每次调用过 Authorizer.Check（cron 链段，上限=job.grants）。
   * deny → 抛错（脚本感知 permission_denied）；allow → event-bus publish，返回 { eventId }。
   */
  publish(event: {
    type: string;
    payload?: unknown;
    session?: string;
  }): Promise<{ eventId: string }>;
}

/** 脚本执行的入参（runner 拿 binding + scriptRef 跑脚本）。 */
export interface ScriptRunContext {
  scriptRef: string;
  /** 注入脚本的平台能力（每次调用已内建 Authorizer.Check）。 */
  watt: WattScriptBinding;
  /** 脚本内容（已从 context://automations/<id> 读出；runner 负责在 isolate 里 eval/load 执行）。 */
  scriptSource: string;
}

/** 一次性隔离执行器抽象（生产=LOADER 真 isolate；测试=fake）。 */
export interface ScriptRunner {
  run(ctx: ScriptRunContext): Promise<unknown>;
}

export interface RunScriptArgs {
  env: Bindings;
  job: CronJob;
  /** 注入的 runner（缺省用 LOADER 真 isolate）。 */
  runner?: ScriptRunner;
  /** 运行时 claims 构造（principal=createdBy + cron:<jobId> 链段，actions.ts 提供）。 */
  buildClaims: () => Promise<TokenClaims>;
}

/**
 * 执行 script action（§7）：读脚本内容 → 构造 watt binding（内建 Check）→ 交 runner 在 isolate 执行。
 * runner 缺省 = LoaderScriptRunner（部署侧真 isolate）；本地测试注入 fake（LOADER 不可用，见文件头）。
 */
export async function runScriptAction(args: RunScriptArgs): Promise<unknown> {
  const { env, job } = args;
  if (job.action.kind !== 'script') return undefined;
  const claims = await args.buildClaims();
  const grants = job.action.grants;

  // ① 读脚本内容（context://automations/<id>）。
  const scriptSource = await resolveScriptSource(env, job.action.scriptRef);

  // 平台能力 binding：publish 每次过 Authorizer.Check（cron 链段，上限=job.grants）。
  const watt = buildWattBinding(env, job, claims, grants);

  const runner = args.runner ?? new LoaderScriptRunner(env);
  return runner.run({ scriptRef: job.action.scriptRef, watt, scriptSource });
}

/**
 * 构造 watt binding（§7 能力表）——每次 publish 过 core authorize（cron 链段判定，§6.4c 步骤 3）。
 * authorize 的 cronJobs 索引直接以本 job 播种（claims.chain=[cron:<jobId>]，上限=job.action.grants），
 * 无需外查 Scheduler.Get——本 job 就是链上唯一 cron 段，自足。
 */
function buildWattBinding(
  env: Bindings,
  job: CronJob,
  claims: TokenClaims,
  _grants: Grant[],
): WattScriptBinding {
  return {
    async publish(ev) {
      // 出站资源派生：脚本 publish 视为平台事件出站——按 §6.4c 以 event:// 出站面判定。
      // 最小实现：对 publish 能力做 platform://event 'manage' 的 Check（与平台 event Publish 同权面），
      //   cron 链段上限=job.action.grants（core authorize 步骤 3 据 cronJobs[jobId] 求该环上限）。
      const store = new PolicyStore(env.DB_POLICIES);
      const candidates = await store.resolveCandidatePolicies(claims);
      const decision = authorize({
        claims,
        resource: 'platform://event',
        action: 'manage',
        policies: candidates,
        agentDefs: {},
        // cron 链段判定：本 job 播种进 cronJobs 索引（chain=[cron:<jobId>]）。
        cronJobs: { [job.id]: job },
        instances: {},
      });
      if (!decision.allow) {
        throw wattError(
          'permission_denied',
          decision.reason ?? `script publish denied for cron:${job.id}`,
          false,
        );
      }
      const { Authorizer } = await import('../authz/authorizer.ts');
      const authorizer = new Authorizer(store);
      const result = await publish(
        {
          source: { kind: 'cron', ref: job.id },
          type: ev.type,
          payload: ev.payload,
          session: ev.session,
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
      if ('code' in result) throw new Error(`script publish failed: ${result.message}`);
      return { eventId: result.eventId };
    },
  };
}

/**
 * 读脚本内容（context://automations/<id>，§7 步骤 1）——ContextRegistry.resolve 找到挂载 provider，
 * structured provider get 读出文本。resolve 返回 { provider, path }（path 为 namespace 相对路径）；
 * namespace 从 URI 解析（挂载键 = context:// 后到 path 起点的前缀）。
 * 最小实现只支持 structured 承载（§7 automations 挂 structured；可扩 object）。
 * 本地测试可直接向 structured provider 写入脚本文本 + registry.write 挂载（见测试）。
 * 读失败 → 抛错（进 cron.completed.error）。
 */
async function resolveScriptSource(env: Bindings, scriptRef: string): Promise<string> {
  const registry = env.CONTEXT_REGISTRY.get(env.CONTEXT_REGISTRY.idFromName('registry'));
  const resolved = await registry.resolve(scriptRef);
  if ('code' in resolved) {
    throw new Error(`script content not resolvable: ${scriptRef} (${resolved.message})`);
  }
  if (resolved.provider !== 'structured') {
    throw new Error(`script provider unsupported: ${resolved.provider} (expect structured)`);
  }
  // namespace = context:// 后、去掉尾部相对 path 的前缀（resolveMount 已保证 path 是 uri 的后缀）。
  const stripped = scriptRef.replace(/^context:\/\//, '');
  const namespace =
    resolved.path.length > 0
      ? stripped.slice(0, stripped.length - resolved.path.length).replace(/\/$/, '')
      : stripped;
  const { StructuredContextProvider } = await import('../context/providers/structured.ts');
  const provider = new StructuredContextProvider(env.DB_CONTEXT, namespace);
  const entry = await provider.get(resolved.path);
  if ('code' in entry) {
    throw new Error(`script content not found: ${scriptRef} (${entry.message})`);
  }
  return typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content);
}

/**
 * 生产 ScriptRunner —— Dynamic Worker Loader（env.LOADER.load）一次性 isolate（§7 步骤 2，Reference §1.4）。
 * 本地 vitest-pool-workers 的 LOADER 绑定不可用（线上 open beta）——本类仅在部署侧走真 isolate，
 * 本地测试注入 FakeScriptRunner 替代。env 注入 = watt binding（Cap'n Web RPC，凭证不进运行时）+
 * globalOutbound:null 禁网。**未部署 loader 时 load 会抛**（部署冒烟核实 LOADER 可用性）。
 */
export class LoaderScriptRunner implements ScriptRunner {
  constructor(private readonly env: Bindings) {}

  async run(ctx: ScriptRunContext): Promise<unknown> {
    const loader = (this.env as unknown as { LOADER?: WorkerLoader }).LOADER;
    if (loader === undefined) {
      // 本地/未开通 loader：明确抛错（actions.ts 捕获进 cron.completed.error，DoD 集成项走 fake runner）。
      throw new Error(
        'Dynamic Worker Loader (env.LOADER) unavailable — script isolate requires deployed worker-loader binding (open beta)',
      );
    }
    // 部署侧：把脚本包成 module worker，env 注入 watt binding、断网。脚本 default export 一个
    //   async fn(watt)（约定入口）；load 一次性执行后回收（详见 Reference §1.4）。
    const worker = loader.get(`cron-script-${crypto.randomUUID()}`, async () => ({
      compatibilityDate: '2026-06-01',
      mainModule: 'script.js',
      modules: {
        'script.js': ctx.scriptSource,
      },
      env: { WATT: ctx.watt },
      globalOutbound: null, // 禁网（凭证不进运行时，只留 watt binding 的能力）。
    }));
    const stub = worker.getEntrypoint();
    // 约定：脚本导出 default { async run(watt) }——经 RPC 调用（Cap'n Web）。
    return (stub as unknown as { run(): Promise<unknown> }).run();
  }
}

/** WorkerLoader 绑定的最小类型面（@cloudflare/workers-types 尚未稳定导出，本地窄声明）。 */
interface WorkerLoader {
  get(
    id: string,
    factory: () => Promise<{
      compatibilityDate: string;
      mainModule: string;
      modules: Record<string, string>;
      env?: Record<string, unknown>;
      globalOutbound?: null;
    }>,
  ): { getEntrypoint(): unknown };
}
