/**
 * QuickJS WASM 沙箱 + journal 重放引擎：PlanScript 执行模型的心脏。
 *
 * 执行模型（见 architecture/execution-model.md「Script Runner」）：脚本每次从头在
 * QuickJS 中执行；已完成的 Host 调用（journal 中有 result）立即 resolve 缓存结果；
 * 用 executePendingJobs 把微任务驱动到静止态；静止后仍未 resolve 的 Host 调用即
 * pending frontier（下一批待执行调用）。
 *
 * 两道确定性防线在此汇合：
 * - 第一道：静态校验（validate.ts），脚本进沙箱前已禁掉动态代码与非确定性全局名。
 * - 第二道：沙箱屏蔽，下面在 context 初始化时删除 Date / Math.random 等非确定性能力。
 *
 * gas 计量 + wall-clock 超时：runtime.setInterruptHandler 既数「中断回调次数」当作
 * gas（QuickJS 不暴露真实指令计数，回调频率与执行步数单调相关，足以截停死循环），
 * 又比对宿主 wall-clock 截止时间。任一超限即返回 true 让解释器中止当前执行。
 *
 * 关键不变量：相同 journal 必然产出相同的下一批 pending 调用（seq/fn/params 全等）。
 */
import {
  getQuickJS,
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten';
import type { HostFunction, JournalEntry } from '@watt/protocol';
import { HOST_FUNCTIONS, JournalEntry as JournalEntrySchema } from '@watt/protocol';
import { validatePlanScript } from './validate.js';
import { wrapSource } from './entry.js';
import { handleToJson, jsonToHandle } from './marshal.js';
import { normalizeHostParams, paramsEqual } from './host-bridge.js';
import type { PendingCall, ReplayOptions, ReplayResult } from './types.js';

/**
 * 默认 gas 上限。这里的「gas」以 interrupt handler 的回调次数近似——QuickJS 不暴露
 * 真实指令计数，但回调频率与执行步数单调相关，足以截停死循环。回调频率随构建而异
 * （本 release build 约每毫秒 6~7 次），故 gas 是「指令级」量纲的代理量，wall-clock
 * 超时是与之独立的硬兜底。生产侧应按基准实测校准 gasLimit；调用方传显式值时以其为准。
 */
const DEFAULT_GAS_LIMIT = 5_000_000;
/** 默认单次重放墙钟超时（宿主侧硬兜底）。重放本应毫秒级，给足冗余。 */
const DEFAULT_WALL_CLOCK_MS = 10_000;
/** 默认沙箱内存上限。 */
const DEFAULT_MEMORY_BYTES = 64 * 1024 * 1024;
/** 默认最大栈尺寸。 */
const DEFAULT_STACK_BYTES = 1024 * 1024;

/** 沙箱内屏蔽非确定性能力的引导脚本：删除/覆盖原生时间、随机数、网络等。 */
const SANDBOX_PRELUDE = `
  // —— 第二道防线：运行期屏蔽非确定性与逃逸能力 ——
  // 即便静态校验被绕过，这些能力在沙箱内也不存在或不可用。
  if (typeof Date !== 'undefined') {
    // Date.now / new Date() 是原生时间源，整体删除。
    Date = undefined;
  }
  if (typeof Math !== 'undefined' && Math.random) {
    // Math.random 是非确定性源，覆盖为始终抛错（而非返回常量，避免脚本误以为可用）。
    Math.random = function () { throw new Error('Math.random is disabled in PlanScript'); };
  }
  // 原生定时器 / 微任务调度 / 网络 / 动态代码：沙箱默认就没有，这里再显式置空兜底。
  globalThis.setTimeout = undefined;
  globalThis.setInterval = undefined;
  globalThis.queueMicrotask = undefined;
  globalThis.fetch = undefined;
  globalThis.XMLHttpRequest = undefined;
  globalThis.WebSocket = undefined;
  globalThis.performance = undefined;
  globalThis.crypto = undefined;
`;

/** 内部：一次重放过程中沙箱侧的 Host 调用记录。 */
interface HostCallRecord {
  seq: number;
  fn: HostFunction;
  params: unknown;
  /** 沙箱内对应的 deferred promise 的 resolve/reject 句柄管理对象 */
  deferred: ReturnType<QuickJSContext['newPromise']>;
  /** 是否已 settle（resolve 缓存结果）。未 settle 即为 pending frontier。 */
  settled: boolean;
}

/** 终止整个重放的内部信号（预算超限 / journal 不一致）。 */
type AbortSignalKind =
  | { kind: 'budget_exceeded'; call: PendingCall }
  | {
      kind: 'journal_mismatch';
      expected: { seq: number; fn: HostFunction; params: unknown };
      actual: { seq: number; fn: HostFunction; params: unknown };
    }
  | { kind: 'invalid_params'; seq: number; fn: HostFunction; message: string };

let cachedModule: QuickJSWASMModule | undefined;
/**
 * 可注入的 QuickJS variant。默认 undefined → 走 getQuickJS()（从 wasm 文件加载，
 * Node/测试环境适用）。在不支持运行时 instantiate(bytes)/fetch wasm 的环境（如
 * Cloudflare Workers），调用方应在启动时用 setQuickJSVariant() 注入一个用「部署时
 * 预编译的 WebAssembly.Module」构造的 variant（见 quickjs-emscripten 的 newVariant +
 * 静态 import .wasm），从而绕开「Wasm code generation disallowed by embedder」。
 */
let injectedVariant: unknown | undefined;

/**
 * 注入自定义 QuickJS variant。一次性设置，之后 loadModule 会用它构造模块而非
 * getQuickJS()。传入的对象即 quickjs-emscripten 的 QuickJSSyncVariant（通常由
 * newVariant(baseVariant, { wasmModule }) 产出，wasmModule 为静态 import 的预编译
 * WebAssembly.Module）。
 */
export function setQuickJSVariant(variant: unknown): void {
  injectedVariant = variant;
  // 注入后清掉缓存，确保下次 loadModule 用新 variant 重建。
  cachedModule = undefined;
}

/** 懒加载并缓存 QuickJS WASM 模块（注入了 variant 则用之，否则默认同步 release variant）。 */
async function loadModule(): Promise<QuickJSWASMModule> {
  if (!cachedModule) {
    cachedModule = injectedVariant
      ? await newQuickJSWASMModuleFromVariant(injectedVariant as never)
      : await getQuickJS();
  }
  return cachedModule;
}

/**
 * 重放一段 PlanScript。返回结构化 ReplayResult。
 *
 * 注意：本函数是确定性的——对相同 (source, journal) 输入，输出一致（pending frontier
 * 的 seq/fn/params 全等）。唯一的非确定性来源 budgetCheck 由调用方控制。
 *
 * 流程：先过静态校验（第一道防线），通过后进沙箱执行（第二道防线）。
 */
export async function replayPlanScript(options: ReplayOptions): Promise<ReplayResult> {
  // —— 第一道防线：静态校验 ——
  const validation = validatePlanScript(options.source);
  if (!validation.ok) {
    return { status: 'validation_failed', errors: validation.errors };
  }
  return executeInSandbox(options);
}

/**
 * 直接在沙箱内执行（跳过静态校验）。这是「第二道防线」的纯运行期入口。
 *
 * 警告：本函数不做静态校验，仅供 (a) 已在上游校验过的调用方复用，(b) 测试运行期屏蔽
 * 是否独立生效。生产路径请走 replayPlanScript。即便跳过校验，沙箱仍删除/覆盖 Date /
 * Math.random / fetch / 定时器等非确定性能力（SANDBOX_PRELUDE）。
 */
export async function executeInSandbox(options: ReplayOptions): Promise<ReplayResult> {
  const gasLimit = options.gasLimit ?? DEFAULT_GAS_LIMIT;
  const wallClockMs = options.wallClockTimeoutMs ?? DEFAULT_WALL_CLOCK_MS;
  const memoryBytes = options.memoryLimitBytes ?? DEFAULT_MEMORY_BYTES;
  const stackBytes = options.maxStackSizeBytes ?? DEFAULT_STACK_BYTES;

  // —— journal 归一化（防假 mismatch 与下标错位）——
  // 调用方可能传入存储层原始反序列化的条目（含 zod 会剥离的额外字段）或排序后的连续
  // 数组（seq 跳号时下标≠seq）。统一过 schema 归一化，并以 seq 字段为键重建稀疏数组：
  // journal 的语义键是 seq，与数组顺序无关。归一化保证 paramsEqual 比较的两侧都是
  // zod 输出形状（默认值已补全、未知字段已剥离）。
  const journalBySeq: JournalEntry[] = [];
  for (const raw of options.journal) {
    const parsed = JournalEntrySchema.safeParse(raw);
    if (!parsed.success) {
      const seq = (raw as { seq?: unknown } | undefined)?.seq;
      return {
        status: 'failed',
        error: {
          message: `journal 条目非法（seq=${String(seq)}）：${parsed.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; ')}`,
        },
      };
    }
    journalBySeq[parsed.data.seq] = parsed.data;
  }

  const QuickJS = await loadModule();
  const runtime: QuickJSRuntime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memoryBytes);
  runtime.setMaxStackSize(stackBytes);

  // gas / wall-clock interrupt：达上限返回 true → 解释器抛中断错误并停止当前执行。
  let gasUsed = 0;
  const deadline = Date.now() + wallClockMs;
  let interruptReason: 'gas' | 'timeout' | undefined;
  runtime.setInterruptHandler(() => {
    gasUsed += 1;
    if (gasUsed > gasLimit) {
      interruptReason = 'gas';
      return true;
    }
    if (Date.now() > deadline) {
      interruptReason = 'timeout';
      return true;
    }
    return false;
  });

  const context: QuickJSContext = runtime.newContext();

  // 重放期跨闭包共享的可变状态。
  let seqCounter = 0;
  const callsBySeq = new Map<number, HostCallRecord>();
  let abort: AbortSignalKind | undefined;
  // 标记 runtime 是否可能因原生栈溢出而处于不可安全释放的状态（见 evalCode 兜底）。
  let runtimeMaybeCorrupt = false;

  try {
    // 屏蔽非确定性能力（第二道防线）。
    {
      const r = context.evalCode(SANDBOX_PRELUDE);
      // prelude 不应出错；若出错直接当作宿主级失败抛出。
      context.unwrapResult(r).dispose();
    }

    installHostFunctions(context, {
      nextSeq: () => seqCounter++,
      journal: journalBySeq,
      budgetCheck: options.budgetCheck,
      callsBySeq,
      signalAbort: (a) => {
        if (!abort) abort = a;
      },
      isAborted: () => abort !== undefined,
    });

    // —— 脚本入口形态（本实现的设计决策，见 entry.ts）——
    // 把用户源码包进一个 async IIFE，在 global 模式下 evalCode，返回顶层 Promise。
    // 这样脚本可在顶层 await host 调用，其完成值即整段计划的完成值；未捕获异常会让
    // 该 Promise 进入 rejected 态，被识别为 failed。源码已通过静态校验，包裹安全。
    const wrapped = wrapSource(options.source);

    // 极端情况：深递归会撞穿 WASM 原生栈，evalCode 在宿主侧抛 RangeError（非 VM 内
    // 可捕获错误）。这会让 runtime 处于无法安全 dispose 的状态——下面 finally 用
    // runtimeMaybeCorrupt 标记做防御式释放，避免污染宿主进程。gas 采样频率不足以
    // 在栈溢出前抢先截停，故此处显式兜底，归类为 failed（资源耗尽式停机）。
    let evalResult: ReturnType<QuickJSContext['evalCode']>;
    try {
      evalResult = context.evalCode(wrapped, 'planscript.js', { type: 'global' });
    } catch (e) {
      runtimeMaybeCorrupt = true;
      return {
        status: 'failed',
        error: { message: `PlanScript 执行触发宿主级中止（疑似原生栈溢出）：${String(e)}` },
      };
    }

    if (evalResult.error) {
      // 同步阶段就抛错（async IIFE 的同步前缀报错）：记为 failed。
      const message = readErrorMessage(context, evalResult.error);
      evalResult.error.dispose();
      return { status: 'failed', error: { message } };
    }
    const topPromise: QuickJSHandle = evalResult.value;

    // —— 驱动微任务到静止态 ——
    // 每次 resolve 缓存结果都会激活新的 pending job；循环直到没有可执行 job 或被截停。
    // 同样防御原生栈溢出（递归发生在 await 之后时，会在 executePendingJobs 内触发）。
    try {
      drainToQuiescence(runtime, () => abort !== undefined);
    } catch (e) {
      runtimeMaybeCorrupt = true;
      try {
        topPromise.dispose();
      } catch {
        /* corrupt 态，忽略 */
      }
      return {
        status: 'failed',
        error: { message: `PlanScript 微任务驱动触发宿主级中止（疑似原生栈溢出）：${String(e)}` },
      };
    }

    // 截停优先级最高：gas / timeout。
    if (interruptReason === 'gas') {
      topPromise.dispose();
      return { status: 'gas_exceeded', error: { message: 'PlanScript 触发 gas 上限，已截停' } };
    }
    if (interruptReason === 'timeout') {
      topPromise.dispose();
      return {
        status: 'timeout',
        error: { message: `PlanScript 重放超过 wall-clock 上限 ${wallClockMs}ms，已截停` },
      };
    }

    // 宿主级终止信号（预算超限 / journal 不一致 / 非法参数）。
    if (abort) {
      topPromise.dispose();
      return abortToResult(abort);
    }

    // —— 判定顶层 Promise 状态 ——
    const state = context.getPromiseState(topPromise);
    if (state.type === 'fulfilled') {
      const value = handleToJson(context, state.value);
      state.value.dispose();
      topPromise.dispose();
      return { status: 'completed', value };
    }
    if (state.type === 'rejected') {
      const message = readErrorMessage(context, state.error);
      state.error.dispose();
      topPromise.dispose();
      return { status: 'failed', error: { message } };
    }

    // pending：脚本静止在 fan-out frontier 上。收集所有未 settle 的 Host 调用。
    topPromise.dispose();
    const calls: PendingCall[] = [...callsBySeq.values()]
      .filter((c) => !c.settled)
      .sort((a, b) => a.seq - b.seq)
      .map((c) => ({ seq: c.seq, fn: c.fn, params: c.params }));

    if (calls.length === 0) {
      // 既未完成、又无待执行调用，且无 job 可跑：脚本在 async 边界上永久挂起。
      // 视为 failed（确定性破坏：脚本依赖一个永不到来的非 Host 异步）。理论上静态
      // 校验已禁掉所有异步源，此分支兜底。
      return {
        status: 'failed',
        error: { message: 'PlanScript 静止但无完成值且无待执行 Host 调用（疑似挂起在非 Host 异步上）' },
      };
    }

    return { status: 'pending', calls };
  } finally {
    if (runtimeMaybeCorrupt) {
      // 原生栈溢出后，runtime 内 GC 对象表非空，dispose 会触发 WASM abort（在宿主侧
      // 表现为可捕获的 RuntimeError）。此时主动放弃释放：宁可泄漏一个 WASM 实例，也
      // 不让 abort 冒泡污染宿主进程。生产侧应监控此类脚本并视作可疑输入。
      try {
        context.dispose();
      } catch {
        // 容忍：context 释放也可能在 corrupt 态失败。
      }
      // 故意不调用 runtime.dispose()：已知会 abort。
    } else {
      // 释放尚未 settle 的 deferred（settle 过的会在 resolve 时自动释放回调，但 handle
      // 仍需 dispose；统一在此清理以防泄漏）。
      for (const rec of callsBySeq.values()) {
        try {
          rec.deferred.dispose();
        } catch {
          // 已释放则忽略。
        }
      }
      try {
        context.dispose();
      } catch {
        // 防御：极端情况下 context.dispose 也可能失败，吞掉以保护宿主。
      }
      try {
        runtime.dispose();
      } catch {
        // 同上。
      }
    }
  }
}

