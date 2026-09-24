// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Session Vitals wiring (web) — the only module that constructs a
// VitalsCollector. Everything it composes (the server-config box, the
// resource sampler, the player adapter, the transport) is a pure factory
// from Tasks 4-7 with no opinion on WHEN or WHETHER it should run; this file
// owns that decision plus the start/stop lifecycle and the
// `__getActiveVitals()` box report enrichment reads.
//
// Start gate, evaluated every time the server-config box changes while not
// yet started (`maybeStart()` below):
//   server vitalsEnabled === true
//   AND local config.vitals?.enabled !== false
//   AND a ONE-TIME sampling draw: Math.random() < min(localRate ?? 1, serverRate)
// The draw happens at most once per setupVitals() call (i.e. once per init()
// session) and its outcome is cached — a later config refresh (even one that
// RAISES the sample rate) must never re-roll it, so a losing draw stays lost
// for the life of this session (spec 2026-09-01 controller ruling).
//
// destroy() ALWAYS finalizes: the collector's own stop() sends the final
// summary and is internally idempotent (packages/sdk-core/src/vitals/
// collector.ts guards on its own `stopped` flag), so a server-config-flip
// stop followed by init.ts's teardown calling destroy() must not double-send
// it. This file adds its OWN `destroyed` guard on top so a host calling
// destroy() twice — or a flip-stop followed by destroy() — never re-enters
// the stop sequence at all.
import type { VitalsEntry } from '@everframe/protocol';
import { MAX_CUSTOM_NAME_LENGTH, utf8ByteLength } from '@everframe/protocol';
import {
  createVitalsCollector,
  type VitalsCollector,
  boundJson,
  type PlayerIntegration,
  safeWrap,
  presentableIdentityToken,
} from '@everframe/sdk-core';
import { startResourceSampler } from './resource-sampler.js';
import { attachPlayerVitals, type PlayerVitalsAdapter } from './player-adapter.js';
import { createVitalsTransport } from './transport.js';
import { __getVitalsServerConfig, __subscribeVitalsServerConfig } from './server-config.js';
import { createPlayerRegistry } from './registry.js';
import { hlsIntegration } from './integrations/hls.js';
import { shakaIntegration } from './integrations/shaka.js';
import type { WebEverframeConfig } from '../internal/types.js';

export interface SetupVitalsDeps {
  config: WebEverframeConfig;
  apiKey: string;
  /** Ingest base URL — `${apiUrl}/api/ingest/vitals` is the transport endpoint. */
  apiUrl: string;
  /** Re-checked at every send boundary by the transport — the same permanent
   *  `state.killed` predicate init.ts reads via `__internalClientState` for
   *  every other kill-gate in that file (NOT something transport/submit.ts
   *  consults directly). */
  isKilled(): boolean;
  sdkVersion: string;
  /**
   * Task 11 (spec 2026-09-10 — playback session identity). "Who is signed in
   * right now", called ONCE PER SUMMARY by the collector — which takes what it
   * returns as a single snapshot and hands both halves onward: the `user` onto
   * the summary body, the `token` to the transport with that same payload
   * (round-4 finding 5). Nothing else reads this. Both call sites (`init.ts`,
   * sdk-react's `provider.tsx`) build it from the adapter's two SYNCHRONOUS
   * identity seams — `__peekIdentityToken()` and
   * `__captureUserAtSubmitBoundary()`.
   *
   * Optional: a host wiring `setupVitals()` directly, and every unit test,
   * omits it and every session stays anonymous — the pre-Task-11 behaviour.
   *
   * What it returns is not used raw: `gateIdentity` below screens and
   * normalizes the `token`, and withholds the whole block when that token is
   * unpresentable.
   */
  identity?: () => {
    token?: string;
    /**
     * "The verified tier is configured but has no usable token right now."
     * Forwarded verbatim to the collector, which withholds the self-declared
     * `user` block while it is true so a cold (or aged-out) token cache cannot
     * mint an unverified twin of the person a later summary verifies (round-2
     * finding 3). See the collector's `claimedUser` and
     * `IdentityTokenHolder.hasUnresolvedSource`.
     */
    tokenPending?: boolean;
    user?: { id?: string; email?: string; displayName?: string };
  } | null;
  /**
   * Fire-and-forget refresh of the identity-token cache `identity()` reads,
   * forwarded straight to the collector — which calls it on the flush cadence
   * and once at startup, never on the unload path.
   *
   * Without it the verified tier never activates for a viewer who only
   * watches: `__peekIdentityToken()` is cache-only, and on web nothing
   * populates that cache until something calls the ASYNC
   * `__identityTokenReader.get()` — which, before this, only the report path
   * ever did. See the collector's `warmIdentity` doc-comment (adversarial
   * review of PR #218, finding 1).
   *
   * Optional for the same reason `identity` is: a host wiring `setupVitals()`
   * directly, and every unit test, omits it.
   */
  warmIdentity?: () => void;
}

