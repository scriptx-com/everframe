// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Module-level companion host seam. The phone-companion submit path needs the
// active SDK config (apiKey for ingest) + the platform adapter (capture
// primitives + outbox) at `report.submit` time — but the companion runs from
// imperative, non-React call sites (`companion.start()`), so it can't read
// React context. `EverframeProvider` writes this seam on mount / clears it on
// unmount; the companion's default `report.request` / `report.submit` handlers
// read it.
//
// This mirrors `contextSeam.ts` (which exposes only `open()`); here we expose
// the config + adapter the TV-side ingest submit needs. When the seam is empty
// (no Provider mounted, or a host wired the companion manually without one),
// the submit handler degrades to `report.failed("submit_unavailable")` — never
// a silent hang (parity with native CompanionCaptureBridge).
'use client';

import type { UserMetadata } from '@everframe/sdk-core';
import type { WebPlatformAdapter } from '../adapter.js';
import type { WebEverframeConfig } from '../internal/types.js';
import type { HostSdkName } from '../internal/sdk-identity.js';

export interface CompanionHost {
  config: WebEverframeConfig;
  adapter: WebPlatformAdapter;
  /**
   * Which SDK is hosting — passed to submitReportFromDraft as envelope
   * `sdk.name`. Optional for back-compat with hand-wired hosts; absent means
   * the React default, which is what every host was before `@everframe/web`
   * shipped its own `init()`.
   */
  sdkName?: HostSdkName;
  /** The HOST package's PKG_VERSION — envelope `sdk.version`. */
  sdkVersion: string;
  /**
   * Reads the host's active `setUser` value at submit time (spec 2026-08-12).
   *
   * A GETTER, not a snapshot: the seam is written once per Provider context
   * value, but the user changes whenever the host signs in or out. Storing the
   * value here would pin whoever was active at mount and misattribute every
   * later companion report.
   */
  getUser: () => UserMetadata | null;
  /**
   * Reads the host's active `setExtra` value at submit time — the companion
   * counterpart of provider.tsx threading `payload.extra` into in-app reports.
   * Same getter-not-snapshot doctrine as `getUser`. Optional for back-compat
   * with hand-wired hosts; empty/absent means the draft carries no extra.
   */
  getExtra?: () => string;
  /**
   * Has the host pulled the consent / GDPR kill switch on the client backing
   * this seam? (Codex round-2 finding 1, the companion half.)
   *
   * The companion is the reporter's other submit route — a paired phone drives
   * `report.request` → `report.submit` and the TV ships a screenshot of the
   * user's screen. `client.kill()` reaches the ADAPTER (`onKill`), but this
   * seam holds a live adapter and a live config until `destroy()` clears it,
   * so a `kill()` WITHOUT a `destroy()` — which is exactly what consent
   * withdrawal looks like: the host wants the UI to stay mounted and inert —
   * left this route capturing and submitting.
   *
   * A GETTER, not a boolean, for the same reason as `getUser`: the seam is
   * written once, and the kill can land at any point afterwards.
   *
   * OPTIONAL, and absent means "not killed". `@everframe/react`'s Provider does
   * not set it, so its companion behaviour is byte-for-byte unchanged by this
   * seam; that SDK's own kill gap is tracked separately and needs a change to
   * provider.tsx, which is out of bounds here.
   */
  isKilled?: () => boolean;
}