/** 把宿主终止信号转成 ReplayResult。 */
function abortToResult(abort: AbortSignalKind): ReplayResult {
  switch (abort.kind) {
    case 'budget_exceeded':
      return {
        status: 'budget_exceeded',
        error: {
          message: `预算超限：seq=${abort.call.seq} fn=${abort.call.fn}，已终止执行`,
        },
      };
    case 'journal_mismatch':
      return {
        status: 'journal_mismatch',
        error: {
          message: `journal 不一致：seq=${abort.expected.seq} 期望 fn=${abort.expected.fn}，实际 fn=${abort.actual.fn}`,
          expected: abort.expected,
          actual: abort.actual,
        },
      };
    case 'invalid_params':
      return {
        status: 'failed',
        error: { message: abort.message },
      };
  }
}

interface HostInstallDeps {
  nextSeq: () => number;
  journal: JournalEntry[];
  budgetCheck?: (call: PendingCall) => boolean;
  callsBySeq: Map<number, HostCallRecord>;
  signalAbort: (a: AbortSignalKind) => void;
  /** 宿主终止信号是否已置位（置位后不再受理新的 Host 调用）。 */
  isAborted: () => boolean;
}

/**
 * 在沙箱内安装 8 个 Host 函数。两种暴露形态并存：
 * - 顶层全局函数 run/invoke/.../artifact（任务要求的全局名白名单）。
 * - 聚合全局对象 host（protocol-v1.md 规定的沙箱可见对象）。
 *
 * 每个函数被调用时：归一化+校验参数 → 分配确定性 seq → 对照 journal 决定立即 resolve
 * 缓存结果还是留作 pending frontier。
 */