/** The identity read both the collector and the transport consult, per summary. */
type VitalsIdentityRead = NonNullable<SetupVitalsDeps['identity']>;

/**
 * THE CLIENT-SIDE TOKEN GATE, applied where the identity provider is READ —
 * once, for both consumers of it (adversarial review of PR #218 round 3,
 * findings 1 and 3).
 *
 * Round 2 put a length bound in the transport instead, and that was the wrong
 * layer twice over. It ran AFTER the summary body had been built, so dropping
 * an unusable token left `summary.user` in place and the server saw a
 * self-declared claim with no credential beside it — a configured JWT over
 * 4,096 chars plus `setUser({id:'alice'})` minted an UNVERIFIED person, which
 * is exactly the downgrade invariant 1 forbids: a credential that was
 * presented and failed resolves ANONYMOUS, never to the weaker tier. And it
 * screened only length, so a three-segment token with a valid `exp` and an
 * embedded newline still reached `fetch`, which refused the header before
 * sending anything — identity garbage costing the whole summary, which is
 * invariant 2.
 *
 * Gating here fixes both, because here the `user` block has not been assembled
 * yet: an unusable token takes the self-declared claim down with it, and
 * neither the fetch header nor the beacon body ever sees the value. Both
 * halves of the outcome are the spec's: anonymous, and delivered.
 *
 * Everything else passes through untouched — this is the only place that may
 * decide a token is unpresentable, and `presentableIdentityToken` is the only
 * question it asks. That function also NORMALIZES (round-4 finding 2): the
 * token stamped back onto the snapshot below is its trimmed return value, so
 * surrounding whitespace from the host costs nothing and every consumer of the
 * snapshot carries the identical string.
 */
function gateIdentity(read: VitalsIdentityRead): VitalsIdentityRead {
  return () => {
    const identity = read();
    if (!identity) return identity;
    const token = identity.token;
    if (token === undefined) return identity;
    const presentable = presentableIdentityToken(token);
    // Presented-but-failed, expressed locally: no token, and no `user` block
    // either. `tokenPending` goes with them — nothing is coming, the claim is
    // simply withheld for this summary and every later one that offers the
    // same unusable token.
    if (presentable === null) return {};
    return { ...identity, token: presentable };
  };
}

export interface VitalsHandle {
  /** Always finalizes (collector.stop() sends the final summary). Idempotent. */
  destroy(): void;
}

/** What `__getActiveVitals()` hands back while a vitals session is running. */
export interface ActiveVitalsBox {
  sessionId: string;
  recent(): VitalsEntry[];
}

let _active: ActiveVitalsBox | undefined;

/** Present only while a vitals session is actually running; undefined otherwise. */
export function __getActiveVitals(): ActiveVitalsBox | undefined {
  return _active;
}

// Phase 4 (spec 2026-09-02 §2): module-scoped so `init()` and the React
// Provider — which each call setupVitals() themselves — share one registry
// and one public API. One vitals instance per page is already the rule.
// Two LIVE `setupVitals()` instances existing at once (a host re-calling
// `init()` without `destroy()`-ing the first) already made the second's
// `_adapter`/`_collector` win last-writer-wins over this module scope before
// this task — pre-existing, and safe in practice because `init()`'s own
// re-entry guard makes that double-live state vanishingly rare. What THIS
// task changes is that the consequence is now reachable through a PUBLIC
// API: `trackPlayer`/`trackVitals` read whichever adapter/collector last
// wrote here, so a customer's calls after a stray double-`init()` would
// silently address the second instance, not necessarily the one they meant.
//
// `let`, not `const`: production `registry.clear()` (called from a live
// VitalsHandle's `destroy()`) deliberately preserves the id counter — an
// element's identity must survive a detach/re-register within the same page
// lifetime, and `registry.spec.ts` locks that in as the registry's own
// contract. A test seam has the opposite need: each spec wants a CLEAN slate,
// ids included, so `__resetVitalsForTests()` below rebinds this variable to a
// brand-new registry rather than clearing the old one. Every reader
// (`trackPlayer`, `maybeStart`) reads `registry` at call time, so the
// rebinding is picked up immediately with no other change required.
let registry = createPlayerRegistry();
let _adapter: PlayerVitalsAdapter | undefined;
let _collector: VitalsCollector | undefined;

