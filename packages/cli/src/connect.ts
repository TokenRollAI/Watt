/**
 * `watt channel connect <channelId>`：本地承载飞书 WS 长连接（决策 feishu-websocket-channel.md）。
 *
 * 飞书 WSClient 是 Node SDK（ws + axios，跑不进 workerd）——由 CLI 进程承载。收到 WS 事件 →
 * @watt/plugin-feishu decodeFeishuEvent 规约 → 以 token 调平台 EventBus.Publish（POST /htbp/platform/event）。
 * dedupe 靠平台（dedupeKey=event_id）。P1 后 decode 纯逻辑迁往 plugin 包（WS dev 路径与 Worker
 *   webhook 宿主复用同一份）；本 WS 承载降为 dev-only 路径（生产走 plugin Worker webhook 回调）。
 *
 * 可测部分（本文件导出的纯逻辑 / 注入型函数）：
 *  - publishDecodedEvent：decode 结果 → EventBus.Publish 调用（注入 htbpCall，断言 body 形状）。
 *  - nextBackoffMs：重连退避（指数 + 上限），纯函数。
 *  - runSupervisor：重连监督循环（注入 connectOnce + sleep，断言重连行为）。
 * 不可测部分（真实 WSClient 连接）：createWsClient + connectFeishu 的 SDK 接线——@feishu 轮实测，
 *   本文件不写真实连接测试（LOOP 纪律：真实飞书每轮最多一次，留 R25）。
 */

import { decodeFeishuEvent, type FeishuEvent } from '@watt/plugin-feishu';
import { type HttpDeps, htbpCall } from './client.ts';
import { CliError } from './env.ts';

/** 连接日志回调（连上/断线/重连/事件数）——注入以便测试与静默。 */
export interface ConnectLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export const consoleLogger: ConnectLogger = {
  info: (m) => process.stderr.write(`${m}\n`),
  warn: (m) => process.stderr.write(`${m}\n`),
};

/**
 * decode 一条飞书 WS 事件并 Publish 到平台（EventBus.Publish，POST /htbp/platform/event）。
 * decode skip（未知类型/畸形）→ 记 warn 后返回 false（不 Publish）；成功 → Publish 后返回 true。
 * Publish body 形状真源 = gateway platform-event 路由：{tool:'Publish', arguments:{event}}，
 * event 是 EventInput（source/type/session/payload/... 平台补齐 id/traceId/occurredAt）。
 */
export async function publishDecodedEvent(
  base: string,
  token: string,
  raw: FeishuEvent,
  deps: HttpDeps = {},
  logger: ConnectLogger = consoleLogger,
  now: () => string = () => new Date().toISOString(),
): Promise<boolean> {
  const decoded = decodeFeishuEvent(raw, { now });
  if (decoded.skip) {
    logger.warn(`watt connect: skipped feishu event (${decoded.reason})`);
    return false;
  }
  await htbpCall(base, token, 'event', 'Publish', { event: decoded.event }, deps);
  logger.info(
    `watt connect: published ${decoded.event.type} (dedupeKey=${decoded.event.dedupeKey ?? '-'})`,
  );
  return true;
}

/** 指数退避（首次 min，每次翻倍，封顶 max）。attempt 从 0 起。纯函数。 */
export function nextBackoffMs(attempt: number, minMs = 1000, maxMs = 30_000): number {
  const v = minMs * 2 ** attempt;
  return v > maxMs ? maxMs : v;
}

export interface SupervisorDeps {
  /** 建立一次连接并阻塞直到断开（正常返回 = 断线，抛错 = 连接失败）。 */
  connectOnce: () => Promise<void>;
  /** 退避 sleep 注入（缺省 setTimeout）。 */
  sleep?: (ms: number) => Promise<void>;
  logger?: ConnectLogger;
  /** 停止信号（返回 true 则退出监督循环）——测试注入有限次；生产恒 false（Ctrl-C 由进程终止）。 */
  shouldStop?: () => boolean;
  minMs?: number;
  maxMs?: number;
}

/**
 * 重连监督循环（SDK 不总自动重连，DoD ① 的"断线重连"面）。
 * connectOnce 正常返回（断线）或抛错（连接失败）都触发退避重连；连接成功（进入 connectOnce）
 * 后把退避计数归零（下次断线从 minMs 重来）。shouldStop 为 true 时退出。
 */
