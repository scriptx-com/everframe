// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The mint endpoint. Everything here is shaped by one fact: the response body
// is a bearer credential for a person. Whoever can read it can file reports as
// them and, on the verified tier, read their support conversations.
import {
  assertValidProjectId,
  assertValidSecret,
  assertValidTtl,
  mintIdentityToken,
  normalizeUser,
  SubjectError,
} from './mint.js';
import { corsHeadersFor, isPreflight } from './cors.js';
import { DEFAULT_TTL_SECONDS, type IdentityUser } from './types.js';

export type ResolveUser = (req: Request) => IdentityUser | null | Promise<IdentityUser | null>;

export interface HandlerOptions {
  secret: string;
  projectId: string;
  resolveUser: ResolveUser;
  ttlSeconds?: number;
  /**
   * Exact-match origin allowlist. ABSENT means no CORS headers at all —
   * same-origin only, which is the safe default. '*' throws.
   */
  allowedOrigins?: string[];
  /** Only meaningful with `allowedOrigins`. The cookie case. */
  allowCredentials?: boolean;
}

/** Applied to every response, including 405 and 500, so no branch can omit it. */
function baseHeaders(): Headers {
  return new Headers({ 'cache-control': 'no-store' });
}

function json(body: unknown, status: number, headers: Headers): Response {
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { status, headers });
}

export function createIdentityHandler(opts: HandlerOptions): (req: Request) => Promise<Response> {
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  assertValidSecret(opts.secret);
  assertValidProjectId(opts.projectId);
  assertValidTtl(ttlSeconds);
  assertValidOrigins(opts.allowedOrigins);

  return async function identityHandler(req: Request): Promise<Response> {
    const headers = baseHeaders();
    const cors = corsHeadersFor(req, opts.allowedOrigins, opts.allowCredentials === true);
    if (cors) for (const [k, v] of cors) headers.set(k, v);

    // BEFORE the method check: OPTIONS is not an allowed method, so a
    // preflight would otherwise 405 and every cross-origin call would fail.
    if (cors && isPreflight(req)) {
      return new Response(null, { status: 204, headers });
    }

    if (req.method !== 'GET' && req.method !== 'POST') {
      return new Response(null, { status: 405, headers });
    }

    let user: IdentityUser | null;
    try {
      user = await opts.resolveUser(req);
    } catch {
      // Never surface the host's internals — the message could carry a
      // connection string. An empty body is the whole diagnostic budget.
      return new Response(null, { status: 500, headers });
    }

    if (!user) return json({ token: null }, 200, headers);

    // Validate the subject BEFORE minting so a bad one becomes a reason code
    // rather than a thrown 500. mintIdentityToken normalizes again internally
    // — it is a public entry point and cannot assume a validated caller — and
    // normalizeUser is pure, so the second call is free. Cheaper than
    // threading a pre-normalized shape through the public API.
    try {
      normalizeUser(user);
    } catch (err) {
      if (err instanceof SubjectError) {
        // The verifier would reject this as bad_subject. Minting a token
        // guaranteed to fail helps nobody; anonymity plus a diagnostic does.
        return json({ token: null, reason: err.reason }, 200, headers);
      }
      return new Response(null, { status: 500, headers });
    }

    const now = new Date();
    const token = await mintIdentityToken({
      secret: opts.secret,
      projectId: opts.projectId,
      user,
      ttlSeconds,
      now,
    });

    return json({ token, expiresAt: now.getTime() + ttlSeconds * 1000 }, 200, headers);
  };
}

/** Defined here rather than in mint.ts — it is a handler-only concern. */
function assertValidOrigins(allowedOrigins: string[] | undefined): void {
  if (allowedOrigins === undefined) return;
  if (!Array.isArray(allowedOrigins)) {
    throw new Error('@everframe/identity: allowedOrigins must be an array of origin strings.');
  }
  if (allowedOrigins.includes('*')) {
    throw new Error(
      "@everframe/identity: allowedOrigins cannot contain '*'. A wildcard origin combined with " +
        'credentials is rejected by browsers and would expose identity tokens to any site. ' +
        'List your origins explicitly.',
    );
  }
  for (const entry of allowedOrigins) {
    // PR review, Serious finding — the literal string "null" is the Origin
    // header every browser sends for an OPAQUE origin: sandboxed iframes
    // (<iframe sandbox> without allow-same-origin), data: URLs, file: pages,
    // and some redirect chains all serialize their Origin to exactly "null".
    // It does not name one origin, it's the shared placeholder ALL of those
    // unrelated contexts collapse to — allowlisting it (especially combined
    // with allowCredentials) lets any of them read another user's identity
    // bearer token. Checked case-insensitively/trimmed so 'NULL' or ' null '
    // can't sneak past a copy-paste typo either.
    if (entry.trim().toLowerCase() === 'null') {
      throw new Error(
        `@everframe/identity: allowedOrigins cannot contain "${entry}". The string "null" is the ` +
          'opaque-origin placeholder shared by sandboxed iframes, data: URLs, file: pages, and some ' +
          'redirect flows — it does not identify a trusted caller, so allowlisting it would let any ' +
          'of those unrelated contexts read identity tokens. List real origins instead.',
      );
    }
    // Must be a bare origin: scheme + host [+ port], nothing else. Parsing
    // via `new URL` and checking `url.origin === entry` catches a trailing
    // slash, a path, a query/fragment, or a missing/unsupported scheme —
    // all of which would otherwise silently NEVER match the exact-match
    // check in cors.ts, disabling recognition for that origin with no error
    // anywhere.
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(
        `@everframe/identity: allowedOrigins entry "${entry}" is not a valid URL. Expected a bare ` +
          'origin like "https://app.example.com".',
      );
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(
        `@everframe/identity: allowedOrigins entry "${entry}" must use http: or https:. Expected a ` +
          'bare origin like "https://app.example.com".',
      );
    }
    if (url.origin !== entry) {
      throw new Error(
        `@everframe/identity: allowedOrigins entry "${entry}" must be a bare origin — no path, query, ` +
          'fragment, or trailing slash. Expected a form like "https://app.example.com".',
      );
    }
  }
}
