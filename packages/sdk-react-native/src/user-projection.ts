// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// External review, finding 2 (Serious) — an invalid `setUser` field left the
// PREVIOUS user installed on React Native.
//
// `runtime.ts` used to hand the host's object straight across the TurboModule
// bridge. `TXUserSpec` is a TypeScript type: it has no runtime existence, and
// the bridge parameter is `UnsafeObject` anyway, so ANY value crosses. On
// Android, `TraceItXModule.setUser` then called `getString(key)` guarded only
// by `hasKey(key)` — and `ReadableMap.getString` THROWS on a non-string value.
// `txGuardVoid` swallowed that exception BEFORE `TraceItX.setUser()` was ever
// reached, so `setUser({ id: 12345 })` was a silent no-op and every subsequent
// report stayed attributed to whoever was set before.
//
// That is the worst available outcome. A host that calls `setUser` is
// explicitly re-declaring who is using the app; the acceptable results are the
// new (possibly partial) user or anonymous — never the OLD user.
//
// The primary fix is here, in the JS facade, so native never receives a bad
// type in the first place. The Android module additionally reads defensively
// (type-checked, not key-presence-checked) so a hand-wired caller cannot wedge
// it either, and iOS's `as? String` already degraded safely.
//
// Semantics mirror web's `projectUserMetadata` (`packages/sdk-core/src/
// user-projection.ts`) exactly — same three keys, same keep-only-strings rule,
// same never-throws contract — because a host moving between the two SDKs must
// not discover that `setUser` means something different on each. The one
// deliberate difference is the empty return value: web returns `null`, this
// returns `undefined`, because the TurboModule bridge forbids `T | null` and
// "call with no argument" is how RN expresses a clear.
import type { TXUserSpec } from './NativeTraceItX.js';

/**
 * The ONLY keys `setUser` accepts. A runtime array precisely because the
 * `TXUserSpec` type cannot be one — adding a field to the type without adding
 * it here means the field is silently dropped, which is the safe direction to
 * fail.
 */
const USER_KEYS = ['id', 'email', 'displayName'] as const;

/**
 * Project an arbitrary host-supplied value down to exactly
 * `{ id?, email?, displayName? }`, keeping only the keys whose value is a
 * string. Anything else — extra properties, nested objects, numbers, booleans,
 * arrays — is dropped.
 *
 * NEVER THROWS. A property access can run a host getter (a class instance with
 * a computed `email`, a Proxy, a MobX observable), and recognition must never
 * fail or delay a report, so a throwing key is skipped individually: one
 * exploding getter costs its own field, not the whole user and certainly not
 * the report.
 *
 * Returns `undefined` for a nullish or non-object input — including
 * `setUser()` with no argument, the documented "clear" call, which must stay a
 * clear and never become a no-op. A non-null OBJECT always projects to an
 * object, even when nothing survives: `setUser({ id: 12345 })` means the host
 * declared a user, so it must REPLACE the previous one (with an empty one)
 * rather than leave it installed. Whether such a report counts as anonymous is
 * ingest's call (`normalizeSelfDeclaredUser`), not the SDK's — exactly as on
 * web.
 */
export function projectUserSpec(value: unknown): TXUserSpec | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const projected: TXUserSpec = {};
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
