// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { decodeJwt } from 'jose';
import { createIdentityHandler } from '../src/handler.js';
import type { IdentityUser } from '../src/types.js';

const SECRET = 'a'.repeat(64);
const PROJECT_ID = 'proj_01HZY000000000000000000000';
const ALICE: IdentityUser = { id: 'u_alice', email: 'alice@example.com', name: 'Alice' };

const handlerFor = (resolveUser: (req: Request) => IdentityUser | null | Promise<IdentityUser | null>) =>
  createIdentityHandler({ secret: SECRET, projectId: PROJECT_ID, resolveUser });

const GET = () => new Request('https://app.example.com/api/traceitx-identity');

describe('createIdentityHandler — construction', () => {
  const base = { projectId: PROJECT_ID, resolveUser: () => ALICE };

  it('throws on a short secret', () => {
    expect(() => createIdentityHandler({ ...base, secret: 'short' })).toThrow(/secret/i);
  });

  it('throws on a missing projectId', () => {
    expect(() => createIdentityHandler({ secret: SECRET, projectId: '', resolveUser: () => ALICE }))
      .toThrow(/projectId/);
  });

  it('throws above the TTL ceiling', () => {
    expect(() => createIdentityHandler({ ...base, secret: SECRET, ttlSeconds: 601 })).toThrow(/ttlSeconds/);
  });

  it("throws on a '*' origin rather than silently downgrading", () => {
    // A wildcard with credentials is the credential-theft path AND the browser
    // rejects the combination, so a boot error beats a mystery.
    expect(() => createIdentityHandler({ ...base, secret: SECRET, allowedOrigins: ['*'] }))
      .toThrow(/\*/);
  });

  it("throws on the literal string 'null' — the opaque-origin placeholder", () => {
    // Sandboxed iframes, data:/file: pages, and some redirect flows all send
    // Origin: null. It is not one origin, it is a shared placeholder — never
    // allowlist-able, credentials or not.
    expect(() => createIdentityHandler({ ...base, secret: SECRET, allowedOrigins: ['null'] }))
      .toThrow(/null/i);
  });

  it("throws on 'NULL' and padded ' null ' too", () => {
    expect(() => createIdentityHandler({ ...base, secret: SECRET, allowedOrigins: ['NULL'] }))
      .toThrow(/null/i);
    expect(() => createIdentityHandler({ ...base, secret: SECRET, allowedOrigins: [' null '] }))
      .toThrow(/null/i);
  });

  it('throws on an origin with a trailing slash', () => {
    expect(() =>
      createIdentityHandler({ ...base, secret: SECRET, allowedOrigins: ['https://app.example.com/'] }),
    ).toThrow(/app\.example\.com/);
  });

  it('throws on an origin with a path', () => {
    expect(() =>
      createIdentityHandler({ ...base, secret: SECRET, allowedOrigins: ['https://app.example.com/path'] }),
    ).toThrow(/app\.example\.com/);
  });

  it('throws on an origin with no scheme', () => {
    expect(() => createIdentityHandler({ ...base, secret: SECRET, allowedOrigins: ['app.example.com'] }))
      .toThrow(/app\.example\.com/);
  });

  it('throws on a non-http(s) scheme', () => {
    expect(() => createIdentityHandler({ ...base, secret: SECRET, allowedOrigins: ['ftp://x.example.com'] }))
      .toThrow(/x\.example\.com/);
  });

  it('accepts syntactically valid http/https origins', () => {
    expect(() =>
      createIdentityHandler({ ...base, secret: SECRET, allowedOrigins: ['https://app.example.com'] }),
    ).not.toThrow();
    expect(() =>
      createIdentityHandler({ ...base, secret: SECRET, allowedOrigins: ['http://localhost:3000'] }),
    ).not.toThrow();
  });
});

describe('createIdentityHandler — responses', () => {
  it('returns a token and ms-epoch expiresAt for a resolved user', async () => {
    const res = await handlerFor(() => ALICE)(GET());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: number };
    expect(typeof body.token).toBe('string');
    expect(decodeJwt(body.token)).toMatchObject({ sub: 'u_alice', aud: PROJECT_ID });
    // ms epoch, not seconds and not ISO — roughly 300s out.
    expect(body.expiresAt).toBeGreaterThan(Date.now() + 250_000);
    expect(body.expiresAt).toBeLessThan(Date.now() + 350_000);
  });

  it('awaits an async resolveUser', async () => {
    const res = await handlerFor(async () => ALICE)(GET());
    expect((await res.json() as { token: string }).token).toBeTypeOf('string');
  });

  it('passes the Request to resolveUser so header auth works', async () => {
    const handler = handlerFor((req) =>
      req.headers.get('authorization') === 'Bearer good' ? ALICE : null,
    );
    const authed = await handler(
      new Request('https://app.example.com/i', { headers: { authorization: 'Bearer good' } }),
    );
    expect((await authed.json() as { token: string | null }).token).toBeTypeOf('string');

    const anon = await handler(GET());
    expect((await anon.json() as { token: string | null }).token).toBeNull();
  });

  it('returns 200 { token: null } when nobody is signed in', async () => {
    // A signed-out user is a normal state. A 401 would spray red into every
    // signed-out visitor's console for a strictly optional feature.
    const res = await handlerFor(() => null)(GET());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: null });
  });

  it('degrades to { token: null, reason } on an over-length id', async () => {
    const res = await handlerFor(() => ({ id: 'u'.repeat(256) }))(GET());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: null, reason: 'subject_too_long' });
  });

  it('degrades on an empty id too', async () => {
    const res = await handlerFor(() => ({ id: '   ' }))(GET());
    expect(await res.json()).toEqual({ token: null, reason: 'subject_too_long' });
  });

  it('returns 500 with an empty body when resolveUser throws', async () => {
    const res = await handlerFor(() => { throw new Error('db down'); })(GET());
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('');
  });

  it('returns 500 when resolveUser rejects', async () => {
    const res = await handlerFor(async () => { throw new Error('db down'); })(GET());
    expect(res.status).toBe(500);
  });

  it('accepts POST', async () => {
    const res = await handlerFor(() => ALICE)(
      new Request('https://app.example.com/i', { method: 'POST' }),
    );
    expect(res.status).toBe(200);
  });

  it('returns 405 for other methods', async () => {
    const res = await handlerFor(() => ALICE)(
      new Request('https://app.example.com/i', { method: 'DELETE' }),
    );
    expect(res.status).toBe(405);
  });

  it('sets Cache-Control: no-store on EVERY response', async () => {
    // The single most valuable line in the package: an edge-cached mint
    // endpoint serves one user's identity token to another.
    const responses = await Promise.all([
      handlerFor(() => ALICE)(GET()),
      handlerFor(() => null)(GET()),
      handlerFor(() => ({ id: '' }))(GET()),
      handlerFor(() => { throw new Error('x'); })(GET()),
      handlerFor(() => ALICE)(new Request('https://app.example.com/i', { method: 'DELETE' })),
    ]);
    for (const res of responses) {
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('never leaks the resolveUser error message', async () => {
    const res = await handlerFor(() => { throw new Error('postgres://user:pw@host'); })(GET());
    expect(await res.text()).not.toContain('postgres');
  });
});
