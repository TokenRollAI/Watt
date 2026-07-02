/**
 * IdentityMapper（Proto §6.3）——最小面：ResolvePrincipal(principal) → { roles }。
 *
 * 数据源：watt-policies 库的 identity_mappings 表（principal PRIMARY KEY，roles JSON）。
 * §6.3：roles 一律触发时实时解析（不用创建时快照）——此处每次查 D1 现值。
 * Resolve(channel, channelUserId)（渠道→principal）本 Phase 只给最小实现：未映射 →
 * principal "user:anonymous" + 空 roles（渠道映射数据留 Phase 2/6）。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { PrincipalRef } from '@watt/core';

interface IdentityRow {
  principal: string;
  roles: string; // JSON array string
}

export interface ResolvedPrincipal {
  roles: string[];
}

export interface ResolvedIdentity {
  principal: PrincipalRef;
  roles: string[];
}

export const ANONYMOUS_PRINCIPAL: PrincipalRef = 'user:anonymous';

export class IdentityMapper {
  constructor(private readonly db: D1Database) {}

  /** ResolvePrincipal（§6.3）——principal → 当前 roles（未映射 → 空 roles）。 */
  async resolvePrincipal(principal: PrincipalRef): Promise<ResolvedPrincipal> {
    const row = await this.db
      .prepare('SELECT roles FROM identity_mappings WHERE principal = ?')
      .bind(principal)
      .first<IdentityRow>();
    if (!row) return { roles: [] };
    return { roles: JSON.parse(row.roles) as string[] };
  }

  /**
   * Resolve（§6.3）——渠道原始用户 → principal + roles。
   * Phase 1 最小实现：无渠道映射数据 → anonymous + 空 roles（Phase 2/6 补真实映射）。
   */
  async resolve(_channel: string, _channelUserId: string): Promise<ResolvedIdentity> {
    return { principal: ANONYMOUS_PRINCIPAL, roles: [] };
  }

  /** 绑定 principal → roles（幂等 upsert）。种子引导与后续角色管理用。 */
  async bind(
    principal: PrincipalRef,
    roles: string[],
    now: string = new Date().toISOString(),
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO identity_mappings (principal, roles, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(principal) DO UPDATE SET roles = excluded.roles, updated_at = excluded.updated_at`,
      )
      .bind(principal, JSON.stringify(roles), now, now)
      .run();
  }
}
