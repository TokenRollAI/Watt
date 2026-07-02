/// <reference types="node" />
import { generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildJwks,
  DEFAULT_USER_TOKEN_TTL_SEC,
  exportJWK,
  importPrivateJwk,
  importPublicJwk,
  type JWK,
  JWT_ALG,
  JWT_CRV,
  type PrivateKeyMaterial,
  type PublicKeyMaterial,
  signAgentToken,
  signUserToken,
  type TokenMeta,
  verifyToken,
} from './jwt.ts';

/**
 * JWT 纯逻辑单测。
 * 测试密钥在 fixture 内实时生成（Ed25519），**不与生产共用**——满足约束"测试密钥可以直接生成在测试 fixture 里"。
 * oracle 硬编码自 Proto §6.5a（user token 无 agent 段）/ §6.4a（agent token 有 agent_def/inst/chain）。
 */

const META: TokenMeta = { issuer: 'watt-platform', audience: 'watt-api' };
const KID = 'test-key-1';

let priv: PrivateKeyMaterial;
let pub: PublicKeyMaterial;
let publicJwk: JWK;
// 另一把独立密钥，用于"错密钥"用例。
let otherPub: PublicKeyMaterial;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair(JWT_ALG, { crv: JWT_CRV, extractable: true });
  const privJwk = await exportJWK(privateKey);
  const imported = await importPrivateJwk(privJwk, KID);
  priv = imported.priv;
  publicJwk = imported.publicJwk;
  pub = await importPublicJwk(publicJwk, KID);

  const other = await generateKeyPair(JWT_ALG, { crv: JWT_CRV, extractable: true });
  const otherPubJwk = await exportJWK(other.publicKey);
  otherPub = await importPublicJwk(otherPubJwk, 'other-key');
});

describe('signUserToken / verifyToken roundtrip', () => {
  it('issues a user token that verifies back to sub + roles, no agent segment (§6.5a)', async () => {
    const token = await signUserToken(
      { principal: 'user:alice', roles: ['admin', 'staff'], trace: 'tr-1' },
      priv,
      META,
    );
    const { claims } = await verifyToken(token, pub, META);
    expect(claims.sub).toBe('user:alice');
    expect(claims.roles).toEqual(['admin', 'staff']);
    expect(claims.trace).toBe('tr-1');
    // §6.5a：user token 无 agent_*/chain。
    expect(claims.agent_def).toBeUndefined();
    expect(claims.agent_inst).toBeUndefined();
    expect(claims.chain).toBeUndefined();
  });

  it('defaults ttl to DEFAULT_USER_TOKEN_TTL_SEC and verifies within window', async () => {
    expect(DEFAULT_USER_TOKEN_TTL_SEC).toBe(3600);
    // 用系统时钟签发（默认 now），落在有效期内即可验签通过。
    const token = await signUserToken({ principal: 'user:bob', roles: [] }, priv, META);
    const { claims } = await verifyToken(token, pub, META);
    expect(claims.sub).toBe('user:bob');
    expect(claims.roles).toEqual([]);
  });
});

describe('signAgentToken (§6.4a)', () => {
  it('carries agent_def / agent_inst / chain', async () => {
    const token = await signAgentToken(
      {
        principal: 'user:alice',
        roles: ['ceo'],
        agentDef: 'finance',
        agentInst: 'inst-42',
        chain: ['inst-7', 'inst-42'],
        trace: 'tr-2',
      },
      priv,
      META,
    );
    const { claims } = await verifyToken(token, pub, META);
    expect(claims.sub).toBe('user:alice');
    expect(claims.agent_def).toBe('finance');
    expect(claims.agent_inst).toBe('inst-42');
    expect(claims.chain).toEqual(['inst-7', 'inst-42']);
  });

  it('issues an agent token without trace', async () => {
    const token = await signAgentToken(
      {
        principal: 'service:scheduler',
        roles: [],
        agentDef: 'reporter',
        agentInst: 'inst-1',
        chain: ['cron:daily', 'inst-1'],
      },
      priv,
      META,
    );
    const { claims } = await verifyToken(token, pub, META);
    expect(claims.agent_def).toBe('reporter');
    expect(claims.trace).toBeUndefined();
  });
});