/**
 * The published host, and the seam's IDENTITY counter.
 *
 * Codex round-5 findings 1 + 3 (P1/P2) — rounds 3 and 4 answered "has capture
 * been shut down?" with a page-global boolean (`__hostTornDown`), set by a real
 * teardown and cleared by the next publication. Two things fall out of a flag
 * that anyone can flip:
 *
 *  - it answers the WRONG QUESTION after an await. Tenant A starts a slow
 *    screenshot or submit, the app calls `destroy()` and immediately inits
 *    tenant B; B's publication clears the flag, and A's operation — which
 *    belongs to a host that no longer exists — resumes, ships A's pixels to
 *    the phone and A's report to ingest. The post-await check has to ask "is
 *    the host that BEGAN me still the current one?", not "has anyone published
 *    since?".
 *  - and it is page-lifetime STICKY for everyone else. `companion.stop()` →
 *    `companion.start()` is the supported standalone entry point, and a flag
 *    only a host publication can clear left that session refusing every
 *    `report.request` until reload.
 *
 * So the seam carries identity instead: `__epoch` ticks on every transition
 * (a publication or a REAL clear), and `__teardownEpoch` remembers the tick of
 * the most recent teardown. A caller captures a `CompanionSeamTicket` when its
 * operation (or its companion session) begins and hands it back afterwards;
 * `__isCompanionKilled(ticket)` then answers against THAT starting point
 * rather than against whatever the page looks like now. See `seamTicketDead`
 * for the three questions and why each is the one that path must ask.
 */
let __host: CompanionHost | null = null;
/** Ticks on every seam TRANSITION — a publication, or a clear that had something to clear. */
let __epoch = 0;
/** `__epoch` at the most recent REAL teardown; 0 = no host was ever torn down here. */
let __teardownEpoch = 0;

/**
 * Identity of the seam at the moment an operation — or a companion session —
 * began. Opaque: hold it and hand it back, never interpret the fields.
 */
export interface CompanionSeamTicket {
  /** The host the operation began under, or null for the standalone posture. */
  readonly host: CompanionHost | null;
  /** Was `host` the seam's PUBLISHED host then? False for a hand-wired host. */
  readonly published: boolean;
  /** `__epoch` when the ticket was taken. */
  readonly epoch: number;
}

/**
 * SDK-internal — capture the seam's identity at the start of an operation.
 *
 * Pass the host an operation was dispatched with (the bridge handlers receive
 * one); pass `null` for a session that has no host of its own — the companion
 * singleton takes one of these at `start()` so a session's standalone fallback
 * is judged against the seam as it stood when that session opened.
 */
export function __companionSeamTicket(
  host: CompanionHost | null = __host,
): CompanionSeamTicket {
  return { host, published: host !== null && host === __host, epoch: __epoch };
}

/** SDK-internal — `EverframeProvider` / `init()` are the writers (mount sets, unmount clears). */
export function __setCompanionHost(host: CompanionHost | null): void {
  if (host === null) {
    // Latch only a REAL teardown. A defensive `__setCompanionHost(null)` from
    // a host that never published (or a second clear after one) is not a
    // transition: it must not retire the never-started standalone path, and it
    // must not invalidate tickets taken since the last real one.
    if (__host === null) return;
    __epoch += 1;
    __teardownEpoch = __epoch;
  } else {
    __epoch += 1;
  }
  __host = host;
}

/**
 * Test seam — back to "no host was ever published on this page".
 *
 * `__setCompanionHost(null)` deliberately CANNOT do this (that is the whole
 * point of the teardown epoch), so a spec that needs the never-started
 * standalone posture after an earlier case tore a host down has no other way
 * back. Not exported from the package barrel: nothing shipped may reopen the
 * gate.
 */
export function __resetCompanionHostForTests(): void {
  __host = null;
  __epoch = 0;
  __teardownEpoch = 0;
}

/**
 * Does this host itself report killed?
 *
 * Codex round-3 finding 4 (P1) — `isKilled` is host-supplied, so it is called
 * defensively: a getter that THROWS fails CLOSED (a consent gate that can be
 * disabled by throwing is not a gate).
 */
function hostSaysKilled(host: CompanionHost): boolean {
  try {
    return host.isKilled?.() === true;
  } catch {
    return true;
  }
}