function installHostFunctions(context: QuickJSContext, deps: HostInstallDeps): void {
  using hostObj = context.newObject();

  for (const fn of HOST_FUNCTIONS) {
    const fnHandle = context.newFunction(fn, (...argHandles) => {
      // 宿主终止信号已置位（预算超限 / journal 不一致）：不再受理新调用，返回永久
      // pending 的 Promise，让执行流尽快静止。不分配 seq——终止后的调用不属于确定性
      // 执行流（不同终止时机下脚本能跑到的位置不同，分配 seq 反而破坏重放一致性）。
      if (deps.isAborted()) {
        const halted = context.newPromise();
        // 登记到一个不会与真实 seq 冲突的负数键，仅为统一在 finally 中 dispose。
        deps.callsBySeq.set(-1 - deps.callsBySeq.size, {
          seq: -1,
          fn,
          params: undefined,
          deferred: halted,
          settled: true, // 标记 settled，避免被收进 pending frontier。
        });
        return halted.handle;
      }

      // 读出实参为 JS 值。
      const args = argHandles.map((h) => handleToJson(context, h));

      // 分配确定性 seq（按发起顺序，与完成顺序无关）。
      const seq = deps.nextSeq();

      // 归一化 + schema 校验参数（进入 journal 前）。
      const normalized = normalizeHostParams(fn, args);
      const deferred = context.newPromise();
      // 立刻登记 record（即便参数非法），保证 finally 能 dispose 该 deferred handle。
      const record: HostCallRecord = {
        seq,
        fn,
        params: normalized.ok ? normalized.params : undefined,
        deferred,
        settled: false,
      };
      deps.callsBySeq.set(seq, record);

      if (!normalized.ok) {
        // 非法参数 = 契约破坏：reject 让脚本侧抛异常，并记录宿主终止信号。
        deps.signalAbort({ kind: 'invalid_params', seq, fn, message: normalized.message });
        using errHandle = context.newString(normalized.message);
        deferred.reject(errHandle);
        record.settled = true;
        return deferred.handle;
      }
      const params = normalized.params;

      // 对照 journal[seq]。
      const entry = deps.journal[seq];
      if (entry) {
        // 一致性校验：fn 必须一致。
        if (entry.fn !== fn) {
          deps.signalAbort({
            kind: 'journal_mismatch',
            expected: { seq, fn: entry.fn, params: entry.params },
            actual: { seq, fn, params },
          });
          // 不 resolve；让重放走到截停判定。
          return deferred.handle;
        }
        // 一致性校验：params 必须结构相等。
        if (!paramsEqual(entry.params, params)) {
          deps.signalAbort({
            kind: 'journal_mismatch',
            expected: { seq, fn: entry.fn, params: entry.params },
            actual: { seq, fn, params },
          });
          return deferred.handle;
        }
        // journal 中有 result → 立即 resolve 缓存结果（重放快进）。
        if ('result' in entry && entry.result !== undefined) {
          using resultHandle = jsonToHandle(context, entry.result);
          deferred.resolve(resultHandle);
          record.settled = true;
          return deferred.handle;
        }
        // journal 中是 pending 条目（无 result）→ 仍是 pending frontier，留作未 settle。
        return deferred.handle;
      }

      // journal 中没有该 seq → 这是一个全新的待执行调用（pending frontier）。
      // 在「发起新调用」这一刻执行预算检查；超限即终止整个执行。
      if (deps.budgetCheck && deps.budgetCheck({ seq, fn, params })) {
        deps.signalAbort({ kind: 'budget_exceeded', call: { seq, fn, params } });
      }
      // 不 resolve：留作 pending frontier。
      return deferred.handle;
    });

    // 暴露为顶层全局函数。
    context.setProp(context.global, fn, fnHandle);
    // 暴露为 host.<fn>。
    context.setProp(hostObj, fn, fnHandle);
    fnHandle.dispose();
  }

  context.setProp(context.global, 'host', hostObj);
}

