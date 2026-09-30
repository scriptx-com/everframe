// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The global object without a bare `globalThis` reference, which is a
// ReferenceError on Chrome < 71 (webOS 4 ships Chrome 53). `typeof` on an
// undeclared identifier is safe on every engine.
type GlobalScope = typeof globalThis;

export function globalScope(): GlobalScope {
  if (typeof globalThis !== 'undefined') return globalThis;
  if (typeof self !== 'undefined') return self as unknown as GlobalScope;
  return window as unknown as GlobalScope;
}

/**
 * Defines `globalThis` when the engine lacks it. Only for third-party code
 * bundled into the smart-TV path (rrweb-snapshot reads `globalThis.Zone` and
 * `globalThis[name]`), run just before that code; a no-op everywhere else.
 */
export function ensureGlobalThis(
  scope: object = globalScope(),
  present: () => boolean = () => typeof globalThis !== 'undefined',
): void {
  if (present()) return;
  try {
    Object.defineProperty(scope, 'globalThis', { value: scope, writable: true, configurable: true });
  } catch {
    /* a frozen global: nothing more to do */
  }
}
