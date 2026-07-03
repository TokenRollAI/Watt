/**
 * IdentityMapper（Proto §6.3）——principal→roles 面 + 渠道身份→principal 面。
 *
 * 数据源：watt-policies 库（binding DB_POLICIES）。
 *  - identity_mappings 表（principal PRIMARY KEY，roles JSON）：ResolvePrincipal。
 *  - channel_identities 表（(channel, channel_user_id) PK → principal）：Resolve（R24 起真实）。
 * §6.3：roles 一律触发时实时解析（不用创建时快照）——此处每次查 D1 现值。
 * Resolve(channel, channelUserId)：查 channel_identities 命中 → { principal, roles 经 resolvePrincipal }；
 * 未命中 → principal "user:anonymous" + 空 roles（保留现有语义）。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { PrincipalRef } from '@watt/core';

interface IdentityRow {
  principal: string;
  roles: string; // JSON array string
}

interface ChannelIdentityRow {
  principal: string;
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
   * 查 channel_identities 命中 → principal + roles（经 resolvePrincipal 实时解析）；
   * 未命中 → anonymous + 空 roles（保留现有语义）。
   */
  async resolve(channel: string, channelUserId: string): Promise<ResolvedIdentity> {
    const row = await this.db
      .prepare('SELECT principal FROM channel_identities WHERE channel = ? AND channel_user_id = ?')
      .bind(channel, channelUserId)
      .first<ChannelIdentityRow>();
    if (!row) return { principal: ANONYMOUS_PRINCIPAL, roles: [] };
    const resolved = await this.resolvePrincipal(row.principal);
    return { principal: row.principal, roles: resolved.roles };
  }

  /** 绑定渠道身份 → principal（幂等 upsert）。种子引导与身份管理写入口用。 */
  async bindChannelIdentity(
    channel: string,
    channelUserId: string,
    principal: PrincipalRef,
    now: string = new Date().toISOString(),
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO channel_identities (channel, channel_user_id, principal, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel, channel_user_id) DO UPDATE SET
           principal = excluded.principal, updated_at = excluded.updated_at`,
      )
      .bind(channel, channelUserId, principal, now, now)
      .run();
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
