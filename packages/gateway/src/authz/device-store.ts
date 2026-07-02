/**
 * DeviceGrantStore（§6.5d device flow 的持久化 I/O 边界）。
 *
 * 存储决策：**KV（KV_TENANTS）+ expirationTtl**——device flow 天然有 TTL 语义
 * （grant 600s 过期，RFC 8628），KV 的 expirationTtl 直接承载过期回收，比 D1 的
 * 手工过期扫描更贴合；miniflare 本地 KV 亦支持 expirationTtl，可测。
 *
 * 双索引：换 token 用 device_code 查、approve 用 user_code 查——故写两把 key
 * 指向同一 grant 序列化体：
 *   - `dc:<device_code>`  → JSON(DeviceGrant)
 *   - `uc:<user_code>`    → device_code（指针；再回查 dc:）
 * approve 时按 user_code 找到 device_code，改写 dc: 记录（重写 uc: 指针，保持 TTL 余量）。
 *
 * 纯逻辑（生成/判定/OAuth 错误形状）在 @watt/core device-flow；此处只做 KV 读写。
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import { type DeviceGrant, normalizeUserCode } from '@watt/core';

const DC_PREFIX = 'device:dc:';
const UC_PREFIX = 'device:uc:';

export class DeviceGrantStore {
  constructor(private readonly kv: KVNamespace) {}

  /** 写入新 grant（pending）。两把 key 用 grant 的剩余寿命作 expirationTtl。 */
  async put(grant: DeviceGrant, now: number): Promise<void> {
    const ttl = Math.max(60, grant.expiresAt - now);
    await this.kv.put(DC_PREFIX + grant.deviceCode, JSON.stringify(grant), {
      expirationTtl: ttl,
    });
    await this.kv.put(UC_PREFIX + grant.userCode, grant.deviceCode, {
      expirationTtl: ttl,
    });
  }

  /** 按 device_code 取 grant（token 端点用）。不存在/已 TTL 回收 → undefined。 */
  async getByDeviceCode(deviceCode: string): Promise<DeviceGrant | undefined> {
    const raw = await this.kv.get(DC_PREFIX + deviceCode);
    return raw ? (JSON.parse(raw) as DeviceGrant) : undefined;
  }

  /** 按 user_code 取 grant（approve 端点用）。入口归一化（§6.5d 大小写鲁棒）。 */
  async getByUserCode(userCode: string): Promise<DeviceGrant | undefined> {
    const deviceCode = await this.kv.get(UC_PREFIX + normalizeUserCode(userCode));
    if (!deviceCode) return undefined;
    return this.getByDeviceCode(deviceCode);
  }

  /** 覆写已存在的 grant（approve 绑定 principal）。保持原过期时刻对应的 TTL 余量。 */
  async update(grant: DeviceGrant, now: number): Promise<void> {
    await this.put(grant, now);
  }

  /**
   * 消费（删除）grant：token 换取成功后调用，实现 §6.5d device_code 一次性使用语义。
   * 同时删除 dc:/uc: 两把 key。KV 无原子多键删除，此处 best-effort（先删 dc: 断掉
   * 换 token 路径，再删 uc: 指针）；真正的原子单次消费需迁 DO/D1（CAS 或事务）。
   */
  async delete(grant: DeviceGrant): Promise<void> {
    await this.kv.delete(DC_PREFIX + grant.deviceCode);
    await this.kv.delete(UC_PREFIX + grant.userCode);
  }
}