/**
 * Codex round-2 item 4 (identity half) — which `trackPlayer()` CALL currently
 * owns a given element's registration. Every successful `trackPlayer()`
 * mints a brand-new token and stamps it here; a handle's `detach()` checks
 * its OWN captured token against this map before acting, so a stale handle
 * from a SUPERSEDED registration (`p.detach(); q = trackPlayer({element});
 * p.detach()`) can never tear down the registration a LATER call created —
 * only the call that currently owns the slot can act on it. Module-scoped
 * (not per-handle-only) for the same reason `registry` is: it must outlive
 * any one `setupVitals()` instance and be visible to every `trackPlayer()`
 * call regardless of which instance is currently live.
 */
let activeTokens = new WeakMap<HTMLMediaElement, symbol>();

/**
 * Codex round-2 item 4 (durability half) — elements explicitly `detach()`ed
 * while NO adapter exists yet (the collector hasn't started: server config
 * is still resolving, or it's between a kill-triggered stop and a later
 * restart). `registry.unregister()` alone removes the EXPLICIT registration,
 * which keeps the later `attachPlayerVitals({ registered })` seed list
 * correct — but the element is still a `<video>`/`<audio>` sitting in the
 * DOM, and the adapter's own initial scan (`scanForBind`) binds every such
 * element it finds regardless of the registry, silently rebinding it the
 * moment a collector eventually starts. This set is handed to
 * `attachPlayerVitals` as its OWN `userDetached` seed (shared by reference,
 * not copied) so a pre-start detach is honoured the same way a post-start
 * one already is. `trackPlayer()` deletes an element from this set on every
 * successful (re-)registration — re-arming is customer intent that always
 * outranks a prior detach, same rule `player-adapter.ts`'s own
 * `userDetached.delete` already applies post-start.
 */
let userDetachedElements = new WeakSet<HTMLMediaElement>();

export interface PlayerHandle {
  readonly id: string;
  track(name: string, data?: unknown): void;
  detach(): void;
}
export interface TrackPlayerOptions {
  element: HTMLMediaElement;
  hls?: unknown;
  shaka?: unknown;
  integration?: PlayerIntegration;
  name?: string;
}

