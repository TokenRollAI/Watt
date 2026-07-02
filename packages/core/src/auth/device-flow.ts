/**
 * CLI 设备授权（RFC 8628 Device Authorization Grant 最小子集）纯逻辑。
 * 真源：Proto §6.5d（2026-07-02 规范性补充）。
 *
 * 端点在 gateway 侧（I/O 边界），本模块只做**无 I/O 的纯逻辑**：
 * - device_code / user_code 生成（user_code 8 位大写字母数字，§6.5d）；
 * - grant 状态机（pending → approved）与过期判定；
 * - RFC 8628 §3.5 的 OAuth 错误形状（`{error:"..."}`，**非 WattError**——§6.5d 明确
 *   OAuth 端点整体在 WattError 契约之外）。
 *
 * grant 的持久化（TTL 语义）在 gateway 侧用 KV（expirationTtl）落地。
 */

import type { PrincipalRef } from '../types.ts';

/** §6.5d 默认值。 */
export const DEVICE_CODE_EXPIRES_IN_SEC = 600;
export const DEVICE_CODE_INTERVAL_SEC = 5;

/** device flow 的 grant_type（§6.5d / RFC 8628 §3.4）。 */
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** user_code 字符集：大写字母 + 数字，去掉易混淆的 0/O/1/I（§6.5d "8 位大写字母数字"）。 */
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const USER_CODE_LEN = 8;

/** 随机字节源（可注入以便测试确定性）。默认 crypto.getRandomValues。 */
export type RandomBytesFn = (n: number) => Uint8Array;

const defaultRandomBytes: RandomBytesFn = (n) => crypto.getRandomValues(new Uint8Array(n));

/** now() 注入点（秒级 epoch）。 */
export type NowSecFn = () => number;

const defaultNowSec: NowSecFn = () => Math.floor(Date.now() / 1000);

/** 生成 device_code（不透明高熵字符串，URL 安全 base64）。 */
export function generateDeviceCode(random: RandomBytesFn = defaultRandomBytes): string {
  const bytes = random(32);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 生成 user_code（8 位，取自无歧义字母数字表；§6.5d）。 */
export function generateUserCode(random: RandomBytesFn = defaultRandomBytes): string {
  const bytes = random(USER_CODE_LEN);
  let code = '';
  for (const byte of bytes) {
    code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
  }
  return code;
}

/**
 * 归一化用户输入的 user_code（§6.5d "对大小写鲁棒"；RFC 8628 §6.1 允许剥离分隔符）：
 * trim → 去除空格与连字符分隔符 → 转大写。approve/查询入口统一经此归一，使
 * `abcd-1234`、`ABCD 1234`、`abcd1234` 等价于存储的 `ABCD1234`。
 */
export function normalizeUserCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

/** grant 状态。approved 时 principal 已绑定，可换 token。 */
export type DeviceGrantStatus = 'pending' | 'approved';

/** 持久化的 grant 记录（gateway 侧序列化进 KV）。 */
export interface DeviceGrant {
  deviceCode: string;
  userCode: string;
  status: DeviceGrantStatus;
  /** approved 后绑定的 principal（换 token 用）。 */
  principal?: PrincipalRef;
  /** 授权发起时刻（epoch sec）。 */
  createdAt: number;
  /** 过期时刻（epoch sec）= createdAt + expires_in。 */
  expiresAt: number;
}

/** authorize 响应（§6.5d，返回给 CLI）。 */
export interface DeviceAuthorizeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/** authorize 结果：既含返回给客户端的响应，也含待持久化的 grant。 */
export interface CreateDeviceGrantResult {
  grant: DeviceGrant;
  response: DeviceAuthorizeResponse;
}

export interface CreateDeviceGrantInput {
  verificationUri: string;
  expiresInSec?: number;
  intervalSec?: number;
  now?: NowSecFn;
  random?: RandomBytesFn;
}

/** 创建一个新 grant（pending）+ 组装 authorize 响应。 */
export function createDeviceGrant(input: CreateDeviceGrantInput): CreateDeviceGrantResult {
  const now = (input.now ?? defaultNowSec)();
  const expiresIn = input.expiresInSec ?? DEVICE_CODE_EXPIRES_IN_SEC;
  const interval = input.intervalSec ?? DEVICE_CODE_INTERVAL_SEC;
  const random = input.random ?? defaultRandomBytes;
  const deviceCode = generateDeviceCode(random);
  const userCode = generateUserCode(random);
  const grant: DeviceGrant = {
    deviceCode,
    userCode,
    status: 'pending',
    createdAt: now,
    expiresAt: now + expiresIn,
  };
  return {
    grant,
    response: {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: input.verificationUri,
      expires_in: expiresIn,
      interval,
    },
  };
}

/** grant 是否已过期（epoch sec）。 */
export function isDeviceGrantExpired(grant: DeviceGrant, now: number): boolean {
  return now >= grant.expiresAt;
}

/** RFC 8628 §3.5 的 OAuth 错误码（token 端点用）。 */
export type OAuthErrorCode =
  | 'authorization_pending'
  | 'expired_token'
  | 'access_denied'
  | 'invalid_grant'
  | 'invalid_request';

/** OAuth 错误 body（裸 `{error, error_description?}`，非 WattError；§6.5d 豁免）。 */
export interface OAuthErrorBody {
  error: OAuthErrorCode;
  error_description?: string;
}

export function oauthError(error: OAuthErrorCode, description?: string): OAuthErrorBody {
  return description === undefined ? { error } : { error, error_description: description };
}

/** token 端点判定的结果种类。 */
export type TokenExchangeOutcome =
  | { kind: 'pending' }
  | { kind: 'expired' }
  | { kind: 'invalid_grant' }
  | { kind: 'approved'; principal: PrincipalRef };

/**
 * token 端点纯判定（§6.5d）：给定 grant（可能不存在）+ now，决定应答形态。
 * - grant 不存在 → invalid_grant（RFC 8628：未知/已消费的 device_code）。
 * - 已过期 → expired。
 * - pending → pending（HTTP 400 `{error:"authorization_pending"}`）。
 * - approved 且有 principal → approved（签发 user token）。
 */
export function evaluateTokenExchange(
  grant: DeviceGrant | undefined,
  now: number,
): TokenExchangeOutcome {
  if (grant === undefined) return { kind: 'invalid_grant' };
  if (isDeviceGrantExpired(grant, now)) return { kind: 'expired' };
  if (grant.status === 'approved' && grant.principal !== undefined) {
    return { kind: 'approved', principal: grant.principal };
  }
  return { kind: 'pending' };
}
