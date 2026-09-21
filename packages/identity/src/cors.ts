// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// CORS for an endpoint whose response body is a bearer credential. The rule
// throughout: match exactly, never reflect, and always Vary.

const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const ALLOWED_HEADERS = 'authorization, content-type';
/** Preflight cacheability is about the PREFLIGHT, not the token. 10 minutes. */
const MAX_AGE = '600';

export function isPreflight(req: Request): boolean {
  return req.method === 'OPTIONS' && req.headers.has('access-control-request-method');
}

/**
 * Returns the CORS headers to merge, or null when none apply.
 *
 * `Vary: Origin` is set whenever an allowlist is CONFIGURED — including for a
 * rejected origin — because the response varies by origin either way, and a
 * shared cache that missed that could serve an allowed origin's headers to a
 * disallowed one.
 */
export function corsHeadersFor(
  req: Request,
  allowedOrigins: string[] | undefined,
  allowCredentials: boolean,
): Headers | null {
  if (!allowedOrigins || allowedOrigins.length === 0) return null;

  const headers = new Headers({ vary: 'Origin' });
  const origin = req.headers.get('origin');
  // Exact match only. No prefix/suffix/regex matching: "startsWith" origin
  // checks are a classic bypass (https://app.example.com.evil.test).
  if (origin === null || !allowedOrigins.includes(origin)) return headers;

  headers.set('access-control-allow-origin', origin);
  headers.set('access-control-allow-methods', ALLOWED_METHODS);
  headers.set('access-control-allow-headers', ALLOWED_HEADERS);
  headers.set('access-control-max-age', MAX_AGE);
  if (allowCredentials) headers.set('access-control-allow-credentials', 'true');
  return headers;
}