/**
 * Codex round-5 item 2 (honest-contract half) — the registry used to accept
 * ANY object as `element` (a `WeakMap` key needs nothing more than "is an
 * object"), so `trackPlayer({ element: {} })` minted a real id and stored a
 * live registration. That registration only failed LATER, at collector
 * start, when `player-adapter.ts`'s `bind()` reached `el.addEventListener`
 * on the fake element — by which point the throw was deep inside
 * `attachPlayerVitals`'s startup loop, aborting the ENTIRE collector rather
 * than just this one bad registration (see that file's own bind-loop fix
 * for the safety-net half of this same item). Rejecting up front, before
 * anything is registered, is what the public API already promises: a bad
 * element must yield an inert, harmless handle and otherwise change
 * nothing, not silently poison a collector that hasn't started yet.
 *
 * Codex round-6 item 4 — round 5's fix used `instanceof HTMLMediaElement`,
 * which checks REALM IDENTITY, not shape: `instanceof` walks the
 * prototype chain looking for the exact `HTMLMediaElement.prototype` object
 * from THIS window's globals, so a `<video>` obtained from a same-origin
 * IFRAME — a genuinely valid, fully functional media element, and ordinary
 * in this product's market (embedded players, ad slots, widget iframes) —
 * has its OWN frame's `HTMLMediaElement.prototype` on its chain, not this
 * document's, and fails the check. That silently downgraded a real
 * integration to the inert handle, losing its telemetry with no error
 * anywhere; the automatic scanner can't compensate because it never
 * traverses iframe documents.
 *
 * Fixed by checking STRUCTURE instead of identity: every member below is
 * one `player-adapter.ts`'s `bind()`/`elementSource()` actually reads or
 * calls on a tracked element (`addEventListener`/`removeEventListener` to
 * (un)bind every event handler, `paused`/`currentTime`/`readyState` read
 * directly, `querySelectorAll` to resolve a `<source type>` for the mime
 * field, `tagName` identifying it as an element at all). Any real media
 * element — this document's or a same-origin iframe's — has every one of
 * these; the malformed objects round 5 was protecting against (`{}`, a
 * plain `<div>`, which has `addEventListener`/`tagName` but neither
 * `paused` nor `currentTime`) still fail. `typeof el !== 'object'` guards
 * `null`/primitives, which `in`/property access on `unknown` can't
 * otherwise narrow safely.
 *
 * Codex round-7 item 4 — round 6's `typeof e.tagName === 'string'` checked
 * only that a tag name EXISTS, not that it names an actual media tag: a
 * media-like custom element implementing every property above (a duck-typed
 * `paused`/`currentTime`/`readyState`, which a real `<div>` normally lacks,
 * but a hand-rolled player-shim object — or an erroneous ref pointed at one —
 * can trivially provide) or a structurally-similar `DIV` still passed and
 * received a real handle. `player-adapter.ts`'s `emitAttach` then reads
 * `tagName` right back off the SAME element to label the attach event
 * (`=== 'VIDEO' ? 'video' : 'audio'`), so anything that isn't literally a
 * `<video>` was silently mislabeled `'audio'`, corrupting the player count
 * and timeline. Fixed by checking the tag name's VALUE, not merely its
 * type — but round 7's own fix compared the literal string `tagName ===
 * 'VIDEO'`, which both under- and over-rejects:
 *
 *   - Under-rejects: a PLAIN OBJECT carrying every method/property above plus
 *     a literal `tagName: 'VIDEO'` string still passes every check here and
 *     receives a live handle, exactly the round-6/round-7 duck-typing gap
 *     this function exists to close — an exact string match on `tagName`
 *     alone was never a DOM check, it's a property-value check any object
 *     can set.
 *   - Over-rejects: a genuine `HTMLVideoElement` parsed from an XHTML
 *     document has a LOWERCASE `tagName` of `'video'` (XHTML is XML — tag
 *     name casing on `Element.tagName` follows the document's source case,
 *     unlike HTML-namespace elements which are always upper-cased), so the
 *     exact-match comparison silently refused it and dropped that player's
 *     telemetry with no error anywhere.
 *
 * Fixed with a three-part bar, matching the brief:
 *   1. `e.nodeType === 1` (`Node.ELEMENT_NODE`) — requires a REAL DOM element
 *      node. `nodeType` is a plain number on every element in every realm
 *      (this document's, a same-origin iframe's, or an XHTML document's), so
 *      this keeps the round-6 cross-realm fix intact without resorting to an
 *      `instanceof` check against this realm's own `Node`/`Element`
 *      globals — the exact identity check round 6 already moved away from.
 *      A plain object normally has no `nodeType` at all, so this alone
 *      rejects the under-rejection case above UNLESS the object goes out of
 *      its way to also set `nodeType: 1` — at which point it is deliberately
 *      impersonating a DOM node and its telemetry is its own problem (brief).
 *   2. `/^(video|audio)$/i.test(e.tagName)` — matches the tag name
 *      CASE-INSENSITIVELY, so the same test that rejects a `DIV` (over-
 *      rejection guard, unchanged from round 7) now also accepts an XHTML
 *      element's lowercase `'video'`/`'audio'` (fixes the over-rejection
 *      case above) as readily as an HTML-namespace element's upper-cased
 *      `'VIDEO'`/`'AUDIO'` (this document's or a same-origin iframe's).
 *   3. The method/property checks from round 6 (`addEventListener`,
 *      `removeEventListener`, `querySelectorAll`, `paused`, `currentTime`,
 *      `readyState`) — unchanged; these are what `player-adapter.ts`'s
 *      `bind()`/`elementSource()` actually reads or calls, and still what
 *      rejects a bare `{}` or an element-like shim missing any one of them.
 *
 * Together: a cross-realm `<video>` (real element, `nodeType===1`, upper-
 * cased tag, every method) passes; an XHTML `<video>` (real element,
 * `nodeType===1`, lowercase tag, every method) now also passes; a plain
 * object with `tagName: 'VIDEO'` (no `nodeType`) is rejected; an ordinary
 * `<div>` (real element, `nodeType===1`, but tag name matches neither
 * pattern) is rejected.
 */
function isMediaElement(el: unknown): el is HTMLMediaElement {
  if (typeof el !== 'object' || el === null) return false;
  const e = el as Record<string, unknown>;
  return (
    e.nodeType === 1 && // Node.ELEMENT_NODE — a real DOM element node, any realm
    typeof e.tagName === 'string' &&
    /^(video|audio)$/i.test(e.tagName) &&
    typeof e.addEventListener === 'function' &&
    typeof e.removeEventListener === 'function' &&
    typeof e.querySelectorAll === 'function' &&
    typeof e.paused === 'boolean' &&
    typeof e.currentTime === 'number' &&
    typeof e.readyState === 'number'
  );
}

function resolveIntegration(opts: TrackPlayerOptions): PlayerIntegration | undefined {
  if (opts.integration) return opts.integration;
  if (opts.hls) return hlsIntegration(opts.hls);
  if (opts.shaka) return shakaIntegration(opts.shaka);
  return undefined;
}