export async function runSupervisor(deps: SupervisorDeps): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const logger = deps.logger ?? consoleLogger;
  const shouldStop = deps.shouldStop ?? (() => false);
  let attempt = 0;
  while (!shouldStop()) {
    try {
      logger.info(
        attempt === 0
          ? 'watt connect: connecting…'
          : `watt connect: reconnecting (attempt ${attempt})…`,
      );
      await deps.connectOnce();
      logger.warn('watt connect: connection closed');
      attempt = 0; // 曾成功连接过 → 下次断线从头退避
    } catch (err) {
      // CliError = 不可重试的配置错误（如 optional lark SDK 缺失）——直接抛出交 run() 以其 exitCode
      //   退出，而非当作瞬时断线无限退避重连。瞬时连接失败（普通 Error）才走退避重连。
      if (err instanceof CliError) throw err;
      logger.warn(
        `watt connect: connection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (shouldStop()) break;
    const backoff = nextBackoffMs(attempt, deps.minMs, deps.maxMs);
    logger.info(`watt connect: backing off ${backoff}ms`);
    await sleep(backoff);
    attempt += 1;
  }
}

/** 飞书连接凭据（从 env / ChannelConfig.settings 解析）。 */
export interface FeishuConnectConfig {
  appId: string;
  appSecret: string;
  /** 国际版可覆盖 domain（缺省国内 open.feishu.cn）。 */
  domain?: string;
}

/** lark SDK 最小注入面（测试用 fake WSClient；生产缺省动态 import 真实 SDK）。 */
export interface LarkModule {
  WSClient: new (
    params: Record<string, unknown>,
  ) => { start: (opts: { eventDispatcher: unknown }) => Promise<void> | void };
  EventDispatcher: new (
    opts: Record<string, unknown>,
  ) => {
    register: (handlers: Record<string, (data: unknown) => Promise<void>>) => unknown;
  };
  Domain: { Feishu: unknown };
}

/**
 * 动态加载 @larksuiteoapi/node-sdk（optionalDependency——发行 bundle 里 external，仅本地 WS dev 路径需要）。
 * 未安装（`npm i -g @tokenroll/watt` 默认不装 optional 或安装失败）→ CliError(2) 给安装指引，
 *   而非抛裸 ERR_MODULE_NOT_FOUND 崩栈。生产走 plugin Worker webhook 回调，不需此包。
 */
async function loadLarkSdk(): Promise<LarkModule> {
  try {
    return (await import('@larksuiteoapi/node-sdk')) as unknown as LarkModule;
  } catch {
    throw new CliError(
      'feishu WS connect requires the optional package @larksuiteoapi/node-sdk.\n' +
        '  Install it:  npm i -g @larksuiteoapi/node-sdk   (or add it to your project)\n' +
        '  Note: production feishu runs via the plugin Worker webhook; `channel connect` is a local dev-only path.',
      2,
    );
  }
}

/**
 * 建立飞书 WS 连接并把事件转发到平台（真实 SDK 接线，@feishu 轮实测）。
 * SDK 坑（调研 §5）：wsClient config 必须带 wsConfig{PingInterval,PingTimeout}（缺失曾报 undefined）。
 * eventDispatcher 注册 im.message.receive_v1 / card.action.trigger 处理器，收到即
 *   publishDecodedEvent。connectOnce 语义：返回的 Promise 在连接存续期间阻塞，SDK 终态放弃
 *   （鉴权失败/重连耗尽/autoReconnect 关闭等）触发 onError → reject → runSupervisor 退避后
 *   重建全新 WSClient 重连。SDK 1.68.0 的全部终态放弃路径都必然 safeInvoke('onError')
 *   （lib/index.js L89250/89264 等）——onError 即「这次连接结束」的唯一可靠信号；SDK 内部
 *   可自愈的断线走 onReconnecting（不 settle，本层不感知）。
 *
 * larkModule 可注入（测试用 fake WSClient 断言 settle 语义；缺省动态 import 真实 SDK——
 *   @larksuiteoapi/node-sdk 是 Node-only，仅 connect 命令加载）。
 */
export async function connectFeishu(
  base: string,
  token: string,
  config: FeishuConnectConfig,
  logger: ConnectLogger = consoleLogger,
  larkModule?: LarkModule,
): Promise<void> {
  const lark = larkModule ?? (await loadLarkSdk());

  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: unknown) => {
      await publishDecodedEvent(base, token, wrapEvent('im.message.receive_v1', data), {}, logger);
    },
    'card.action.trigger': async (data: unknown) => {
      await publishDecodedEvent(base, token, wrapEvent('card.action.trigger', data), {}, logger);
    },
  } as Record<string, (data: unknown) => Promise<void>>);

  // SDK 的事件处理器收到的是 event 体（不含 header 信封）；重建 FeishuEvent 以复用 core decode。
  // header.event_id/create_time 若 SDK 已剥离则由 core decode 缺省补齐（now 时钟）。
  await new Promise<void>((_resolve, reject) => {
    let settled = false;
    const settle = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const wsClient = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.domain ?? lark.Domain.Feishu,
      // 调研 §5：PingInterval/PingTimeout 必填，缺失会在启动时报 undefined。
      // wsConfig/onReady/onError 属 SDK 构造参数但未在公开类型导出——经 Record 注入。
      wsConfig: { PingInterval: 30_000, PingTimeout: 60_000 },
      onReady: () => logger.info('watt connect: ws ready'),
      // SDK 终态放弃（不再自行重连）→ 本次 connectOnce 结束，交 runSupervisor 退避重建。
      onError: (err: unknown) =>
        settle(err instanceof Error ? err : new Error(String(err ?? 'ws error'))),
    });
    // start() 为 async（同步永不抛）；其 rejection 必须接住，否则 unhandledRejection 挂死进程。
    void Promise.resolve(wsClient.start({ eventDispatcher })).catch(settle);
  });
}

/** SDK 事件处理器只给 event 体；重建 FeishuEvent 信封（header 由 data 内字段回填或缺省）。 */
function wrapEvent(eventType: string, data: unknown): FeishuEvent {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  // SDK 部分版本把 header 平铺进 data.event_id/create_time；无则 core decode 用 now 兜底。
  const header = {
    event_type: eventType,
    event_id: typeof d.event_id === 'string' ? d.event_id : undefined,
    create_time: typeof d.create_time === 'string' ? d.create_time : undefined,
  };
  return { header, event: d };
}
