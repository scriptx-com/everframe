// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The surface every React-family SDK owes a host, asserted against both
// barrels. It exists because four capabilities drifted onto one platform and
// not the other, and each absence was paid for by every host that shipped
// both — in per-app façade code the SDK never saw.
//
// INTERNAL. Deliberately not re-exported from src/index.ts, so tsup never
// bundles it into the published artifact.
//
// Platform-bound members stay OUT rather than being faked into false
// symmetry: native shake, Sensitive vs EverframeSensitive, web's cspNonce.
//
// SCOPE — read before "improving" this file:
// This guard pins MEMBERSHIP, not SIGNATURES. It asserts that each name
// below exists as a function (and that `companion` is a namespace with
// function `start`/`stop`) on both barrels. It deliberately does NOT assert
// parameter count/arity.
//
// An earlier version of this file did assert `Function.length` per member,
// on the mistaken belief that it measures "is a no-argument call legal".
// It does not: in JavaScript every function is callable with fewer
// arguments than it declares — `Function.length` only reports how many
// parameters sit before the first one with an actual default value
// (`= expr`). TypeScript's `user?: T` optional marker alone does not
// produce a default value, so `setUser(user?: T)` has `Function.length`
// 1, not 0, even though `setUser()` is and always was a legal call. That
// assertion was therefore testing a proxy that didn't hold the property it
// was meant to verify, and "fixing" it meant reshaping public API source
// (`user?: T` → `user: T | undefined = undefined`) purely to satisfy a
// reflection check — the tail wagging the dog. Do not re-add it.
//
// Signature drift (parameter types, required-vs-optional) is caught where
// it belongs: TypeScript at each call site, and each package's own specs —
// e.g. the web-side spec from Task 2 asserting `setUser()` forwards `null`,
// and sdk-react-native's `set-user.spec.ts` asserting the same no-arg path.
// This file's job stops at "does the member exist on both platforms."
import { expect } from 'vitest';

export const HOST_SURFACE_MEMBERS: ReadonlyArray<string> = [
  'open',
  'setUser',
  'setExtra',
  'addBreadcrumb',
  'captureException',
  'recordScreen',
  'useCompanion',
];

/**
 * Assert a barrel satisfies the contract: every name in
 * `HOST_SURFACE_MEMBERS` exists as a function, and `companion` is a
 * namespace exposing `start`/`stop` functions. See the module doc comment
 * above for why this checks presence only, not arity.
 */
export function assertHostSurface(mod: Record<string, unknown>, label: string): void {
  for (const name of HOST_SURFACE_MEMBERS) {
    const member = mod[name];
    expect(typeof member, `${label} must export ${name}`).toBe('function');
  }

  expect(typeof mod.companion, `${label} must export a companion namespace`).toBe('object');
  const companion = mod.companion as Record<string, unknown>;
  for (const name of ['start', 'stop']) {
    expect(typeof companion[name], `${label}.companion.${name}`).toBe('function');
  }
}