/**
 * Inert handle returned when trackPlayer itself fails. `safeWrap` returns
 * `undefined` on a throw, so wrapping this function and casting the result to
 * `PlayerHandle` would lie to the host: a caller doing
 * `everframe.trackPlayer(...).detach()` would get a TypeError from OUR bug —
 * exactly what the safe-wrap discipline exists to prevent. Explicit try/catch
 * keeps the signature honest.
 *
 * `id: ''`, not a fake `p`-prefixed id: a customer holding this handle who
 * calls `trackVitals(name, data, { player: h })` must not stamp a `playerId`
 * naming a player that was never bound — the admin groups the session
 * timeline BY player id, so a fabricated one would show up as a phantom
 * player in that UI. `trackVitals` below gates the stamp on `id` truthiness,
 * so the empty string here is what suppresses it.
 */
const INERT_PLAYER: PlayerHandle = { id: '', track: () => {}, detach: () => {} };

export function trackPlayer(opts: TrackPlayerOptions): PlayerHandle {
  // Codex round-2 item 2 — `opts.element` is read EXACTLY ONCE, here, into a
  // local `element` used for everything after, including the catch block's
  // own cleanup. This is the third attempt at this contract (see the two
  // review-round comments still below on the `opts`-nullish/falsy-element
  // cases this same catch also has to handle): the previous shape re-read
  // `opts.element` a second time inside the catch, so a throwing accessor or
  // Proxy `element` threw on the FIRST read (entering this catch), then
  // threw AGAIN on the cleanup's re-read — escaping the catch and throwing
  // into the host page, exactly the outcome this whole try/catch exists to
  // prevent. Declared outside the try so the catch can still see whatever
  // was successfully captured before any later failure.
  let element: HTMLMediaElement | undefined;
  // Codex round-3 item 9 — set to `true` the instant `registry.register()`
  // below actually runs. The catch's cleanup must only undo what THIS call
  // did: if a throwing `name`/`integration`/`hls`/`shaka` getter on `opts`
  // fails before `register()` is ever reached, this call never touched the
  // registry at all — unregistering `element` in that case doesn't "clean
  // up a partial call", it deletes an EARLIER call's still-good
  // registration (see the catch block's own comment for the full scenario).
  let didRegister = false;
  try {
    element = opts.element;
    // Codex round-5 item 2 (honest-contract half) — reject a non-element
    // BEFORE anything is registered; see `isMediaElement`'s own doc-comment
    // for why this can't wait until collector start to fail. `didRegister`
    // is still `false` here, so this is a plain early return, not a throw
    // into the catch below — nothing has happened yet for that catch's
    // cleanup to undo.
    if (!isMediaElement(element)) return INERT_PLAYER;
    const integration = resolveIntegration(opts);
    // Codex round-2 item 11 — coerce + cap at the documented 64-char limit
    // (spec 2026-09-02 §2: "name?: string; // customer label, ≤ 64 chars",
    // shared with `trackVitals`'s own custom-entry name cap). An uncapped,
    // CMS-derived title would otherwise inflate `player_attach` and, via the
    // recent ring, every enriched bug report until it expires.
    const cleanName =
      opts.name !== undefined ? String(opts.name).trim().slice(0, MAX_CUSTOM_NAME_LENGTH) : undefined;
    const extras = {
      ...(cleanName !== undefined ? { name: cleanName } : {}),
      ...(integration ? { integration } : {}),
    };
    const id = registry.register({ element, ...extras });
    didRegister = true;
    // Codex round-2 item 4 (identity half) — mint a fresh token for THIS
    // call and stamp it as the element's current owner; see `activeTokens`'s
    // own doc-comment. Codex round-2 item 4 (durability half) — an explicit
    // (re-)registration is customer intent that outranks any PRIOR detach,
    // pre-start or not; see `userDetachedElements`'s own doc-comment for why
    // this must happen here rather than relying solely on the adapter's own
    // post-start `userDetached.delete`.
    const token = Symbol('vitals.player');
    activeTokens.set(element, token);
    userDetachedElements.delete(element);
    _adapter?.trackPlayer(element, extras);
    const handle: PlayerHandle = {
      id,
      track: (name, data) => trackVitals(name, data, { player: handle }),
      detach: () => {
        // Locally guarded, not inherited from the adapter: `untrackPlayer`
        // -> `unbind` is not itself wrapped in `safeWrap`, and today only
        // holds its own no-throw property because two functions inside it
        // happen to carry their own try/catch. A host doing
        // `trackPlayer(...).detach()` must never get a TypeError from us
        // (see INERT_PLAYER's doc-comment) — that guarantee belongs to
        // THIS function, not to an implementation detail two files away.
        try {
          // Codex round-2 item 4 (identity half) — a STALE handle (one
          // whose registration a later `trackPlayer()` call for the same
          // element has since superseded) must act on NOTHING: without this
          // check, `p.detach(); q = trackPlayer({element}); p.detach()`
          // tears down `q`'s live registration, not `p`'s (already-gone)
          // one. Only the call that currently owns this element's slot may
          // proceed — silently no-op otherwise, which also makes calling
          // the SAME handle's `detach()` twice a no-op the second time
          // (the token is cleared below on the first successful call).
          if (activeTokens.get(element as HTMLMediaElement) !== token) return;
          activeTokens.delete(element as HTMLMediaElement);
          // Codex round-2 item 4 (durability half) — mark this element
          // detached BEFORE unregistering, so it's true immediately, not
          // just after the (possibly-absent) adapter reacts.
          userDetachedElements.add(element as HTMLMediaElement);
          registry.unregister(element as HTMLMediaElement);
          _adapter?.untrackPlayer(element as HTMLMediaElement);
        } catch {
          /* never throw from detach() — see comment above */
        }
      },
    };
    return handle;
  } catch {
    // The failure could have landed AFTER `registry.register` already
    // succeeded (e.g. a broken `_adapter.trackPlayer`/integration `attach()`
    // throwing) — leaving that registration in place would mean a customer
    // holding an inert, un-detachable handle can never remove it, and the
    // NEXT collector start would silently bind a player they believe never
    // registered. Unregister before returning the inert handle so THAT
    // failure path leaves no state behind.
    //
    // Codex round-3 item 9 — gated on `didRegister`: a throwing
    // `name`/`integration`/`hls`/`shaka` getter on `opts` fails BEFORE
    // `registry.register()` ever runs, so this call touched the registry
    // not at all. Unregistering `element` unconditionally in that case
    // doesn't undo anything THIS call did — it deletes whatever an EARLIER,
    // successful `trackPlayer()` call had already registered for the same
    // element, so a collector restart (which rebuilds every player from
    // `registry.registered()`) would silently bring that player back
    // anonymous even though the customer's registration was never at fault.
    //
    // `opts` itself can be the thing that's malformed — an untyped JS host
    // (this barrel ships to plain `<script>` consumers with no compiler to
    // stop them) calling `trackPlayer()`/`trackPlayer(undefined)` throws
    // reading `opts.element` above and lands HERE with `element` still
    // `undefined`. Guard on `element` itself (captured above, NOT re-read
    // from `opts` — see this function's opening comment) so a throwing
    // accessor's failure here can only ever be OUR OWN registry/adapter
    // code, never `opts` again. `Map.delete(undefined)` is a safe no-op
    // regardless, so this guard only needs to be permissive, not exact.
    if (element && didRegister) registry.unregister(element);
    return INERT_PLAYER;
  }
}

