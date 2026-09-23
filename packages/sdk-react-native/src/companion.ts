// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 06.2-11 — JS facade for the phone-companion bridge.
//
// Mirrors the native shape of `Everframe.shared.companion` (iOS) and
// `Everframe.companion` (Android):
//
//   • `start(endpoint)` — open the relay WS against `<endpoint>/relay/tv`.
//   • `stop()`          — close the relay WS; observable state retained.
//   • `state`           — `'unpaired' | 'paired' | 'report_in_progress' | 'phone_disconnected'`.
//   • `pairUrl`         — `string | null` (the `<endpoint>/r/<pair_token>` shape).
//   • `code`            — `string | null`, the short display code from
//                         `/api/companion/announce` (spec 2026-08-07). Render
//                         it beside the QR so a team member reading the TV
//                         screen can pick this device out of the dashboard's
//                         Companion list.
//   • `attachedUserName`— `string | null`, the dashboard member who attached
//                         to this device. `null` on an ordinary QR bond.
//   • `resolvedName`    — `string | null`, the SERVER-resolved device
//                         display name (naming spec 2026-08-24) — e.g. an
//                         org-configured friendly name for this device.
//                         `null` before the first successful announce or
//                         when discovery never ran. Replayed to a late
//                         subscriber (external review, finding N5) the same
//                         way `attachChallenge` is — see `onResolvedName`'s
//                         own doc comment.
//   • `attachChallenge` — `CompanionAttachChallenge | null`, the pending
//                         attach-PIN challenge (spec 2026-08-19). The
//                         natives forward this event in EVERY `attachPinUi`
//                         mode, including `'builtin'` (which renders the PIN
//                         natively AND still fires the event) — it's only
//                         NEEDED by hosts configured with `'custom'`, which
//                         must read it to build their own surface.
//   • `useCompanion()`  — React hook returning
//                         `{ state, pairUrl, code, attachedUserName, resolvedName, attachChallenge }`.
//
// The reporter SPA at `<endpoint>/r/<pair_token>` is the phone-side endpoint
// the user opens after scanning the QR — the SPA is served by the relay,
// not embedded here.
//
// Emitter selection:
//   • iOS — `EverframeEventEmitter` (dedicated RCTEventEmitter subclass).
//   • Android — the default RCTDeviceEventEmitter (no module ref needed).
// We construct an `emitter` lazily at first listener attachment so importing
// this module doesn't require NativeEventEmitter wiring before the
// EverframeProvider has configured the native side.

import { useEffect, useState } from 'react';
import NativeEverframe from './NativeEverframe.js';
import { getEmitter } from './events.js';

// Re-exported so any existing import of `getEmitter` from this module keeps
// working unchanged — the implementation moved to `events.ts` (spec
// 2026-09-17 setExtra-resolver) so `runtime.ts` can share it.
export { getEmitter };

/**
 * Companion runtime state — mirrors `CompanionState` in iOS (rawValue) +
 * Android (mapped from the enum via `toRnString`). Keep this union in
 * lock-step with both native sides.
 */
export type CompanionState =
  | 'unpaired'
  | 'paired'
  | 'report_in_progress'
  | 'phone_disconnected';

// Event names — duplicated in `ios/Sources/EverframeEventEmitter.swift` and
// `android/.../EverframeModule.kt`. Keep all three lists in lock-step; on iOS
// an event absent from `supportedEvents()` is silently dropped by RN.
const STATE_EVENT = 'everframe.companion.state';
const PAIR_URL_EVENT = 'everframe.companion.pairUrl';
const CODE_EVENT = 'everframe.companion.code';
const ATTACHED_USER_NAME_EVENT = 'everframe.companion.attachedUserName';
const RESOLVED_NAME_EVENT = 'everframe.companion.resolvedName';
const ATTACH_CHALLENGE_EVENT = 'everframe.companion.attachChallenge';
const REPORT_REQUESTED_EVENT = 'everframe.companion.reportRequested';

/**
 * A pending dashboard-initiated attach-PIN challenge (spec 2026-08-19).
 * Mirrors iOS `CompanionAttachChallenge` / Android `AttachChallengeInfo`.
 * The natives forward this event in every `attachPinUi` mode, including
 * `'builtin'` (which renders the PIN natively AND still fires the event) —
 * it's only NEEDED by hosts configured with `'custom'`, which must read it
 * to build their own surface.
 */
