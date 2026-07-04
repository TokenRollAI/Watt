/**
 * @watt/plugin-feishu 纯逻辑入口（adapter/）——供 CLI `channel connect`（WS dev 路径）与 Worker 宿主复用。
 *
 * 分层：本 barrel 只导出无 I/O / 可注入 I/O 的纯逻辑（decode/encode/verify/crypto/send/botinfo）；
 *   Worker 宿主（src/index.ts + src/worker.ts）依赖注入产生副作用。CLI 经此包入口 import decode
 *   （P4 打包时 inline），不再依赖 @watt/core 的飞书导出（已从 core 迁出）。
 */

export { type BotInfoResponse, fetchBotOpenId } from './botinfo.ts';
export {
  computeFeishuSignature,
  constantTimeEqual,
  decryptFeishuPayload,
  verifyFeishuSignature,
} from './crypto.ts';
export {
  type DecodeDeps,
  decodeFeishuEvent,
  FEISHU_CHANNEL,
  FEISHU_MESSAGE_PATH,
  type FeishuDecodeResult,
  type FeishuEvent,
  type FeishuMention,
  type OutboundMessage,
} from './decode.ts';
export { encodeFeishuOutbound, type FeishuOutboundPayload } from './encode.ts';
export {
  type FeishuSendConfig,
  type FeishuSendResult,
  memoryTokenCache,
  sendFeishuMessage,
  type TokenCache,
} from './send.ts';
export {
  extractChallenge,
  type FeishuVerifyConfig,
  type RawInbound,
  type VerifyResult,
  verifyAndExtract,
} from './verify.ts';