export const trackVitals = safeWrap((name: string, data?: unknown, opts?: { player?: PlayerHandle }): void => {
  const c = _collector;
  if (!c) return; // lossy by design: no collector, no queue
  const cleanName = String(name ?? '').trim().slice(0, MAX_CUSTOM_NAME_LENGTH) || 'custom';
  const bounded = boundJson(data);
  c.recordCustom({
    t: Date.now(),
    name: cleanName,
    ...(bounded.data !== undefined ? { data: bounded.data } : {}),
    ...(bounded.truncated ? { truncated: true } : {}),
    ...(opts?.player?.id ? { playerId: opts.player.id } : {}),
  });
}, { name: 'vitals.trackVitals' }) as (name: string, data?: unknown, opts?: { player?: PlayerHandle }) => void;

/**
 * Test seam: forget registrations + live references between specs — the
 * registry, the live adapter/collector pointers, AND the `__getActiveVitals()`
 * box. Rebinds `registry` to a fresh instance (not `registry.clear()`) so the
 * id counter also resets per spec — see the `let registry` doc-comment above
 * for why that has to differ from what a live page's `destroy()` does.
 */
export function __resetVitalsForTests(): void {
  registry = createPlayerRegistry();
  _adapter = undefined;
  _collector = undefined;
  // Codex round-2 item 4 — same reasoning as `registry` above: a fresh
  // instance per spec, not a `.clear()`/rebuild, so one spec's detach/token
  // bookkeeping can never leak into the next.
  activeTokens = new WeakMap();
  userDetachedElements = new WeakSet();
  // A spec that fails an assertion before its own `destroy()` runs would
  // otherwise leave a stale box behind for the NEXT spec's
  // `__getActiveVitals()` to return — a false-green generator, which this
  // whole reset seam exists to prevent.
  _active = undefined;
}