export interface CompanionAttachChallenge {
  code: string;
  requestedByName: string;
  /** Display lifetime — custom UIs should hide the code after this. */
  ttlMs: number;
}

let _reportRequestedSub: { remove: () => void } | null = null;
let _attachChallengeSub: { remove: () => void } | null = null;
let _resolvedNameSub: { remove: () => void } | null = null;
/**
 * Latest `resolvedName` payload, cached module-scope — external review,
 * finding N5. Same problem `_latestAttachChallenge` solves: RN's
 * `NativeEventEmitter` does NOT replay past events to a listener that
 * attaches after the event already fired, so a device name resolved by the
 * announce that ran before a given `onResolvedName` subscriber (or a
 * late-mounted `useCompanion()`) attached would otherwise be permanently
 * invisible to it — the component would show `null` until the NEXT announce,
 * which may be minutes away (or never, if the socket doesn't reconnect).
 * Unlike `_latestAttachChallenge` there is no TTL/expiry to recompute on
 * replay: a resolved name has no lifetime, it simply IS the current value
 * until superseded by another event, so the cache is a plain last-value
 * store with no companion expiry timer.
 */
let _latestResolvedName: string | null = null;
/**
 * Latest `attachChallenge` payload, cached module-scope (spec 2026-08-19
 * review finding 4). RN's `NativeEventEmitter` does NOT replay past events
 * to a listener that attaches after the event already fired — a challenge
 * announced before a custom-UI host's `onAttachChallenge` subscription (or
 * a late-mounted `useCompanion()`) would otherwise be permanently invisible
 * to it, even though the challenge is still live. Kept in lockstep with the
 * event stream ONLY: a null event clears it, but `stop()` deliberately does
 * NOT touch it — `stop()` retains observable state everywhere else in this
 * module (see its own doc comment), and fabricating a clear here would break
 * that symmetry.
 */
let _latestAttachChallenge: CompanionAttachChallenge | null = null;
/**
 * Absolute deadline (`Date.now()` epoch ms) the cached challenge above
 * expires at, derived from the payload's `ttlMs` at the moment it was
 * cached (round-2 review finding 4). Replaying `_latestAttachChallenge`
 * VERBATIM to a late subscriber would hand it the ORIGINAL ttlMs — a
 * subscriber attaching 55s into a 60s challenge would see `ttlMs: 60000`
 * and a custom UI built on it would display a code as freshly-issued far
 * longer than the server actually granted. `attachChallengeReplayValue()`
 * (below) is the only thing allowed to read this pair for a replay.
 */
let _latestAttachChallengeExpiresAt: number | null = null;
/**
 * Does the host WANT a session right now? Distinct from `CompanionState`,
 * which reports what the relay is doing — mirrors the same flag added to
 * `@everframe/web`'s companion singleton. Written only by `start()`/`stop()`
 * below; there is no native event for it, it is purely a JS-side intent
 * flag, so subscribers are tracked the same way the web SDK's
 * `__onCompanionRunning` does rather than through `getEmitter()`.
 */
let _running = false;
const _runningHandlers = new Set<(running: boolean) => void>();

function setRunning(next: boolean): void {
  if (_running === next) return;
  _running = next;
  for (const h of _runningHandlers) h(next);
}
/**
 * Single in-flight timer that nulls the cache pair above the moment the
 * cached challenge's deadline passes — belt-and-suspenders alongside the
 * `remaining <= 0` check `attachChallengeReplayValue()` does inline: without
 * it, a challenge that expired between native events (no
 * `attach.challenge.cleared` frame has landed yet, e.g. mid-sweeper-tick)
 * would still LOOK live to a late subscriber purely because
 * `_latestAttachChallenge` itself was never nulled, even though the replay
 * value itself already correctly clamps to null. Re-armed on every cache
 * write; a stale timer from a superseded challenge must never fire and null
 * out a newer one.
 */
let _attachChallengeExpiryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Open the relay WS connection. The native bridge owns at most one client
 * per process and `start()` is idempotent: calling it again while the
 * companion is already running is a no-op — the socket is NOT recreated.
 * Call `stop()` first, then `start()`, to tear the connection down and open
 * a fresh one.
 *
 * The ingest URL is no longer a JS-side argument — the native SDKs bake it
 * at compile time (Release: https://everframe.dev; Debug: optionally
 * overridden via EVERFRAME_DEV_INGEST_URL on each native build).
 */
