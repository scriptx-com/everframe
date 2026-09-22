// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// External review, finding 1 (Serious) — `setUser` uploaded arbitrary host
// object properties.
//
// `UserMetadata` is a TypeScript INTERFACE: it has no runtime existence and
// therefore enforces nothing at the SDK boundary. The most natural call a host
// developer writes is `tx.setUser(currentUser)` with the app's OWN user object
// — and every path from there to the wire preserved it verbatim:
// `client.setUser` stored the reference unchanged, `captureUserSnapshot`
// shallow-cloned it (`{ ...live }` keeps EVERY own enumerable key, it is not a
// projection), and `ReportEnvelope.reporter.user` is declared with three
// optional strings and `.passthrough()`, so extras validate fine. Access
// tokens, addresses, roles and nested profile blobs shipped into durable SDK
// outboxes, event storage, admin API responses and outbound webhooks — a
// privacy incident produced by ordinary use of a documented API.
//
// The fix is a projection applied where the value ENTERS the SDK, so every
// downstream reader is clean BY CONSTRUCTION rather than by each consumer
// remembering to sanitize. There are exactly two such entrances on web and
// both call this function:
//
//   1. `client.setUser()` (sdk-core) — the host-facing API. Everything that
//      reads `state.user` (the in-process report path via the Provider's
//      getter, the companion path via `CompanionHost.getUser`, and the web
//      crash sink) is downstream of it.
//   2. `captureUserSnapshot()` (sdk-react) — the submit-boundary snapshot. It
//      is a SECOND entrance, not merely a reader: the companion seam reads
//      through a host-implemented `CompanionHost.getUser()`, and a hand-wired
//      host can supply that without the Provider (and therefore without
//      `setUser`) ever having been involved.
//
// Deliberately NOT fixed by tightening `packages/protocol`'s `.passthrough()`:
// that exists for forward compatibility of the envelope as a whole — an older
// server must keep parsing a newer SDK's envelope — and narrowing it would
// trade a much larger property away for a problem that belongs at the SDK
// boundary anyway. An envelope that reached ingest with extras would already
// have been persisted by the SDK's outbox.
import type { UserMetadata } from './types/config.js';

/**
 * The ONLY keys `setUser` accepts. Kept as a runtime array precisely because
 * the `UserMetadata` interface cannot be one — adding a field to the interface
 * without adding it here means the field is silently dropped, which is the
 * safe direction to fail.
 */
const USER_KEYS = ['id', 'email', 'displayName'] as const;

/**
 * Project an arbitrary host-supplied value down to exactly
 * `{ id?, email?, displayName? }`, keeping only the keys whose value is a
 * string. Anything else — extra properties, nested objects, numbers, symbols,
 * arrays, a non-object argument — is dropped.
 *
 * NEVER THROWS. A property access can run a host getter (a class instance with
 * a computed `email`, a Proxy, a MobX/Vue reactive object), and recognition
 * must never fail or delay a report, so a throwing key is skipped
 * individually: one exploding getter costs its own field, not the whole user
 * and certainly not the report.
 *
 * Returns `null` for a nullish/non-object input so callers keep the
 * "no user set" shape they already had. A non-null object projects to an
 * object even when nothing survives — `setUser({ token })` means the host
 * declared a user, and an empty `user` object is what the pre-existing
 * `setUser({})` already produced; deciding that such a report is anonymous is
 * ingest's call (`normalizeSelfDeclaredUser`), not the SDK's.
 */
export function projectUserMetadata(value: unknown): UserMetadata | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const projected: UserMetadata = {};
  for (const key of USER_KEYS) {
    try {
      const raw = source[key];
      if (typeof raw === 'string') projected[key] = raw;
    } catch {
      /* swallow — a throwing host getter drops its own field, nothing else */
    }
  }
  return projected;
}
