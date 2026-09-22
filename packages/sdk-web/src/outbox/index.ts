// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type { OutboxAdapter } from '@traceitx/sdk-core';
import { createInMemoryOutbox } from '@traceitx/sdk-core';
import { createLocalStorageOutbox } from './localStorage.js';

let warnedFallback = false;

/** Test-only — reset the once-warn latch between specs. */
export function __resetOutboxWarnLatchForTesting(): void {
  warnedFallback = false;
}

/**
 * Pick localStorage outbox first (PIPE-02 reload-survival per CONTEXT lock).
 * Fall back to in-memory when localStorage is unavailable (private mode, quota=0, SSR).
 *
 * The fallback emits a one-time console.warn so customers running in restricted
 * environments know reports won't survive page reload. Latch is module-scoped so the
 * warn fires once per JS realm/session — not per createOutbox call.
 */
export function createOutbox(): OutboxAdapter {
  const ls = createLocalStorageOutbox();
  if (ls) return ls;
  if (!warnedFallback) {
    warnedFallback = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[traceitx] localStorage unavailable; outbox falling back to in-memory (reports will NOT survive page reload).',
    );
  }
  return createInMemoryOutbox();
}
