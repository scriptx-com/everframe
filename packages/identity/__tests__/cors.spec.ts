// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { createIdentityHandler } from '../src/handler.js';

const SECRET = 'a'.repeat(64);
const PROJECT_ID = 'proj_01HZY000000000000000000000';
const ALLOWED = 'https://app.example.com';
const OTHER = 'https://evil.example.com';

const handler = (extra: Partial<Parameters<typeof createIdentityHandler>[0]> = {}) =>
  createIdentityHandler({
    secret: SECRET,
    projectId: PROJECT_ID,
    resolveUser: () => ({ id: 'u_alice' }),
    allowedOrigins: [ALLOWED],
    ...extra,
  });

const get = (origin?: string) =>
  new Request('https://api.example.com/i', origin ? { headers: { origin } } : {});

const preflight = (origin: string) =>
  new Request('https://api.example.com/i', {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'GET' },
  });

describe('CORS', () => {
  it('emits NO cors headers when allowedOrigins is absent', async () => {
    const h = createIdentityHandler({
      secret: SECRET, projectId: PROJECT_ID, resolveUser: () => ({ id: 'u_alice' }),
    });
    const res = await h(get(ALLOWED));
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('echoes only a matched origin', async () => {
    const res = await handler()(get(ALLOWED));
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
  });

  it('emits no cors headers for a non-allowlisted origin', async () => {
    // The browser blocks the read. Nothing to special-case.
    const res = await handler()(get(OTHER));
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.status).toBe(200);
  });

  it('rejects an origin that merely starts with an allowed one', async () => {
    // cors.ts matches with `includes`, never `startsWith` — a suffix attack
    // (https://app.example.com.evil.test) passes a prefix test and must not
    // pass this one. Without this case a startsWith regression is invisible:
    // OTHER shares no prefix with ALLOWED, so every other test still passes.
    const res = await handler()(get(`${ALLOWED}.evil.test`));
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('always sets Vary: Origin when an allowlist is configured', async () => {
    // Without it a shared cache can serve one origin's CORS decision to another.
    for (const origin of [ALLOWED, OTHER]) {
      const res = await handler()(get(origin));
      expect(res.headers.get('vary')).toContain('Origin');
    }
  });

  it('answers preflight with 204 and the allowed method/header set', async () => {
    const res = await handler()(preflight(ALLOWED));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    // A cross-origin bearer request is ALWAYS preflighted, so authorization
    // must be allowed or the primary auth path cannot work at all.
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses preflight from a non-allowlisted origin without cors headers', async () => {
    const res = await handler()(preflight(OTHER));
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('omits Allow-Credentials unless the host opts in', async () => {
    const res = await handler()(get(ALLOWED));
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('sets Allow-Credentials when allowCredentials is true', async () => {
    const res = await handler({ allowCredentials: true })(get(ALLOWED));
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('does not 405 a preflight', async () => {
    // OPTIONS must be handled BEFORE the method check, or preflight always fails.
    const res = await handler()(preflight(ALLOWED));
    expect(res.status).not.toBe(405);
  });

  it('gives NO cors headers to a request with Origin: null', async () => {
    // "null" is the opaque-origin placeholder sent by sandboxed iframes,
    // data:/file: pages, and some redirect flows — never a legitimate
    // allowlist match. assertValidOrigins already refuses to let it INTO an
    // allowlist (see handler.spec.ts), so this proves the runtime path too:
    // a real request carrying it falls through to "no match" like any other
    // non-allowlisted origin, never gets reflected.
    const res = await handler()(get('null'));
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('405s OPTIONS when no allowlist is configured', async () => {
    const h = createIdentityHandler({
      secret: SECRET, projectId: PROJECT_ID, resolveUser: () => ({ id: 'u_alice' }),
    });
    const res = await h(preflight(ALLOWED));
    expect(res.status).toBe(405);
  });
});
