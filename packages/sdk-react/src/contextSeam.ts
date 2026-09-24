// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Module-level context seam. The top-level `open()` convenience MUST work
// from non-React call sites (global error handlers, route handlers, third-
// party event bridges) where `useEverframe()` is unavailable. We stash a
// single current-runtime reference here; the provider writes on mount /
// clears on unmount; top-level `open()` reads-or-throws.
//
// Mirrors @everframe/react-native/src/contextSeam.ts so the two
// SDKs share an identical public surface — flat `open()` (no `report.*`
// nesting) returning Promise<ReporterResult>.
//
// Single-instance enforcement: a second mount throws — two providers in one
// process would race on this slot and silently spoof the `open()` destination.
import type { AddBreadcrumbInput, CaptureExceptionOptions, ExtraResolver, UserMetadata } from '@everframe/sdk-core';
import { type ReporterResult, EverframeNotMountedError } from '@everframe/web';

export { EverframeNotMountedError };
export type { ReporterResult };

/**
 * Shape exposed via `useEverframe()` and the top-level `open` re-export.
 * Kept minimal so the seam can be shared across renders without re-creating
 * function identities on every Provider state change.
 */
export interface EverframeContextSeamValue {
  open(): Promise<ReporterResult>;
  addBreadcrumb(input: AddBreadcrumbInput): void;
  captureException(error: unknown, options?: CaptureExceptionOptions): void;
  setUser(user: UserMetadata | null): void;
  setExtra(value: string | Record<string, unknown> | ExtraResolver): void;
  recordScreen(name: string, data?: Record<string, unknown>): void;
}

let __currentContext: EverframeContextSeamValue | null = null;

export function __setCurrentContext(ctx: EverframeContextSeamValue | null): void {
  if (ctx !== null && __currentContext !== null) {
    // eslint-disable-next-line no-console
    console.error(
      '[everframe] A second <EverframeProvider> was mounted while one was already active. ' +
        'Only one provider may be mounted per process. The new provider is being ignored ' +
        'for top-level `open()` routing.',
    );
    return;
  }
  __currentContext = ctx;
}

export function __getCurrentContext(): EverframeContextSeamValue | null {
  return __currentContext;
}

/**
 * Top-level imperative `open` re-export. Inside the React tree, prefer
 * `useEverframe().open()`. This exists for non-component call sites.
 */
export function open(): Promise<ReporterResult> {
  const ctx = __currentContext;
  if (!ctx) {
    return Promise.reject(
      new EverframeNotMountedError(
        'EverframeProvider not mounted; wrap your root with <EverframeProvider>.',
      ),
    );
  }
  return ctx.open();
}

/**
 * Top-level `addBreadcrumb` for non-component call sites — router listeners,
 * global error handlers, analytics bridges. Mirrors
 * `@everframe/react-native`'s seam of the same name, including its no-op-when-
 * unmounted contract: only `open()` above rejects, because a caller awaiting a
 * report needs to know it never happened, whereas a marker dropped before mount
 * is simply a marker for a session that isn't being recorded.
 *
 * For navigation specifically, prefer `recordScreen` below instead of
 * hand-rolling a `kind: 'navigation'` crumb here — it derives the `from → to`
 * transition the same way the native SDKs do.
 *
 * Coercion and gating belong to the client (unknown kinds → `custom`, invalid
 * levels dropped, redaction-passed, size-capped, no-op after `kill()`), so
 * nothing is validated here.
 */
export function addBreadcrumb(input: AddBreadcrumbInput): void {
  __currentContext?.addBreadcrumb(input);
}

/** Report a caught exception; no-op before provider mount and after unmount. */
export function captureException(error: unknown, options?: CaptureExceptionOptions): void {
  __currentContext?.captureException(error, options);
}

/**
 * Navigation screen marker. Records "this screen is now visible"; the SDK
 * derives the `from → to` transition, matching the native SDKs exactly so a
 * web timeline and a native timeline read the same way in one dashboard.
 *
 * This replaces the hand-rolled `addBreadcrumb({ kind: 'navigation', … })`
 * recipe this file used to recommend. That recipe put five rules (blank
 * names, first-screen suppression, A → A suppression, message format, data
 * keys) in every host, and hosts got different subsets of them right.
 *
 * No-op before mount, like `addBreadcrumb` and for the same reason.
 */
export function recordScreen(name: string, data?: Record<string, unknown>): void {
  __currentContext?.recordScreen(name, data);
}

/**
 * Set or clear the active user. Call with NO ARGUMENT to clear — a sign-out
 * must detach the account rather than leave it attached to whoever reports
 * next. Mirrors `@everframe/react-native`'s `setUser`.
 */
export function setUser(user?: UserMetadata): void {
  __currentContext?.setUser(user ?? null);
}

/**
 * Attach host-supplied free-form metadata to the next report. Each call
 * REPLACES the previous value.
 *
 * PREFER THE RESOLVER FORM — `setExtra(() => buildReportExtra())` — over a
 * pushed string/object snapshot. The dashboard hotkey opens the reporter
 * DIRECTLY, with no chance for this host to refresh a pushed snapshot
 * first, so a host that pushes has to enumerate every input its payload
 * depends on and re-push on each one changing; miss one and the report
 * silently ships stale data (e.g. a stale player snapshot on a playback-bug
 * report because the refresh effect fired on route change but not on an
 * in-screen channel switch). The resolver is evaluated when the SDK
 * assembles the report, so it always sees current values with no effect to
 * write or keep in sync. See `EverframeClient['setExtra']` (sdk-core) for the
 * full contract, including throw safety.
 *
 * String/object forms are still supported; pass a string or an object — the
 * SDK serializes an object for you. Every form is capped at
 * `EXTRA_MAX_CHARS` (16 KiB); an over-budget value is omitted from the
 * report, with a warning (at the call site for string/object, at read time
 * for a resolver).
 *
 * No-op before mount, like `addBreadcrumb`/`recordScreen` and for the same
 * reason.
 */
export function setExtra(value: string): void;
export function setExtra(value: Record<string, unknown>): void;
export function setExtra(resolve: ExtraResolver): void;
export function setExtra(value: string | Record<string, unknown> | ExtraResolver): void {
  __currentContext?.setExtra(value);
}