/**
 * 驱动微任务执行到静止态。每轮 executePendingJobs 可能因 resolve 缓存结果而激活
 * 新一批 job；循环直到无 job 可执行（返回 0）或被 interrupt 截停。
 *
 * shouldStop：宿主终止信号（预算超限 / journal 不一致）置位后立即停止驱动——收窄
 * 「超限后脚本仍执行后续微任务」的时间窗，落实「超限即终止」语义。逐 job 驱动
 * （maxJobsToExecute=1）以便每个 job 之间都能检查信号。
 */
function drainToQuiescence(runtime: QuickJSRuntime, shouldStop: () => boolean): void {
  // 安全上限：防止极端情况下的宿主侧无限循环（脚本内死循环由 gas 拦，这里防 job 风暴）。
  let rounds = 0;
  const MAX_ROUNDS = 1_000_000;
  for (;;) {
    if (shouldStop()) return;
    const res = runtime.executePendingJobs(1);
    // executePendingJobs 返回已执行 job 数或错误。
    if (res.error) {
      // job 内抛出的错误（含 interrupt 中断）：释放并停止驱动。
      res.error.dispose();
      return;
    }
    const executed = res.value;
    if (executed === 0) return; // 静止态。
    if (++rounds > MAX_ROUNDS) return; // 兜底。
  }
}

/** best-effort 读出沙箱内错误对象的 message。 */
function readErrorMessage(context: QuickJSContext, errHandle: QuickJSHandle): string {
  try {
    const dumped = context.dump(errHandle);
    if (dumped && typeof dumped === 'object' && 'message' in dumped) {
      const m = (dumped as { message?: unknown }).message;
      const name = (dumped as { name?: unknown }).name;
      return `${name ? `${String(name)}: ` : ''}${String(m)}`;
    }
    return String(dumped);
  } catch {
    return '沙箱内未捕获错误（无法读出详情）';
  }
}
