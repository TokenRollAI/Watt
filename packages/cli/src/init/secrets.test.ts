import { describe, expect, it } from 'vitest';
import {
  ADMIN_TOKEN_TTL_SEC,
  generateTrustRoot,
  JWT_AUDIENCE,
  JWT_ISSUER,
  PLATFORM_KID,
  publicJwkFromPrivate,
  signAdminToken,
  verifyWithJwk,
} from './secrets.ts';

describe('generateTrustRoot', () => {
  it('signs an admin token verifiable by the same JWK public key', async () => {
    const tr = await generateTrustRoot('user:alice');
    const payload = await verifyWithJwk(tr.adminToken, tr.privateJwkJson);
    expect(payload.sub).toBe('user:alice');
    expect(payload.roles).toEqual(['admin']);
  });

  it('produces a 32-byte base64url encryption key', async () => {
    const tr = await generateTrustRoot('user:admin');
    expect(tr.encryptionKey).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes → 43 base64url chars (no padding).
    expect(tr.encryptionKey.length).toBe(43);
  });

  it('private JWK is Ed25519 (OKP/Ed25519) and public strips d', async () => {
    const tr = await generateTrustRoot('user:admin');
    const jwk = JSON.parse(tr.privateJwkJson) as { kty: string; crv: string; d?: string };
    expect(jwk.kty).toBe('OKP');
    expect(jwk.crv).toBe('Ed25519');
    expect(jwk.d).toBeTypeOf('string');
    const pub = await publicJwkFromPrivate(tr.privateJwkJson);
    expect((pub as { d?: string }).d).toBeUndefined();
    expect(pub.x).toBe(jwk.d ? (JSON.parse(tr.privateJwkJson) as { x: string }).x : undefined);
  });
});

describe('signAdminToken', () => {
  it('uses platform constants (issuer/audience/kid/EdDSA) and 7d TTL by default', async () => {
    const tr = await generateTrustRoot('user:bob');
    const [header, body] = tr.adminToken
      .split('.')
      .slice(0, 2)
      .map((seg) => {
        const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      }) as [{ alg: string; kid: string }, { iss: string; aud: string; exp: number; iat: number }];
    expect(header.alg).toBe('EdDSA');
    expect(header.kid).toBe(PLATFORM_KID);
    expect(body.iss).toBe(JWT_ISSUER);
    expect(body.aud).toBe(JWT_AUDIENCE);
    expect(body.exp - body.iat).toBe(ADMIN_TOKEN_TTL_SEC);
  });

  it('accepts a private JWK JSON string as key', async () => {
    const tr = await generateTrustRoot('user:carol');
    const token = await signAdminToken(tr.privateJwkJson, 'user:carol');
    const payload = await verifyWithJwk(token, tr.privateJwkJson);
    expect(payload.sub).toBe('user:carol');
  });
});