describe('verifyToken rejection paths', () => {
  it('rejects an expired token', async () => {
    // 签发时 now = 0，ttl 1s → exp = 1；验签时系统时钟远大于 1 → 过期。
    const token = await signUserToken(
      { principal: 'user:alice', roles: [], ttlSeconds: 1 },
      priv,
      META,
      () => 0,
    );
    await expect(verifyToken(token, pub, META)).rejects.toThrow();
  });

  it('rejects a token signed by a different key', async () => {
    const token = await signUserToken({ principal: 'user:alice', roles: [] }, priv, META);
    await expect(verifyToken(token, otherPub, META)).rejects.toThrow();
  });

  it('rejects a token with wrong audience', async () => {
    const token = await signUserToken({ principal: 'user:alice', roles: [] }, priv, META);
    await expect(
      verifyToken(token, pub, { issuer: META.issuer, audience: 'wrong-aud' }),
    ).rejects.toThrow();
  });
});

describe('JWKS exposure', () => {
  it('derives a public JWK with alg/use/kid and no private material', () => {
    expect(publicJwk.alg).toBe(JWT_ALG);
    expect(publicJwk.use).toBe('sig');
    expect(publicJwk.kid).toBe(KID);
    expect(publicJwk.crv).toBe(JWT_CRV);
    // 公钥 JWK 绝不含私钥字段 d。
    expect((publicJwk as Record<string, unknown>).d).toBeUndefined();
    expect(publicJwk.x).toBeTruthy();
  });

  it('buildJwks wraps keys into { keys: [...] }', () => {
    const jwks = buildJwks([publicJwk]);
    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys[0]?.kid).toBe(KID);
    expect((jwks.keys[0] as Record<string, unknown>).d).toBeUndefined();
  });
});

describe('verifyToken defensive claim parsing', () => {
  // 直接用 jose 手签畸形 payload，覆盖 verifyToken 的结构化分支（防御性容错）。
  async function rawSign(payload: Record<string, unknown>): Promise<string> {
    const iat = Math.floor(Date.now() / 1000);
    return new SignJWT(payload)
      .setProtectedHeader({ alg: JWT_ALG, kid: KID })
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .setIssuer(META.issuer)
      .setAudience(META.audience)
      .sign(priv.key);
  }

  it('throws when sub claim is missing / not a string', async () => {
    // 不 setSubject → 无 sub。
    const token = await rawSign({ roles: [] });
    await expect(verifyToken(token, pub, META)).rejects.toThrow(/sub/);
  });

  it('coerces non-array roles to empty array', async () => {
    const token = await rawSign({ sub: 'user:x', roles: 'not-an-array' });
    const { claims } = await verifyToken(token, pub, META);
    expect(claims.roles).toEqual([]);
  });

  it('filters non-string entries out of roles and chain', async () => {
    const token = await rawSign({
      sub: 'user:x',
      roles: ['ok', 42, 'good'],
      agent_def: 123,
      chain: ['a', null, 'b'],
    });
    const { claims } = await verifyToken(token, pub, META);
    expect(claims.roles).toEqual(['ok', 'good']);
    // agent_def 非 string → 不落 claim。
    expect(claims.agent_def).toBeUndefined();
    expect(claims.chain).toEqual(['a', 'b']);
  });

  it('omits trace when absent', async () => {
    const token = await rawSign({ sub: 'user:x', roles: [] });
    const { claims } = await verifyToken(token, pub, META);
    expect(claims.trace).toBeUndefined();
    expect(claims.chain).toBeUndefined();
  });
});