/**
 * Generate a v4-ish UUID without a bare `crypto.randomUUID()` call (Fix I3,
 * final review): `randomUUID()` throws on an INSECURE context (plain-http
 * TV/LAN rigs are exactly the kind of host this SDK runs on), so a bare call
 * here would take down the whole start sequence for those hosts. Same
 * guarded-fallback shape as draft-to-envelope.ts's `generateReportId` and
 * companion/device-id.ts's `storedUuid` fallback — not imported from either
 * (the former would be a circular import back into this module, the latter
 * is companion-scoped) but deliberately the same v4/RFC-4122 nibble-stamp
 * over `getRandomValues`, falling back further to `Math.random()` only when
 * even that is unavailable.
 */
function generateVitalsSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      /* insecure context — fall through to the manual construction below */
    }
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function setupVitals(deps: SetupVitalsDeps): VitalsHandle {
  // The once-per-session sampling draw: `drawn` records whether it has run at
  // all, `passed` its outcome. Both are set together, exactly once, the first
  // time the gate reaches the draw (i.e. the first time server+local enabled
  // agree) — every later re-evaluation short-circuits on `drawn` instead of
  // calling Math.random() again.
  let drawn = false;
  let passed = false;

  let started = false;
  let destroyed = false;

  let collector: VitalsCollector | undefined;
  let stopSampler: (() => void) | undefined;
  let playerAdapter: PlayerVitalsAdapter | undefined;
  let onPageHide: (() => void) | undefined;

  /**
   * Shared teardown body — nulls every reference and best-effort tears down
   * whatever was constructed, swallowing each step's own failure (DEFE-02)
   * so one broken teardown doesn't block the others. Used both by a normal
   * stop (`stopIfRunning`) and by `maybeStart`'s rollback on a failed start
   * (Fix I3, final review) — in the rollback case some of these may never
   * have been assigned, which is fine: `?.` no-ops them.
   */
  function teardown(): void {
    try {
      if (onPageHide) window.removeEventListener('pagehide', onPageHide);
    } catch {
      /* swallow — DEFE-02 */
    } finally {
      onPageHide = undefined;
    }
    try {
      playerAdapter?.stop();
    } catch {
      /* swallow — DEFE-02 */
    } finally {
      playerAdapter = undefined;
    }
    try {
      stopSampler?.();
    } catch {
      /* swallow — DEFE-02 */
    } finally {
      stopSampler = undefined;
    }
    try {
      // Sends the final summary — always, and idempotently (collector's own
      // `stopped` latch); see module header.
      collector?.stop();
    } finally {
      collector = undefined;
    }
    _active = undefined;
    _adapter = undefined;
    _collector = undefined;
  }

  /** Tears down a RUNNING session. No-op if not started — safe to call from
   *  both the config-flip path and destroy(), and safe to call twice. */
  function stopIfRunning(): void {
    if (!started) return;
    started = false;
    teardown();
  }

  function maybeStart(): void {
    if (destroyed || started) return;
    const server = __getVitalsServerConfig();
    if (!server?.vitalsEnabled) return;
    if (deps.config.vitals?.enabled === false) return;

    if (!drawn) {
      drawn = true;
      const localRate = deps.config.vitals?.sampleRate ?? 1;
      const rate = Math.min(localRate, server.vitalsSampleRate);
      passed = Math.random() < rate;
    }
    if (!passed) return;

    started = true;

    // Fix I3 (final review): a throw ANYWHERE in the start sequence below
    // (a hostile/broken injected factory, a DOM API failure) must not wedge
    // `started` permanently true — that would silently disable vitals for
    // the rest of the page's life with no way to retry on the next config
    // change. Roll back exactly like a normal stop on any failure.
    try {
      const endpoint = `${deps.apiUrl.replace(/\/$/, '')}/api/ingest/vitals`;
      // The host's identity provider, screened and normalized once by
      // `gateIdentity` (see it for why the gate sits here rather than in a
      // consumer). It goes to the COLLECTOR alone: the collector reads it once
      // per summary and passes the verified token down to the transport with
      // the payload — see `VitalsIdentitySnapshot` in sdk-core's collector.ts
      // for the two-read disagreement that arrangement closes (round-4
      // finding 5).
      const identity = deps.identity ? gateIdentity(deps.identity) : undefined;
      // Task 11 — the transport presents the VERIFIED token (header on the
      // fetch path, envelope field on the beacon path, summaries only) and the
      // collector stamps the UNVERIFIED, self-declared `user` block onto the
      // summary body. Two halves of ONE read: the collector takes the snapshot
      // and hands the token down with the payload, so the transport has no
      // identity dependency of its own to read a second time.
      const send = createVitalsTransport({
        endpoint,
        apiKey: deps.apiKey,
        isKilled: deps.isKilled,
      });

      const c = createVitalsCollector({
        dims: {
          platform: 'web',
          appVersion: deps.config.appVersion ?? '0.0.0',
          sdkVersion: deps.sdkVersion,
        },
        now: () => Date.now(),
        send,
        newSessionId: generateVitalsSessionId,
        // Codex round-3 finding F3 — `player` is assigned just below; this
        // closure isn't invoked until a rotation actually happens (well
        // after this whole function returns), so referencing it here is
        // safe despite the textual ordering.
        onRotate: () => player.reseed(),
        // Codex round-3 item 8 — the real apiKey byte length, so the
        // collector's buffer cap reserves EXACTLY enough headroom for the
        // beacon wrapper this SDK's own transport.ts embeds it in
        // (`{"apiKey":"<key>","payload":<chunk>}`), instead of guessing.
        apiKeyByteLength: utf8ByteLength(deps.apiKey),
        // Task 11 — read per summary (not once here), so a session that starts
        // anonymous and then signs in becomes attributed from its next summary
        // on. The provider is CACHE-ONLY on the token half (controller ruling
        // R7): `sendSummary` is synchronous and also fires on unload, so it
        // can never await the host's identity provider. The consequence is
        // accepted and expected — a cold cache means this one summary carries
        // no token and the session stays anonymous until a later summary
        // carries one; the design spec's rollout section assumes gradual
        // adoption anyway.
        ...(identity ? { identity } : {}),
        // The other half of that ruling — see `warmIdentity` above and the
        // collector's own doc-comment. The cache-only read only ever has
        // something to return because this fills the cache off the hot path.
        ...(deps.warmIdentity ? { warmIdentity: deps.warmIdentity } : {}),
      });
      collector = c;

      const player = attachPlayerVitals({
        onEvent: (e) => c.recordPlayerEvent(e),
        playerIdFor: (el) => registry.idFor(el),
        registered: registry.registered(),
        // Codex round-3 item 2 — consulted on every scan-driven (re-)bind,
        // not just the one-time `registered` seed list above, so an element
        // reparented or unmounted/remounted after start gets its explicit
        // registration back instead of reattaching as unnamed `native`.
        registrationFor: (el) => registry.lookup(el),
        keepSourceQuery: deps.config.vitals?.captureSourceQuery === true,
        // Codex round-2 item 4 (durability half) — shared BY REFERENCE, not
        // copied: an element `detach()`ed before this very start (no adapter
        // existed yet to tell) is already in this set, so the adapter's
        // OWN initial DOM scan (`scanForBind`) skips it immediately instead
        // of silently rebinding it, exactly like a post-start
        // `untrackPlayer()` already does. See `userDetachedElements`'s own
        // doc-comment above.
        userDetached: userDetachedElements,
      });
      playerAdapter = player;
      _adapter = player;
      _collector = c;

      stopSampler = startResourceSampler({
        onSample: (s) => {
          c.recordSample(s);
          // Same tick, by design (spec 2026-09-01) — dropped_frames deltas ride
          // the resource sampler's cadence rather than owning a separate timer.
          player.sampleQuality();
        },
      });

      onPageHide = () => {
        c.flushNow({ beacon: true });
      };
      window.addEventListener('pagehide', onPageHide);

      _active = {
        // Fix I2 (final review): a LIVE getter, not a snapshot taken once
        // here — the collector rotates `sessionId` internally after a
        // 30-min-idle gap (collector.ts's `startNewSession`), and a report
        // built after that rotation must reflect the CURRENT session, not
        // the one active when `maybeStart` happened to run.
        get sessionId(): string {
          return c.sessionId;
        },
        recent: () => c.recent(),
      };
    } catch {
      started = false;
      teardown();
    }
  }

  // Evaluate immediately against whatever the box already holds (a re-init
  // racing a config that resolved before this call, or a test driving the
  // box before setupVitals), THEN subscribe for every later change.
  maybeStart();

  const unsubscribe = __subscribeVitalsServerConfig(() => {
    if (destroyed) return;
    const server = __getVitalsServerConfig();
    if (!server?.vitalsEnabled) {
      stopIfRunning();
      return;
    }
    maybeStart();
  });

  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      stopIfRunning();
      registry.clear();
      // Codex round-2 item 4 — `destroy()` is the same lifecycle-end point
      // that already clears `registry` (see its own header comment): every
      // piece of customer-declared `trackPlayer` intent resets here,
      // including which elements were explicitly detached and which tokens
      // are still "live". `kill()` (a config-flip stop, not `destroy()`)
      // deliberately does NOT reach this — same rule as `registry.clear()`.
      userDetachedElements = new WeakSet();
      activeTokens = new WeakMap();
    },
  };
}