export function start(): void {
  setRunning(true);
  NativeEverframe.startCompanion();
  installReportRequestedHandler();
  installAttachChallengeCache();
  installResolvedNameCache();
}

/**
 * Install (idempotent) the listener that acknowledges a `report.request` from
 * the paired phone. The native bridge fires this event BEFORE its capture
 * provider runs and waits ~250ms for our `signalCompanionReportRequestReady`
 * call, so signalling promptly is what keeps the companion capture off that
 * timeout. (It used to walk the React fiber tree here and attach the result;
 * UI-tree capture is gone, so only the acknowledgement remains.) The
 * subscription survives `stop()` so subsequent `start()` calls don't stack
 * duplicates.
 */
function installReportRequestedHandler(): void {
  if (_reportRequestedSub !== null) return;
  _reportRequestedSub = getEmitter().addListener(
    REPORT_REQUESTED_EVENT,
    (correlationId: string) => {
      try {
        NativeEverframe.signalCompanionReportRequestReady(correlationId);
      } catch {
        // Older native SDK without the signal method — bridge will time
        // out on its own. No harm; the report still ships.
      }
    },
  );
}

/**
 * Install (idempotent) the module-scoped listener that keeps
 * `_latestAttachChallenge` in lockstep with the native `attachChallenge`
 * event stream, so a challenge emitted before a given `onAttachChallenge`
 * subscriber (or `useCompanion()` mount) attached is not lost. Mirrors
 * `installReportRequestedHandler`'s idempotency shape; survives `stop()` for
 * the same reason that one does — a subsequent `start()` must not stack a
 * second subscription.
 */
function installAttachChallengeCache(): void {
  if (_attachChallengeSub !== null) return;
  _attachChallengeSub = getEmitter().addListener(
    ATTACH_CHALLENGE_EVENT,
    (payload: CompanionAttachChallenge | null) => {
      cacheAttachChallenge(payload ?? null);
    },
  );
}

/**
 * Install (idempotent) the module-scoped listener that keeps
 * `_latestResolvedName` in lockstep with the native `resolvedName` event
 * stream — external review, finding N5. Mirrors
 * `installAttachChallengeCache`'s idempotency shape and its "installed
 * before/at `start()`, survives `stop()`" lifetime for the same reason: a
 * subsequent `start()` must not stack a second subscription, and `stop()`
 * retains observable state everywhere else in this module (see its own doc
 * comment), so the cache must not be cleared there either.
 */
function installResolvedNameCache(): void {
  if (_resolvedNameSub !== null) return;
  _resolvedNameSub = getEmitter().addListener(
    RESOLVED_NAME_EVENT,
    (name: string | null) => {
      _latestResolvedName = name ?? null;
    },
  );
}

/**
 * Writes `_latestAttachChallenge` + its derived absolute deadline, and
 * (re)arms the single expiry timer. The only writer of either cache field —
 * `installAttachChallengeCache`'s listener is the sole caller — so a
 * superseded challenge's timer is always cleared before a new one is armed.
 */
function cacheAttachChallenge(payload: CompanionAttachChallenge | null): void {
  if (_attachChallengeExpiryTimer !== null) {
    clearTimeout(_attachChallengeExpiryTimer);
    _attachChallengeExpiryTimer = null;
  }
  if (payload === null) {
    _latestAttachChallenge = null;
    _latestAttachChallengeExpiresAt = null;
    return;
  }
  _latestAttachChallenge = payload;
  _latestAttachChallengeExpiresAt = Date.now() + payload.ttlMs;
  _attachChallengeExpiryTimer = setTimeout(() => {
    _attachChallengeExpiryTimer = null;
    _latestAttachChallenge = null;
    _latestAttachChallengeExpiresAt = null;
  }, Math.max(0, payload.ttlMs));
}

/**
 * The value to hand a subscriber attaching AFTER a challenge was already
 * cached — `ttlMs` recomputed as time REMAINING until the cached deadline,
 * never the original payload's `ttlMs` (spec 2026-08-19 review finding 4).
 * Returns `null` once the deadline has passed even if the expiry timer
 * above hasn't fired yet — `setTimeout` firing order is never guaranteed to
 * the millisecond, so this inline check is the authoritative one; the timer
 * is only the belt ensuring the cache doesn't linger indefinitely once
 * nothing is left to ask it for a replay.
 */
