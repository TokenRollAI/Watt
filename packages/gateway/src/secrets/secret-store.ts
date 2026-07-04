/**
 * SecretStore —— 运行时密钥的加密存储（Proto §6.6）。
 *
 * 值经 **AES-256-GCM** 加密后存 KV（键 `secret:<name>`）：
 *   - 每次写用**随机 12 字节 IV**；
 *   - **附加认证数据（AAD）= secret 名**——把 A 的密文搬到 B 键位下解密必失败（防 KV 内容对调）；
 *   - 存储形状 `{v:1, iv, ct, updatedAt}`（iv/ct 为 base64url）。
 * 加密主密钥 = `env.WATT_SECRET_ENCRYPTION_KEY`（32 字节 base64url，部署期 secret，**不从 JWT 私钥派生**）。
 *
 * 依赖注入（KV + 主密钥字符串）便于单测。主密钥缺失时由调用方（端点 / resolveSecret）先行判定并降级；
 * 本类构造不校验主密钥，首次用到 crypto 才解码——非法长度 → 抛错（端点转 unavailable/500）。
 *
 * **永不回显明文**：本类只有 getValue() 返回明文（仅供 resolveSecret 内部），List/getMeta 只出元数据。
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import { type WattError, wattError } from '@watt/shared';

/** KV 键前缀（存 KV_TENANTS，不新建 namespace）。 */
const KEY_PREFIX = 'secret:';

/** secret 名约束（§6.6：大写字母开头、字母数字下划线、≤64）。 */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** KV 存储形状（v1）。 */
export interface StoredSecretV1 {
  v: 1;
  /** base64url(12B 随机 IV)。 */
  iv: string;
  /** base64url(密文 + GCM tag)。 */
  ct: string;
  updatedAt: string;
}

/** secret 元数据（对外仅出这些字段——永不含明文值）。 */
export interface SecretMeta {
  name: string;
  updatedAt: string;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class SecretStore {
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(
    private readonly kv: KVNamespace,
    private readonly encryptionKey: string,
  ) {}

  /** 惰性导入 AES-256-GCM key（32 字节）。非法长度 → 抛错。 */
  private async cryptoKey(): Promise<CryptoKey> {
    if (this.keyPromise === null) {
      const raw = b64urlDecode(this.encryptionKey);
      if (raw.length !== 32) {
        throw new Error('WATT_SECRET_ENCRYPTION_KEY must decode to 32 bytes (AES-256)');
      }
      this.keyPromise = crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
        'encrypt',
        'decrypt',
      ]);
    }
    return this.keyPromise;
  }

  /** 写入（覆写即更新）。名字非法 → invalid_argument。返回元数据（不回显值）。 */
  async write(name: string, value: string): Promise<SecretMeta | WattError> {
    if (!SECRET_NAME_RE.test(name)) {
      return wattError(
        'invalid_argument',
        `invalid secret name (must match ${SECRET_NAME_RE.source}): ${name}`,
        false,
      );
    }
    const key = await this.cryptoKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = new TextEncoder().encode(name);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      key,
      new TextEncoder().encode(value),
    );
    const updatedAt = new Date().toISOString();
    const stored: StoredSecretV1 = {
      v: 1,
      iv: b64urlEncode(iv),
      ct: b64urlEncode(new Uint8Array(ct)),
      updatedAt,
    };
    // updatedAt 复制进 KV metadata：list 直接读 key.metadata，免逐项 get 解密。
    await this.kv.put(KEY_PREFIX + name, JSON.stringify(stored), { metadata: { updatedAt } });
    return { name, updatedAt };
  }

  /** 删除（幂等——不存在也返回 deleted）。名字非法 → invalid_argument。 */
  async delete(name: string): Promise<{ deleted: true } | WattError> {
    if (!SECRET_NAME_RE.test(name)) {
      return wattError('invalid_argument', `invalid secret name: ${name}`, false);
    }
    await this.kv.delete(KEY_PREFIX + name);
    return { deleted: true };
  }

  /** 列举全部 secret 元数据（分页遍历 KV，读 metadata 里的 updatedAt）。 */
  async list(): Promise<SecretMeta[]> {
    const items: SecretMeta[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.kv.list<{ updatedAt?: string }>({ prefix: KEY_PREFIX, cursor });
      for (const k of res.keys) {
        items.push({
          name: k.name.slice(KEY_PREFIX.length),
          updatedAt: k.metadata?.updatedAt ?? '',
        });
      }
      cursor = res.list_complete ? undefined : res.cursor;
    } while (cursor !== undefined);
    return items;
  }

  /** 取单个 secret 元数据（不解密、不回显值）。不存在 → null。 */
  async getMeta(name: string): Promise<SecretMeta | null> {
    if (!SECRET_NAME_RE.test(name)) return null;
    const raw = await this.kv.get(KEY_PREFIX + name);
    if (raw === null) return null;
    try {
      const stored = JSON.parse(raw) as StoredSecretV1;
      return { name, updatedAt: stored.updatedAt };
    } catch {
      return null;
    }
  }

  /**
   * 解密取明文——**仅供 resolveSecret 内部调用**（端点永不回显）。
   * 不存在 / 畸形 / AAD 名字错配 / key 变更 → null（解密失败不抛，静默降级）。
   */
  async getValue(name: string): Promise<string | null> {
    if (!SECRET_NAME_RE.test(name)) return null;
    const raw = await this.kv.get(KEY_PREFIX + name);
    if (raw === null) return null;
    let stored: StoredSecretV1;
    try {
      stored = JSON.parse(raw) as StoredSecretV1;
    } catch {
      return null;
    }
    if (stored.v !== 1) return null;
    try {
      const key = await this.cryptoKey();
      const aad = new TextEncoder().encode(name);
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64urlDecode(stored.iv), additionalData: aad },
        key,
        b64urlDecode(stored.ct),
      );
      return new TextDecoder().decode(pt);
    } catch {
      return null; // GCM tag / AAD 校验失败（内容对调、key 轮换）→ 静默 null。
    }
  }
}
