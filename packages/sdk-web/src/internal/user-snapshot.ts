// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// External review, finding 1 (Serious) — submit-boundary capture for the
// self-declared user (`setUser`, spec 2026-08-12).
//
// The identity TOKEN already has one (`WebPlatformAdapter
// .__captureIdentityAtSubmitBoundary()`); the reasoning recorded when `setUser`
// went live — "no expiry race, so no submit-boundary capture is needed" — was
// wrong about WHY that capture exists. It has nothing to do with the token
// expiring: it exists because the prep between the user pressing Send and the
// envelope actually being built (annotation baking, replay-capture hashing,
// breadcrumb/network-body snapshotting, multipart construction) can span
// hundreds of milliseconds to seconds, and an ACCOUNT SWITCH during that window
// pinned the new identity to a report the old identity actually created. The
// self-declared user label is switched by the very same act of signing out and
// in, so it needs the identical capture.
//
// Deliberately a SIBLING of the token's capture rather than an extension of it:
// `__captureIdentityAtSubmitBoundary()` is fail-closed gated on
// `identity.enabled` from `/api/config` (a project with no signing secret never
// invokes the host's token provider at all). The self-declared user has NO such
// gate and must never acquire one — it is a plain host-supplied label, not a
// verified credential, and a report from a signed-in host must carry it whether
// or not identity recognition is enabled server-side. Sharing one function
// would put the user's capture one refactor away from inheriting that gate.
//
// Two further properties this file owns, both load-bearing:
//   - SYNCHRONOUS. The token's capture is `async` (it may fall back to a
//     bounded provider call); this one has no I/O, so it can run BEFORE that
//     await at every call site and cannot add a millisecond to a report.
//   - PROJECTED. This used to be `{ ...live }` — described as a "clone", which
//     it was, and assumed to be a projection, which it was NOT: a shallow
//     spread preserves EVERY own enumerable key. External review, finding 1
//     (Serious): `UserMetadata` is a TypeScript interface with no runtime
//     existence, so `tx.setUser(currentUser)` with the app's own user object
//     type-checks and shipped whatever else was on it. `projectUserMetadata`
//     keeps exactly `{id, email, displayName}` (string values only) and still
//     copies, so the "live reference could be mutated by the host after
//     capture" property this file already owned is preserved.
//
//     `client.setUser` projects too, and is the PRIMARY fix — the point where
//     the value enters the SDK. This one is not redundant with it: the
//     companion path reads through `CompanionHost.getUser()`, a seam a
//     hand-wired host can implement without the Provider (and so without
//     `setUser`) ever being involved, which makes this function a second
//     genuine entrance rather than merely another reader.
'use client';

import { projectUserMetadata, type UserMetadata } from '@everframe/sdk-core';

/**
 * Snapshot the host's live `setUser` value for THIS submit, projected to
 * exactly `{id, email, displayName}`. Never throws — recognition must never
 * fail or delay a report, so a throwing host getter degrades to "anonymous",
 * exactly like no user having been set.
 *
 * Returns `null` (not `undefined`) when nothing is set, so callers can keep the
 * `undefined` = "never captured" / `null` = "captured, nothing was set"
 * distinction that `capturedIdentityToken` uses across the same seams.
 */
export function captureUserSnapshot(
  read: () => UserMetadata | null | undefined,
): UserMetadata | null {
  try {
    return projectUserMetadata(read());
  } catch {
    return null;
  }
}
