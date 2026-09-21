// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { mintIdentityToken } from '../src/mint.js';

const SECRET = 'a'.repeat(64);
const PROJECT_ID = 'proj_01HZY000000000000000000000';
const NOW = new Date('2026-08-13T10:00:00.000Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

describe('mintIdentityToken', () => {
  it('signs HS256 with the claims the verifier requires', async () => {
    const token = await mintIdentityToken({
      secret: SECRET,
      projectId: PROJECT_ID,
      user: { id: 'u_alice', email: 'alice@example.com', name: 'Alice' },
      now: NOW,
    });

    expect(decodeProtectedHeader(token).alg).toBe('HS256');
    expect(decodeJwt(token)).toMatchObject({
      sub: 'u_alice',
      aud: PROJECT_ID,
      email: 'alice@example.com',
      name: 'Alice',
      iat: NOW_SEC,
      exp: NOW_SEC + 300,
    });
  });

  it('verifies against its own secret', async () => {
    const token = await mintIdentityToken({
      secret: SECRET, projectId: PROJECT_ID, user: { id: 'u_alice' }, now: NOW,
    });
    const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
      algorithms: ['HS256'], audience: PROJECT_ID, currentDate: NOW,
    });
    expect(payload.sub).toBe('u_alice');
  });

  it('stamps exp - iat as EXACTLY ttlSeconds', async () => {
    // The verifier rejects exp - iat > 600 outright. Reading the clock twice
    // could drift a 600 mint to 601 and produce a token that always fails.
    const token = await mintIdentityToken({
      secret: SECRET, projectId: PROJECT_ID, user: { id: 'u_alice' }, ttlSeconds: 600,
    });
    const { iat, exp } = decodeJwt(token);
    expect(exp! - iat!).toBe(600);
  });

  it('omits email and name when absent', async () => {
    const token = await mintIdentityToken({
      secret: SECRET, projectId: PROJECT_ID, user: { id: 'u_alice' }, now: NOW,
    });
    const payload = decodeJwt(token);
    expect(payload).not.toHaveProperty('email');
    expect(payload).not.toHaveProperty('name');
  });

  it('omits over-length email and name rather than refusing', async () => {
    // Mirrors readStringClaim in the server identity-token verifier, which
    // already treats an over-length claim as absent. Refusing here would be
    // stricter than the thing we are minting for.
    const token = await mintIdentityToken({
      secret: SECRET,
      projectId: PROJECT_ID,
      user: { id: 'u_alice', email: 'x'.repeat(321), name: 'y'.repeat(321) },
      now: NOW,
    });
    const payload = decodeJwt(token);
    expect(payload).not.toHaveProperty('email');
    expect(payload).not.toHaveProperty('name');
    expect(payload.sub).toBe('u_alice');
  });

  it('trims whitespace-only email and name to absent', async () => {
    const token = await mintIdentityToken({
      secret: SECRET, projectId: PROJECT_ID, user: { id: 'u_alice', email: '   ' }, now: NOW,
    });
    expect(decodeJwt(token)).not.toHaveProperty('email');
  });

  it('throws above the 600s ceiling', async () => {
    await expect(
      mintIdentityToken({ secret: SECRET, projectId: PROJECT_ID, user: { id: 'u' }, ttlSeconds: 601 }),
    ).rejects.toThrow(/ttlSeconds/);
  });

  it('accepts exactly 600', async () => {
    await expect(
      mintIdentityToken({ secret: SECRET, projectId: PROJECT_ID, user: { id: 'u' }, ttlSeconds: 600 }),
    ).resolves.toBeTypeOf('string');
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['too short', 'a'.repeat(31)],
  ])('throws on a %s secret', async (_label, secret) => {
    await expect(
      mintIdentityToken({ secret, projectId: PROJECT_ID, user: { id: 'u' } }),
    ).rejects.toThrow(/secret/i);
  });

  it('throws on a missing projectId', async () => {
    await expect(
      mintIdentityToken({ secret: SECRET, projectId: '', user: { id: 'u' } }),
    ).rejects.toThrow(/projectId/);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '  '],
    ['over 255 chars', 'u'.repeat(256)],
  ])('throws on a %s id', async (_label, id) => {
    await expect(
      mintIdentityToken({ secret: SECRET, projectId: PROJECT_ID, user: { id } }),
    ).rejects.toThrow(/id/);
  });
});
