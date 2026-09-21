// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

/**
 * The SDK touches `window`, `document` and `localStorage` during `init()`.
 * Under SSR that would throw somewhere deep in the adapter with a message
 * naming an internal module the host has never heard of, so fail early with
 * one that says what to do instead.
 */
export function assertBrowser(): void {
  if (typeof window !== 'undefined' && typeof document !== 'undefined') return;
  throw new Error(
    'TraceItX can only run in a browser. init() touches window, document and ' +
      'localStorage, so call it from a client-side lifecycle hook — Vue: onMounted(), ' +
      'Svelte: onMount(), React: useEffect(), Astro: a client: directive — rather than ' +
      'at module scope in code that is server-rendered.',
  );
}
