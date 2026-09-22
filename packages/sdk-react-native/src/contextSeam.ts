// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Module-level context seam. The top-level `open()` convenience MUST work
// from non-React call sites (global error handlers, deep-link handlers,
// native event bridges) where `useTraceItX()` is unavailable. We stash a
// single current-runtime reference here. The provider writes on mount /
// clears on unmount; top-level `open()` reads-or-throws.
//
// Single-instance enforcement (T-06-05-04): a second mount throws — two
// providers in one process would race on this slot and silently spoof the
// `open()` destination.
import { type ReporterResult, TraceItXNotMountedError } from './reporter/types.js';
import type { CaptureExceptionOptions, ExtraResolver } from '@traceitx/sdk-core';
import type { TXUserSpec } from './NativeTraceItX.js';

export { TraceItXNotMountedError };

/** Shape exposed via `useTraceItX()` and the top-level `open` re-export. */
export interface TraceItXContextValue {
  /** Capture a handled exception without opening the reporter. No-op outside the owning mount. */
  captureException(error: unknown, options?: CaptureExceptionOptions): void;
  /**
   * Open the native reporter modal. Resolves with the user-facing outcome
   * (`submitted` / `queued` / `cancelled`). Replaces the pre-0.3 nested
   * `report.open()` — the `.report` namespace held only `.open` so flattening
   * matches sdk-react.
   */
  open(): Promise<ReporterResult>;
  sensitive: {
    register(tag: number, rect: { x: number; y: number; width: number; height: number }): void;
    unregister(tag: number): void;
  };
  /**
   * Attach host-supplied free-form metadata to the next report. Each call
   * REPLACES the previous value. Auto-cleared after the next `open()`
   * resolves.
   *
   * Prefer the OBJECT form so the SDK serializes it for you before crossing
   * the bridge. Either form is capped at `EXTRA_MAX_CHARS` (16 KiB): an
   * over-budget object is omitted (a warning is logged), because slicing
   * serialized JSON yields a fragment nothing can parse; an over-budget
   * string is still forwarded to the native side as-is, which applies its
   * own 16 KiB ceiling as a raw character cut, not JSON-aware. Pass an empty
   * string to detach.
   */
  setExtra(value: string): void;
  setExtra(value: Record<string, unknown>): void;
  /**
   * Resolver form (spec 2026-09-17 setExtra-resolver) — matches
   * `@traceitx/sdk-core`'s `setExtra(resolve: ExtraResolver)` signature
   * exactly. PREFER THIS over the string/object forms above: triggers the
   * SDK owns (native shake on mobile) open the reporter DIRECTLY, with no
   * chance for the host to refresh a pushed snapshot first — see the fuller
   * rationale on `@traceitx/sdk-core`'s `TraceItXClient.setExtra`. The
   * resolver is stored, never called at registration time; native ASKS for
   * it (a bounded round trip to JS, mirroring the companion
   * `reportRequested` handshake) right before it drains pending attachments
   * for a report, so it always sees current values with no effect to write
   * or keep in sync. A throwing resolver never breaks the report: it is
   * caught, warned, and `extra` is simply omitted from that report — same
   * budgeting as the object form (`budgetExtra`), applied to the resolver's
   * return value at resolve time instead of at registration time.
   */
  setExtra(resolve: ExtraResolver): void;
  /**
   * Manual escape hatch (Plan 4 / Task 14): drop a host-supplied marker into
   * the native breadcrumb chain — object-form, matching the web SDK
   * signature. RN apps already inherit ALL native auto-capture underneath RN
   * (lifecycle/error/console/network-opt-in/tap/nav); JS-side auto-capture
   * (fetch/react-navigation/touch patches) is an explicit non-goal of this
   * plan. `addBreadcrumb` and `recordScreen` (spec 2026-07-14) are the only
   * JS-initiated crumb paths.
   *
   * NO validation/coercion happens here or on the bridge — the call is
   * forwarded positionally to the native TurboModule spec method, which
   * forwards straight to the platform singleton (`TraceItX.shared
   * .addBreadcrumb` on iOS / `TraceItX.addBreadcrumb` on Android). That
   * singleton owns ALL coercion (unknown `kind` → `custom`, invalid `level`
   * dropped rather than defaulted, `data` JSON-coerced) and gating (no-op
   * pre-start / while killed).
   */
  addBreadcrumb(input: { message: string; kind?: string; level?: string; data?: object }): void;

  /**
   * Navigation screen marker (spec 2026-07-14): record "this screen is now
   * visible". The native side derives the `from → to` transition (global
   * chain shared with native auto-capture), gates, and coerces — nothing
   * happens JS-side. Prefer the `useTXScreen` hook / `<TXScreen>` component;
   * this raw form suits onStateChange-style whole-app wiring.
   */
  recordScreen(name: string, data?: Record<string, unknown>): void;

  /**
   * Set or clear the active user for self-declared recognition. Call with no
   * argument to clear. Unverified: a label, never a credential.
   */
  setUser(user?: TXUserSpec): void;
}

let __currentContext: TraceItXContextValue | null = null;

export function __setCurrentContext(ctx: TraceItXContextValue | null): void {
  __currentContext = ctx;
}

export function __getCurrentContext(): TraceItXContextValue | null {
  return __currentContext;
}

/**
 * Top-level imperative `open` re-export. Inside the React tree, prefer
 * `useTraceItX().open()`. This re-export exists for non-component call
 * sites (global error handlers, deep-link handlers, native event bridges).
 */
export function open(): Promise<ReporterResult> {
  const ctx = __currentContext;
  if (!ctx) {
    return Promise.reject(
      new TraceItXNotMountedError(
        'TraceItXProvider not mounted; wrap your root with <TraceItXProvider>.'
      )
    );
  }
  return ctx.open();
}

/** Top-level `setExtra` for non-component call sites. No-op if no provider mounted. */
export function setExtra(value: string): void;
export function setExtra(value: Record<string, unknown>): void;
export function setExtra(resolve: ExtraResolver): void;
export function setExtra(
  value: string | Record<string, unknown> | ExtraResolver,
): void {
  if (typeof value === 'function') {
    __currentContext?.setExtra(value);
  } else if (typeof value === 'string') {
    __currentContext?.setExtra(value);
  } else {
    __currentContext?.setExtra(value);
  }
}

/**
 * Top-level `addBreadcrumb` for non-component call sites (global error
 * handlers, deep-link handlers, native event bridges). No-op if no provider
 * mounted — matches `setExtra` above. See
 * `TraceItXContextValue.addBreadcrumb` for the full contract.
 */
export function addBreadcrumb(input: {
  message: string;
  kind?: string;
  level?: string;
  data?: object;
}): void {
  __currentContext?.addBreadcrumb(input);
}

/**
 * Top-level `recordScreen` for non-component call sites (e.g. a
 * react-navigation `onStateChange` handler). No-op if no provider mounted —
 * matches `setExtra`/`addBreadcrumb` above.
 */
export function recordScreen(name: string, data?: Record<string, unknown>): void {
  if (data !== undefined) {
    __currentContext?.recordScreen(name, data);
  } else {
    __currentContext?.recordScreen(name);
  }
}

/** Top-level `setUser` for non-component call sites. No-op if no provider mounted. */
export function setUser(user?: TXUserSpec): void {
  __currentContext?.setUser(user);
}

/** Capture a handled exception from any call site. No-op without a mounted provider. */
export function captureException(error: unknown, options?: CaptureExceptionOptions): void {
  __currentContext?.captureException(error, options);
}
