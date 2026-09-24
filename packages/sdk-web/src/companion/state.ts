// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 06.2-09 Task 1 — React-TV companion runtime state surface.
//
// Mirrors iOS `CompanionState` (packages/sdk-ios/Sources/Everframe/Companion/
// CompanionState.swift) and Android `CompanionState` (packages/sdk-android/
// android/everframe-core/src/main/kotlin/com/everframe/companion/CompanionState.kt)
// for cross-runtime parity per SPEC Req 3 + Req 4.
//
// Subscription pattern mirrors `adapter.ts`'s TS-callback observable shape —
// private vars + Set<handler>, no RxJS / Zustand. CompanionState handlers are
// fired only when oldValue !== newValue (parity with the dual-surface no-op
// guard in iOS @Published / Android StateFlow).
//
// SDK-internal seams (`__setState` / `__setPairUrl`) are the SOLE writers —
// the relay-WS client (`ws-client.ts`) calls them; hosts may NOT mutate state
// directly. Naming follows the existing `__openReporter` / `__resolveReporterUI`
// convention in `adapter.ts`.
'use client';

export type CompanionState =
  | 'unpaired'
  | 'paired'
  | 'report_in_progress'
  | 'phone_disconnected';

export type CompanionStateHandler = (
  oldVal: CompanionState,
  newVal: CompanionState,
) => void;

export type CompanionPairUrlHandler = (url: string | null) => void;
export type CompanionCodeHandler = (code: string | null) => void;
export type CompanionAttachedUserNameHandler = (name: string | null) => void;
export type CompanionResolvedNameHandler = (name: string | null) => void;

/**
 * Live attach-PIN challenge (spec 2026-08-19) — the relay pushes this when a
 * dashboard member requests attach to this TV; the SDK shows `code` on
 * screen and the member types it into the dashboard. Mirrors the wire
 * `attach.challenge` frame's fields, camelCased.
 */
export interface CompanionAttachChallenge {
  code: string;
  requestedByName: string;
  ttlMs: number;
}
export type CompanionAttachChallengeHandler = (
  c: CompanionAttachChallenge | null,
) => void;

export interface CompanionAPI {
  /** Current state — snapshot, never throws. */
  getState(): CompanionState;
  /** Current pairing URL. Set on `pair.created`, retained across bond/expiry,
   *  nulled only when the relay socket closes. */
  getPairUrl(): string | null;
  /**
   * Short display code from a successful `/api/companion/announce` call
   * (spec 2026-08-07) — the host renders it beside/instead of the QR so a
   * team member can type it into the dashboard's attach flow. `null` when
   * companion discovery wasn't attempted (no `sdkKey` passed to
   * `companion.start()`) or the announce call failed for any reason —
   * announce failing must never block pairing, only discovery, so this is a
   * pure display affordance with no effect on `state`/`pairUrl`. Retained
   * across bond (same lifecycle as `pairUrl`); nulled only when the relay
   * socket closes.
   */
  getCode(): string | null;
  /**
   * Display name from the `pair.bonded` frame's optional `companion_user`
   * block (dashboard-initiated attach only — absent on an ordinary QR bond).
   * Hosts may surface it in a "Paired with <name>" indicator. Retained
   * across the same lifecycle as `pairUrl`/`code`; nulled only when the
   * relay socket closes.
   */
  getAttachedUserName(): string | null;
  /**
   * Resolved display name from the announce response (custom rename → host
   * label → server-composed default), updated live by `companion.name`
   * pushes; same lifecycle as `code` — nulled on terminal socket close.
   */
  getResolvedName(): string | null;
  /**
   * Live attach-PIN challenge (spec 2026-08-19), or `null` when none is in
   * flight. Set on the relay's `attach.challenge` frame; cleared on
   * `attach.challenge.cleared` OR whenever the relay socket closes (a dead
   * socket means the server can no longer clear it for us).
   */
  getAttachChallenge(): CompanionAttachChallenge | null;
  /**
   * Subscribe to state transitions. Handler receives `(oldVal, newVal)` only
   * when the value actually changes — no-op writes do NOT re-fire (parity with
   * iOS @Published / Android StateFlow distinctUntilChanged semantics).
   * @returns unsubscribe function (idempotent).
   */
  onState(handler: CompanionStateHandler): () => void;
  /**
   * Subscribe to pairUrl changes. Handler fires on any value flip including
   * `null → string` (pair.created) and `string → null` (socket close —
   * terminal/permanent). It does NOT flip to null on bond or expiry; use
   * `onState` to drive QR teardown.
   */
  onPairUrl(handler: CompanionPairUrlHandler): () => void;
  /** Subscribe to `code` changes. Mirrors `onPairUrl`. */
  onCode(handler: CompanionCodeHandler): () => void;
  /** Subscribe to `attachedUserName` changes. Mirrors `onPairUrl`. */
  onAttachedUserName(handler: CompanionAttachedUserNameHandler): () => void;
  /** Subscribe to `resolvedName` changes. Mirrors `onPairUrl`. */
  onResolvedName(handler: CompanionResolvedNameHandler): () => void;
  /**
   * Subscribe to `attachChallenge` changes. Handler fires on any value flip
   * — a fresh challenge (new `code`), and the `null` transition when it's
   * cleared/expired/superseded/the socket dies.
   */
  onAttachChallenge(handler: CompanionAttachChallengeHandler): () => void;
  /**
   * SDK-internal seam — relay-WS client + capture-bridge are the SOLE callers.
   * Host code MUST NOT touch this; future API ergonomics may relocate it.
   */
  __setState(s: CompanionState): void;
  /** SDK-internal — see `__setState`. */
  __setPairUrl(u: string | null): void;
  /** SDK-internal — see `getCode`. Sole writer: `ws-client.ts`'s `buildUrl`. */
  __setCode(c: string | null): void;
  /** SDK-internal — see `getAttachedUserName`. Sole writer: `ws-client.ts`'s `pair.bonded` handler. */
  __setAttachedUserName(n: string | null): void;
  /** SDK-internal — see `getResolvedName`. Sole writer: `ws-client.ts`'s announce success/failure and `companion.name` handlers. */
  __setResolvedName(n: string | null): void;
  /** SDK-internal — see `getAttachChallenge`. Sole writer: `ws-client.ts`'s `attach.challenge`(`.cleared`) handlers. */
  __setAttachChallenge(c: CompanionAttachChallenge | null): void;
}

