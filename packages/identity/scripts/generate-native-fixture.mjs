#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Generates packages/protocol/__tests__/fixtures/identity-token-native.v1.json
// — real tokens minted through @traceitx/identity's ACTUAL entry point
// (mintIdentityToken), the same one a customer's backend calls. Minting
// through the real function rather than hand-rolling JWTs is the whole point:
// claim-shape drift between the minter and the two native decoders
// (decodeIdentityClaims in IdentityTokenHolder.swift / .kt) is exactly what
// this fixture is meant to catch, and a hand-rolled token that merely LOOKS
// like the minter's output would catch nothing.
//
// This fixture backs THREE consumers:
//   - the ingest API/__tests__/reporter/identity-native-fixture.spec.ts feeds every
//     token through the REAL verifyIdentityToken, proving the fixture is
//     ACCEPTABLE, not merely self-consistent.
//   - packages/sdk-ios's IdentityFixtureTests.swift and
//     packages/sdk-android's IdentityFixtureTest.kt each decode the same
//     bytes (via a physical copy — see fixture-sync.spec.ts's convention)
//     and assert `sub`/`exp` match what's recorded here.
//
// DETERMINISM. The codegen-drift job in android.yml regenerates this file and
// diffs it against what's committed (`node
// packages/identity/scripts/generate-native-fixture.mjs && git diff
// --exit-code ...`) — that is what proves the fixture wasn't hand-edited out
// of sync with the minter. A generator that reads the clock (`Date.now()`)
// would therefore fail that gate on literally every run, since `iat` would
// differ from the committed value every time. FIXTURE_IAT_MS below is a
// FIXED, hardcoded instant passed in as `now` instead — never read from the
// system clock. The native suites inject this same value as "now" so their
// expiry arithmetic is exercised deterministically rather than depending on
// when the suite happens to run (a token minted "now" at generation time
// would silently go stale years later).
//
// FIXTURE_SECRET / FIXTURE_PROJECT_ID are likewise fixed constants, not
// looked up from a real project — there IS no real project here, this script
// has no DB access. identity-native-fixture.spec.ts seeds a project row with
// this literal id and stamps its identity secret to this literal value
// directly (bypassing the normal random `generateIdentitySecret()`), so the
// real verifier ends up checking a signature against exactly the secret these
// tokens were actually signed with.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mintIdentityToken } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(
  here,
  '../../protocol/__tests__/fixtures/identity-token-native.v1.json',
);

// A fixed instant landing on a whole second, so
// `Math.floor(FIXTURE_IAT_MS / 1000) * 1000 === FIXTURE_IAT_MS` — i.e. the
// `iatMs` recorded per-token below is EXACTLY the `iat` that ends up signed
// into the JWT, with no floor-to-seconds rounding to account for.
const FIXTURE_IAT_MS = Date.UTC(2026, 7, 13, 12, 0, 0);

// Fixed 64-hex-char secret (>= MIN_SECRET_LENGTH=32). Not a real project
// secret — shared only with identity-native-fixture.spec.ts, which stores
// this exact value for the fixture's project so the real verifier can check
// it. Committed in the clear on purpose: it protects nothing in production.
const FIXTURE_SECRET = '5f'.repeat(32);

// Fixed, syntactically-valid UUID. identity-native-fixture.spec.ts inserts a
// project row with this literal id (Postgres `uuid` columns accept an
// explicit value in place of the `defaultRandom()` default), so `aud`
// (verifyIdentityToken compares it against exactly this projectId) resolves
// to a real row at verify time despite this script never touching a database.
const FIXTURE_PROJECT_ID = '00000000-0000-4000-8000-000000000001';

// The verifier's exact ceiling (SUBJECT_MAX in the server identity-token verifier).
const SUB_255 = 'u'.repeat(255);

const specs = [
  {
    name: 'alice-300s',
    user: { id: 'alice', email: 'alice@example.com', name: 'Alice Anderson' },
    ttlSeconds: 300,
  },
  {
    // MAX_TTL_SECONDS ceiling — mintIdentityToken throws above 600, and
    // IDENTITY_TOKEN_MAX_TTL_SEC in the verifier is the same 600. Proves the
    // two ceilings agree at the boundary value, not just below it.
    name: 'bob-600s-boundary',
    user: { id: 'bob' },
    ttlSeconds: 600,
  },
  {
    // The verifier's exact `sub` ceiling (255 chars) — one char over is
    // rejected as `bad_subject`.
    name: 'sub-255-boundary',
    user: { id: SUB_255 },
    ttlSeconds: 300,
  },
];

const now = new Date(FIXTURE_IAT_MS);

const tokens = [];
for (const spec of specs) {
  const jwt = await mintIdentityToken({
    secret: FIXTURE_SECRET,
    projectId: FIXTURE_PROJECT_ID,
    user: spec.user,
    ttlSeconds: spec.ttlSeconds,
    now,
  });
  tokens.push({
    name: spec.name,
    jwt,
    iatMs: FIXTURE_IAT_MS,
    expMs: FIXTURE_IAT_MS + spec.ttlSeconds * 1000,
    sub: spec.user.id,
    projectId: FIXTURE_PROJECT_ID,
  });
}

const fixture = {
  generatedAt: FIXTURE_IAT_MS,
  // Not part of a real token's own bytes — kept here (rather than duplicated
  // as a second hardcoded literal in identity-native-fixture.spec.ts) so
  // there is exactly one place that can drift out of sync with what these
  // tokens were actually signed with.
  secret: FIXTURE_SECRET,
  tokens,
};

writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
console.log(`wrote ${tokens.length} tokens to ${outPath}`);
