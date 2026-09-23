// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { useContext, useEffect, useState } from 'react';
import { EverframeContext } from './provider.js';
import type { EverframeClient } from '@everframe/sdk-core';
import { trackPlayer, trackVitals } from '@everframe/web';
import type { ReporterResult } from '@everframe/web';

/**
 * Public surface returned by `useEverframe()`. Matches the RN SDK shape —
 * flat `open()` returning a Promise that resolves with the report outcome.
 */
export interface UseEverframeReturn {
  /**
   * Open the reporter modal. Resolves with the user-facing outcome:
   *   - 'submitted' — envelope shipped successfully (reportId populated).
   *   - 'queued'    — envelope persisted to the outbox for retry (reportId populated).
   *   - 'cancelled' — user dismissed without submitting.
   */
  open: () => Promise<ReporterResult>;
  setUser: EverframeClient['setUser'];
  /**
   * Reporter identity recognition (spec 2026-08-06). Pass a signed JWT, a
   * provider function the SDK re-asks as the token nears expiry, or `null`
   * on sign-out. See `EverframeClient['setIdentityToken']`'s doc comment
   * (sdk-core) for the full contract — recognition never blocks or fails a
   * report.
   *
   * CALL IT ONCE, not on every render. `useEverframe()` returns a freshly
   * `.bind()`-ed function on every call, so `setIdentityToken` is a new
   * function identity each render — a `useEffect(() => setIdentityToken(x),
   * [setIdentityToken, x])` dependent on it re-runs every render. With a
   * one-shot string that's a harmless no-op re-set; with a PROVIDER function
   * it is not: `IdentityTokenHolder.set()` unconditionally drops the cached
   * token (see identity-token.ts), so a provider re-set on every render
   * forces a fresh host-provider call (and a fresh 2s-timeout exposure) on
   * every render instead of only as the token nears expiry. Call it once at
   * init (e.g. inside a `useEffect` with an empty dependency array, or right
   * after sign-in) with a reference that's stable across renders.
   */
  setIdentityToken: EverframeClient['setIdentityToken'];
  /** Attach host free-form metadata (opaque string) to the next report. Mirrors the RN SDK. */
  setExtra: EverframeClient['setExtra'];
  /**
   * Drop a host-supplied marker into the action timeline (`payload.breadcrumbs`)
   * — redaction-passed and size-capped exactly like automatic crumbs.
   *
   * Pass `kind: 'navigation'` to supply screen transitions the automatic
   * History-API capture cannot see: it keys on `pathname + search`, so a hash
   * router (or any navigator that doesn't touch the URL) produces no crumbs of
   * its own. See the top-level `addBreadcrumb` export for non-component call
   * sites such as a router subscription.
   */
  addBreadcrumb: EverframeClient['addBreadcrumb'];
  /** Report a caught exception without opening the reporter. */
  captureException: EverframeClient['captureException'];
  markSensitive: EverframeClient['markSensitive'];
  kill: EverframeClient['kill'];
  /** Two-way replies facade (spec 2026-07-31) — inert when the platform adapter didn't wire a thread client. */
  threads: EverframeClient['threads'];
  /** Live-updating unread count across all threads; mirrors `threads.subscribe()`. */
  unreadCount: number;
  /** Session Vitals phase 4 — attach a media element for per-player playback tracing. Re-exported from `@everframe/web`. */
  trackPlayer: typeof trackPlayer;
  /** Session Vitals phase 4 — emit a vitals event, optionally scoped to a player handle. Re-exported from `@everframe/web`. */
  trackVitals: typeof trackVitals;
}

export function useEverframe(): UseEverframeReturn {
  const ctx = useContext(EverframeContext);
  if (!ctx) throw new Error('useEverframe called outside <EverframeProvider>');

  // Two-way replies (Task 8) — live unread count, same useCompanion-style
  // bridge (companion/singleton.ts): seed from the current snapshot, then
  // subscribe for the life of this hook instance.
  const [unreadCount, setUnreadCount] = useState(() => ctx.client.threads.unreadCount());
  useEffect(() => {
    setUnreadCount(ctx.client.threads.unreadCount());
    return ctx.client.threads.subscribe((s) => setUnreadCount(s.unreadCount));
  }, [ctx]);

  return {
    open: () => ctx.adapter.__openReporter(),
    setUser: ctx.client.setUser.bind(ctx.client),
    setIdentityToken: ctx.client.setIdentityToken.bind(ctx.client),
    setExtra: ctx.client.setExtra.bind(ctx.client),
    addBreadcrumb: ctx.client.addBreadcrumb.bind(ctx.client),
    captureException: (error, options) => ctx.client.captureException(error, options),
    markSensitive: ctx.client.markSensitive.bind(ctx.client),
    kill: ctx.client.kill.bind(ctx.client),
    threads: ctx.client.threads,
    unreadCount,
    trackPlayer,
    trackVitals,
  };
}