function attachChallengeReplayValue(): CompanionAttachChallenge | null {
  if (_latestAttachChallenge === null || _latestAttachChallengeExpiresAt === null) {
    return null;
  }
  const remaining = _latestAttachChallengeExpiresAt - Date.now();
  if (remaining <= 0) return null;
  return { ..._latestAttachChallenge, ttlMs: remaining };
}

/**
 * Close the relay WS. The observable state retains its last value — hosts
 * can still read `useCompanion().state` afterwards to render a "paused"
 * indicator. Re-call `start(...)` to reconnect.
 */
export function stop(): void {
  setRunning(false);
  NativeEverframe.stopCompanion();
}

/**
 * Subscribe to the "is a session wanted" intent flag (see `_running` above).
 * Returns an unsubscribe function. Use this directly from imperative code;
 * React components should prefer `useCompanion().running`.
 */
export function onRunning(handler: (running: boolean) => void): () => void {
  _runningHandlers.add(handler);
  return () => {
    _runningHandlers.delete(handler);
  };
}

/**
 * Subscribe to companion-state changes. Returns an unsubscribe function.
 * Use this directly from imperative code (e.g. an Activity-lifecycle hook);
 * React components should prefer `useCompanion()`.
 */
export function onState(handler: (state: CompanionState) => void): () => void {
  const sub = getEmitter().addListener(STATE_EVENT, (s: string) =>
    handler(s as CompanionState),
  );
  return () => sub.remove();
}

/**
 * Subscribe to pairUrl changes. The URL is set on `pair.created` and retained
 * for the life of the relay socket — it's nulled only when the socket closes
 * (terminal/permanent close). It does NOT flip to null on bond or expiry; drive
 * QR teardown off `state` (e.g. hide once `state === 'paired'`) instead, since
 * `state` is the reliably-delivered signal across the native bridge.
 */
export function onPairUrl(
  handler: (url: string | null) => void,
): () => void {
  const sub = getEmitter().addListener(
    PAIR_URL_EVENT,
    (url: string | null) => handler(url),
  );
  return () => sub.remove();
}

/**
 * Subscribe to the announce display code — the short string the dashboard
 * shows next to this device in the project's Companion list, so a team member
 * can match what they read on the TV screen to a row in the list.
 *
 * `null` when companion discovery was never attempted (no SDK key configured
 * on the native side), when the announce call failed, and after the relay
 * socket closes terminally. A null code costs discovery only — pairing by QR
 * and report submission are unaffected, so never gate the QR on it.
 */
export function onCode(handler: (code: string | null) => void): () => void {
  const sub = getEmitter().addListener(CODE_EVENT, (code: string | null) =>
    handler(code),
  );
  return () => sub.remove();
}

/**
 * Subscribe to the attached dashboard member's display name. Populated only
 * when someone attached to this device FROM the dashboard; an ordinary QR
 * bond carries no such name and leaves this `null`. Render it as e.g.
 * "Paired with <name>" — but drive the paired/unpaired chrome itself off
 * `state`, which is the reliably-delivered signal.
 */
export function onAttachedUserName(
  handler: (name: string | null) => void,
): () => void {
  const sub = getEmitter().addListener(
    ATTACHED_USER_NAME_EVENT,
    (name: string | null) => handler(name),
  );
  return () => sub.remove();
}

/**
 * Subscribe to the server-resolved device display name (naming spec
 * 2026-08-24) — e.g. an org-configured friendly name for this device.
 * `null` before the first successful announce, and when discovery never ran
 * (no SDK key configured on the native side).
 *
 * REPLAY SEMANTIC (external review, finding N5): RN events don't replay to
 * listeners attached after they fired, so a name resolved by an announce
 * that ran before this call would otherwise be invisible to it until the
 * NEXT announce. If `start()` has already cached a resolved name, `handler`
 * is invoked synchronously, immediately, with that cached value — before
 * this function returns, in addition to firing on every later event. Mirrors
 * `onAttachChallenge`'s replay idiom exactly, minus the ttlMs
 * recomputation (a resolved name has no lifetime to recompute).
 */
export function onResolvedName(
  handler: (name: string | null) => void,
): () => void {
  const sub = getEmitter().addListener(
    RESOLVED_NAME_EVENT,
    (name: string | null) => handler(name),
  );
  if (_latestResolvedName !== null) handler(_latestResolvedName);
  return () => sub.remove();
}

