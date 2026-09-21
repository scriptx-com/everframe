// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Token-minting endpoint for TraceItX user recognition — the BACKEND half.
// The browser never sees the signing secret; it only ever sees a short-lived
// token minted here.
//
// Enable it by generating a signing secret in the dashboard
// (Project settings -> User recognition) and putting both values in the
// repo-root .env:
//
//   TRACEITX_IDENTITY_SECRET=<the one-time-revealed secret>
//   TRACEITX_IDENTITY_PROJECT_ID=<the project id shown beside it>
//
// `pnpm gen-web-config` projects them into .env.local WITHOUT a NEXT_PUBLIC_
// prefix, so they stay server-only.
//
// !! THE ONE THING TO COPY CAREFULLY IF YOU CRIB FROM THIS FILE !!
// `resolveUser` derives the user from a VERIFIED credential on the request. It
// must never read an identifier the client simply asserted (query, body, or an
// unverified header) — `sub` is the identity key, and accepting a
// client-supplied one lets any visitor claim to be any of your users, which is
// precisely what signing prevents.
import { createIdentityHandler } from '@traceitx/identity';
import { verifyAccessToken } from '../../lib/session';

// Route handlers with no request-dependent input are eligible for static
// rendering, which would bake ONE token into the build and serve it forever.
export const dynamic = 'force-dynamic';

const secret = process.env.TRACEITX_IDENTITY_SECRET;
const projectId = process.env.TRACEITX_IDENTITY_PROJECT_ID;

/**
 * createIdentityHandler VALIDATES AT CONSTRUCTION — which in a route module is
 * module-load time — so it is built only when both values are present.
 * Recognition is an enhancement here, never a prerequisite: with either unset
 * this route 503s and the example keeps reporting anonymously. A real host
 * with mandatory recognition would skip this guard and let the throw surface
 * at boot, which is the point of validating there.
 */
export const GET =
  secret && projectId
    ? createIdentityHandler({
        secret,
        projectId,
        resolveUser: (req) => {
          const user = verifyAccessToken(req.headers.get('authorization'));
          return user ? { id: user.id, email: user.email, name: user.name } : null;
        },
      })
    : async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            error: 'recognition_not_configured',
            detail:
              'Set TRACEITX_IDENTITY_SECRET and TRACEITX_IDENTITY_PROJECT_ID in the repo-root .env, then re-run pnpm dev:example:web.',
          }),
          { status: 503, headers: { 'cache-control': 'no-store', 'content-type': 'application/json' } },
        );

// This example is same-origin, so Next's automatic OPTIONS response (which
// carries only `Allow`, not the handler's CORS headers) never actually gets
// exercised by a preflight here. Exported anyway so this file stays a correct
// template to copy: a host that later serves this endpoint cross-origin only
// has to add `allowedOrigins`, not remember to also route OPTIONS.
export const OPTIONS = GET;