/**
 * Create a fresh companion state surface. One per SDK instance; not a
 * singleton — multiple Everframe clients on the same page each carry their own
 * companion state (matches `createWebPlatformAdapter` factory shape).
 */
export function createCompanion(): CompanionAPI {
  let state: CompanionState = 'unpaired';
  let pairUrl: string | null = null;
  let code: string | null = null;
  let attachedUserName: string | null = null;
  let resolvedName: string | null = null;
  let attachChallenge: CompanionAttachChallenge | null = null;
  const stateHandlers = new Set<CompanionStateHandler>();
  const pairUrlHandlers = new Set<CompanionPairUrlHandler>();
  const codeHandlers = new Set<CompanionCodeHandler>();
  const attachedUserNameHandlers = new Set<CompanionAttachedUserNameHandler>();
  const resolvedNameHandlers = new Set<CompanionResolvedNameHandler>();
  const attachChallengeHandlers = new Set<CompanionAttachChallengeHandler>();

  return {
    getState: (): CompanionState => state,
    getPairUrl: (): string | null => pairUrl,
    getCode: (): string | null => code,
    getAttachedUserName: (): string | null => attachedUserName,
    getResolvedName: (): string | null => resolvedName,
    getAttachChallenge: (): CompanionAttachChallenge | null => attachChallenge,
    onState: (handler: CompanionStateHandler): (() => void) => {
      stateHandlers.add(handler);
      return () => {
        stateHandlers.delete(handler);
      };
    },
    onPairUrl: (handler: CompanionPairUrlHandler): (() => void) => {
      pairUrlHandlers.add(handler);
      return () => {
        pairUrlHandlers.delete(handler);
      };
    },
    onCode: (handler: CompanionCodeHandler): (() => void) => {
      codeHandlers.add(handler);
      return () => {
        codeHandlers.delete(handler);
      };
    },
    onAttachedUserName: (handler: CompanionAttachedUserNameHandler): (() => void) => {
      attachedUserNameHandlers.add(handler);
      return () => {
        attachedUserNameHandlers.delete(handler);
      };
    },
    onResolvedName: (handler: CompanionResolvedNameHandler): (() => void) => {
      resolvedNameHandlers.add(handler);
      return () => {
        resolvedNameHandlers.delete(handler);
      };
    },
    onAttachChallenge: (handler: CompanionAttachChallengeHandler): (() => void) => {
      attachChallengeHandlers.add(handler);
      return () => {
        attachChallengeHandlers.delete(handler);
      };
    },
    __setState: (next: CompanionState): void => {
      if (next === state) return; // distinctUntilChanged — DEFE-02 no-op guard
      const prev = state;
      state = next;
      for (const h of stateHandlers) {
        try {
          h(prev, next);
        } catch {
          // swallow handler errors — DEFE-02: never let host code break the
          // SDK's state-write seam (mirrors iOS NotificationCenter post which
          // catches observer throws by default).
        }
      }
    },
    __setPairUrl: (next: string | null): void => {
      if (next === pairUrl) return;
      pairUrl = next;
      for (const h of pairUrlHandlers) {
        try {
          h(next);
        } catch {
          // swallow — DEFE-02
        }
      }
    },
    __setCode: (next: string | null): void => {
      if (next === code) return;
      code = next;
      for (const h of codeHandlers) {
        try {
          h(next);
        } catch {
          // swallow — DEFE-02
        }
      }
    },
    __setAttachedUserName: (next: string | null): void => {
      if (next === attachedUserName) return;
      attachedUserName = next;
      for (const h of attachedUserNameHandlers) {
        try {
          h(next);
        } catch {
          // swallow — DEFE-02
        }
      }
    },
    __setResolvedName: (next: string | null): void => {
      if (next === resolvedName) return;
      resolvedName = next;
      for (const h of resolvedNameHandlers) {
        try {
          h(next);
        } catch {
          // swallow — DEFE-02
        }
      }
    },
    __setAttachChallenge: (next: CompanionAttachChallenge | null): void => {
      // Compare by `code`, not reference/deep-equality: a fresh challenge
      // always mints a new random code, so `code` equality is exactly the
      // distinct-until-changed signal that matters here — the `null`
      // transitions are what drive the card mounting/unmounting.
      const prevCode = attachChallenge?.code ?? null;
      const nextCode = next?.code ?? null;
      if (nextCode === prevCode) return;
      attachChallenge = next;
      for (const h of attachChallengeHandlers) {
        try {
          h(next);
        } catch {
          // swallow — DEFE-02
        }
      }
    },
  };
}
