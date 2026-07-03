/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ANONYMOUS_PRINCIPAL, IdentityMapper } from '../src/authz/identity-mapper.ts';

/**
 * IdentityMapper.Resolve 渠道身份映射单测（真实 D1 binding，migrations 0002 channel_identities）。
 * oracle 硬编码自 Proto §6.3：命中 → { principal, roles 经 ResolvePrincipal 实时解析 }；
 * 未命中 → user:anonymous + 空 roles。roles 透传（drive from identity_mappings）。
 */

async function clearDb() {
  await env.DB_POLICIES.prepare('DELETE FROM channel_identities').run();
  await env.DB_POLICIES.prepare('DELETE FROM identity_mappings').run();
}

beforeEach(clearDb);

describe('IdentityMapper.resolve — 渠道身份映射（§6.3）', () => {
  it('未命中 → anonymous + 空 roles', async () => {
    const mapper = new IdentityMapper(env.DB_POLICIES);
    const r = await mapper.resolve('feishu', 'ou_unknown');
    expect(r.principal).toBe(ANONYMOUS_PRINCIPAL);
    expect(r.roles).toEqual([]);
  });

  it('命中 → principal + roles 经 ResolvePrincipal 实时解析', async () => {
    const mapper = new IdentityMapper(env.DB_POLICIES);
    await mapper.bindChannelIdentity('feishu', 'ou_admin', 'user:alice');
    await mapper.bind('user:alice', ['ceo', 'admin']);
    const r = await mapper.resolve('feishu', 'ou_admin');
    expect(r.principal).toBe('user:alice');
    expect(r.roles).toEqual(['ceo', 'admin']);
  });

  it('命中但 principal 无 identity_mappings 行 → roles 空（透传 ResolvePrincipal 语义）', async () => {
    const mapper = new IdentityMapper(env.DB_POLICIES);
    await mapper.bindChannelIdentity('feishu', 'ou_norole', 'user:bob');
    const r = await mapper.resolve('feishu', 'ou_norole');
    expect(r.principal).toBe('user:bob');
    expect(r.roles).toEqual([]);
  });

  it('channel 隔离：同 channelUserId 不同 channel 互不命中', async () => {
    const mapper = new IdentityMapper(env.DB_POLICIES);
    await mapper.bindChannelIdentity('feishu', 'u1', 'user:alice');
    const other = await mapper.resolve('slack', 'u1');
    expect(other.principal).toBe(ANONYMOUS_PRINCIPAL);
  });

  it('bindChannelIdentity 幂等 upsert：同 (channel, userId) 覆盖 principal', async () => {
    const mapper = new IdentityMapper(env.DB_POLICIES);
    await mapper.bindChannelIdentity('feishu', 'ou_x', 'user:alice');
    await mapper.bindChannelIdentity('feishu', 'ou_x', 'user:bob'); // 覆盖
    const r = await mapper.resolve('feishu', 'ou_x');
    expect(r.principal).toBe('user:bob');
  });
});