/**
 * Is the companion route shut down, judged from where the caller STARTED?
 *
 * Three questions, one per posture, and each is the only correct one for its
 * path:
 *
 *  1. Began under a host that WAS the published one — round 5 finding 1. Dead
 *     as soon as the seam no longer holds that exact host: `destroy()` cleared
 *     it, or another tenant published over it. Identity, not a flag; a
 *     successor's publication cannot vouch for its predecessor's in-flight
 *     work.
 *  2. Began under a host that was NOT published (a hand-wired
 *     `createRelayWSClient` that passes its own `CompanionHost` straight to
 *     these handlers, never touching this module). Nothing here owns its
 *     lifetime, so only its own `isKilled` governs it — as it always has.
 *  3. Began with NO host. If one has published since, that host now governs
 *     the page and answers for it. Otherwise the round-4 question, but scoped:
 *     has a teardown landed SINCE this ticket was taken? A session that
 *     outlived its host's `destroy()` is refused; a `companion.start()` issued
 *     AFTER that teardown is a deliberate new standalone session and is not
 *     (round 5 finding 3), and a page that never published anything still gets
 *     the never-started fallback `handleReportRequest` exists for.
 */
function seamTicketDead(t: CompanionSeamTicket): boolean {
  if (t.host !== null) {
    if (t.published && __host !== t.host) return true;
    return hostSaysKilled(t.host);
  }
  if (__host !== null) return hostSaysKilled(__host);
  return __teardownEpoch > t.epoch;
}

/**
 * SDK-internal — is the companion route shut down by the consent switch or by
 * teardown?
 *
 * Read by the companion paths that cannot inherit the seam gate below, because
 * they are defined by the ABSENCE (or the staleness) of the seam: the
 * standalone `handleReportRequest`, and every post-await re-check in
 * capture-bridge, where the seam may have moved on since the operation began.
 *
 * WITH a ticket it answers for the operation that took it — see
 * `seamTicketDead`. WITHOUT one it answers for the page as it stands now, from
 * the beginning of time: a live host's own verdict, or, with no host, whether
 * ANY teardown has ever happened here. That is the pre-round-5 answer, and it
 * is the right default for a caller that holds no ticket — a hand-wired host
 * calling the exported `handleReportRequest` directly — because the only safe
 * assumption about an unknown starting point is the earliest one.
 */
export function __isCompanionKilled(ticket?: CompanionSeamTicket): boolean {
  return seamTicketDead(
    ticket ?? { host: __host, published: __host !== null, epoch: 0 },
  );
}

/**
 * SDK-internal — read by the companion capture/submit paths to reach config +
 * adapter.
 *
 * Codex round-3 finding 4 (P1) — THE companion kill choke point. `kill()`
 * reaches the adapter (`onKill`) but leaves this seam pointing at a live
 * adapter and a live config until `destroy()` clears it, and consent
 * withdrawal is exactly the case where a host calls `kill()` and nothing else.
 * Round 2 answered that with an `isKilled()` check inside two of the bridge's
 * handlers; round 3 found the third (`shot.request`) had none at all and
 * started a fresh full-screen capture.
 *
 * Gating the SEAM instead of the handlers is what stops that sequence
 * repeating: a killed host is indistinguishable from no host at all — both
 * mean "this device cannot capture or submit" — and every consumer of this
 * function ALREADY fails closed on null with a wire answer the phone knows
 * how to render (`report.failed` / `shot.failed` / `preview.stop`, all with
 * `capture_unavailable` / `submit_unavailable`). So a new companion route
 * inherits the gate by reading the seam, which it must do anyway to reach the
 * adapter.
 *
 * `report.cancelled` is the one consumer that gets LESS work done with a null
 * host: it still tears down the preview loop, the shot stash and the submit
 * framing (all module state), and only skips un-freezing the killed client's
 * replay/breadcrumb buffers — which is the correct outcome, not a gap.
 */
export function __getCompanionHost(): CompanionHost | null {
  return __host !== null && hostSaysKilled(__host) ? null : __host;
}