/**
 * Subscribe to attach-PIN challenges (spec 2026-08-19). Fires with the live
 * challenge when a dashboard member requests attach, and null when it
 * clears (redeemed, expired, burned, superseded, socket closed). The
 * natives fire this event in every `attachPinUi` mode, including
 * `'builtin'` (which renders the PIN natively AND still fires the event) —
 * it's only NEEDED for `'custom'` hosts, which must read it to build their
 * own surface.
 *
 * REPLAY SEMANTIC: RN events don't replay to listeners attached after they
 * fired, so a challenge that arrived before this call would otherwise be
 * invisible to it. If `start()` has already cached a still-live challenge,
 * `handler` is invoked synchronously, immediately, with that cached value —
 * `ttlMs` recomputed as the time REMAINING until its deadline, never the
 * original duration (review finding 4) — before this function returns, in
 * addition to firing on every later event. A cached challenge whose deadline
 * has already passed replays nothing (`attachChallengeReplayValue()` returns
 * null), matching the semantics of a challenge that was never cached at all.
 */
export function onAttachChallenge(
  handler: (challenge: CompanionAttachChallenge | null) => void,
): () => void {
  const sub = getEmitter().addListener(
    ATTACH_CHALLENGE_EVENT,
    (payload: CompanionAttachChallenge | null) => handler(payload ?? null),
  );
  const replay = attachChallengeReplayValue();
  if (replay !== null) handler(replay);
  return () => sub.remove();
}

/**
 * React hook returning the latest `{ state, pairUrl, code, attachedUserName, attachChallenge }`
 * snapshot. Mounts one NativeEventEmitter subscription per value and tears
 * them all down on unmount.
 *
 * Subscribing is safe to tie to a component; the SESSION is not. Binding
 * `stop()` to unmount means the device stops advertising the moment the
 * screen goes away — including when the user navigates off to the dashboard
 * to attach to it — so prefer starting on mount and ending on an explicit
 * user action. `examples/react-native/src/screens/Companion.tsx` shows that
 * shape, with a module-scoped flag carrying the user's intent across mounts.
 *
 * Note that `stop()` retains the last `state` and `pairUrl` rather than
 * clearing them, so a stopped session must be rendered from your own flag —
 * rendering off `state` alone leaves a dead QR on screen.
 */
export function useCompanion(): {
  state: CompanionState;
  pairUrl: string | null;
  code: string | null;
  attachedUserName: string | null;
  resolvedName: string | null;
  attachChallenge: CompanionAttachChallenge | null;
  running: boolean;
} {
  const [state, setState] = useState<CompanionState>('unpaired');
  const [pairUrl, setPairUrl] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [attachedUserName, setAttachedUserName] = useState<string | null>(null);
  // Seeded from the module-scope cache (external review, finding N5) — a
  // resolvedName that arrived before this hook mounted is visible on the
  // FIRST render, not just after the effect below's `onResolvedName` replay
  // resolves. Mirrors `attachChallenge`'s identical seeding below.
  const [resolvedName, setResolvedName] = useState<string | null>(_latestResolvedName);
  // Seeded from the module-scope cache (not `null`) so a challenge that
  // arrived before this hook mounted is visible on the FIRST render, not
  // just after the effect below's `onAttachChallenge` replay resolves.
  // `attachChallengeReplayValue()` recomputes `ttlMs` as time remaining
  // until the cached deadline (review finding 4) — a mount 55s into a 60s
  // challenge must not seed `ttlMs: 60000`.
  const [attachChallenge, setAttachChallenge] =
    useState<CompanionAttachChallenge | null>(attachChallengeReplayValue());
  // Seeded from the module-scope flag (not `false`) so a remount sees the
  // LIVE intent on its first render — mirrors `resolvedName`'s seeding
  // above. Seeding from `false` would make a host's toggle flicker off on
  // every remount even though a session is still wanted.
  const [running, setRunning] = useState<boolean>(_running);

  useEffect(() => {
    const offState = onState(setState);
    const offPairUrl = onPairUrl(setPairUrl);
    const offCode = onCode(setCode);
    const offAttachedUserName = onAttachedUserName(setAttachedUserName);
    const offResolvedName = onResolvedName(setResolvedName);
    const offAttachChallenge = onAttachChallenge(setAttachChallenge);
    const offRunning = onRunning(setRunning);
    return () => {
      offState();
      offPairUrl();
      offCode();
      offAttachedUserName();
      offResolvedName();
      offAttachChallenge();
      offRunning();
    };
  }, []);

  return {
    state,
    pairUrl,
    code,
    attachedUserName,
    resolvedName,
    attachChallenge,
    running,
  };
}
