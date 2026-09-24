// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Player vitals adapter for Session Vitals (web). Auto-attaches to every
// <video>/<audio> element on the page (initial scan + a single
// MutationObserver on the document for elements added/removed later) and
// translates native media events into VitalsPlayerEventType events for
// VitalsCollector.recordPlayerEvent. The one piece of real logic here is the
// buffering state machine: the FIRST `playing` after a `loadstart` is startup
// (time-to-first-frame), not a rebuffer, so the `waiting` that can precede it
// must NOT open a buffer span. Every subsequent `waiting` (including one
// immediately after a `seeking`) opens a span that the next `playing` closes.
import { safeWrap } from '@everframe/sdk-core';
import type { PlayerEmit, PlayerIntegration } from '@everframe/sdk-core';
import { MAX_PLAYER_LIBRARY_LENGTH, type VitalsPlayerEventType } from '@everframe/protocol';
import { sanitizeSource, scrubUrlsInText, type SourceProtocol } from './sanitize-source.js';

export interface AdapterPlayerEvent {
  t: number;
  type: VitalsPlayerEventType;
  data?: Record<string, unknown>;
  playerId: string;
}

export interface TrackPlayerAdapterOptions {
  name?: string;
  integration?: PlayerIntegration;
}

export interface PlayerRegistrationLike {
  element: HTMLMediaElement;
  name?: string;
  integration?: PlayerIntegration;
}

export interface PlayerVitalsAdapter {
  /**
   * Manual escape hatch for elements the auto-attach scan can't see (iframes,
   * shadow DOM), and the upgrade path for a player-library integration
   * (hls.js, Shaka) that resolves AFTER the element was already auto-bound.
   * Idempotent on an already-bound element with no options; supplying a NEW
   * integration on an already-bound element upgrades it in place (same
   * playerId, one more `player_attach` naming the new library). Returns the
   * playerId (minted by `deps.playerIdFor`, or the local counter).
   */
  trackPlayer(el: HTMLMediaElement, opts?: TrackPlayerAdapterOptions): string;
  /** Unbinds AND marks the element so a later DOM scan does not silently re-attach it — explicit customer intent (e.g. tearing down a player) outranks auto-attach. Call `trackPlayer` again to re-arm. */
  untrackPlayer(el: HTMLMediaElement): void;
  /** Called on the 20 s resource-sample tick — emits one `stats` entry per attached player (bufferAheadMs, droppedFrames delta, integration snapshot). */
  sampleQuality(): void;
  /**
   * Codex round-3 finding F3 — called by the collector immediately after an
   * idle/max-age rotation lands a fresh session+accumulator. Re-emits each
   * attached element's CURRENT state into the new session: `player_attach`
   * (the new session has never heard of this player), the cached
   * `source_change`/`drm` facts (same reason), then synthetic `play` if
   * playing / `buffer_start` if a buffer span is open — the old session's
   * spans were already closed by ITS OWN final snapshot, so the new session
   * starts from a blank accumulator that has no idea playback (or
   * buffering, or even this player's identity/source) carries over unless
   * told.
   */
  reseed(): void;
  stop(): void;
}

export interface PlayerVitalsDeps {
  onEvent(e: AdapterPlayerEvent): void;
  /** Player-id authority (the registry in vitals/index.ts, task 7). Default: a local `p1`, `p2`… counter, stable per element for the adapter's lifetime. */
  playerIdFor?(el: HTMLMediaElement): string;
  /** Explicit registrations (name/integration known up front, e.g. a customer-declared player), bound BEFORE the initial DOM scan so their identity wins over auto-attach. */
  registered?: Iterable<PlayerRegistrationLike>;
  /**
   * Codex round-3 item 2 — looked up on every (re-)bind, not just the
   * one-time `registered` seed list above: `registered()` is read ONCE at
   * `attachPlayerVitals` construction, so a registered element that's
   * removed and later re-added (reparented into another container, or
   * unmounted/remounted by an SPA route change) hit the MutationObserver's
   * bare `bind(element)` call with no way to recover its name/integration —
   * defeating the whole reason the registry keeps a STRONG (not weak) map of
   * explicit registrations across remounts (see `registry.ts`'s own
   * doc-comment). Wired to `registry.lookup` in `vitals/index.ts`; omitted
   * (as in every test that constructs the adapter directly) it's simply a
   * no-op fallback to "no registration known" — identical to pre-fix
   * behaviour.
   */
  registrationFor?(el: HTMLMediaElement): PlayerRegistrationLike | undefined;
  /** Keep the query string on `source_change` src values. Default false — signed CDN/license URLs carry tokens in the query. */
  keepSourceQuery?: boolean;
  root?: Document; // default document
  now?(): number; // default Date.now
  /**
   * Codex round-2 item 4 (durability half) — shared BY REFERENCE with
   * `vitals/index.ts`'s module-scoped `userDetachedElements`, not copied:
   * an element `detach()`ed before THIS adapter instance even existed (the
   * collector hadn't started yet) is already in this set by the time
   * `attachPlayerVitals` runs, so the initial DOM scan below honours it
   * immediately instead of silently rebinding it — the same guarantee a
   * post-start `untrackPlayer()` already provides via this adapter's own
   * `userDetached`. Defaults to a fresh, adapter-local `WeakSet` when
   * unsupplied (e.g. every existing unit test that constructs the adapter
   * directly), which is exactly the pre-this-fix behavior.
   */
  userDetached?: WeakSet<HTMLMediaElement>;
}

/** Sanitised, adapter-cached facts about a player's current source — re-emitted verbatim by `reseed()` so a fresh session doesn't start blind to what's already playing. */
interface SourceFacts {
  src: string;
  protocol: SourceProtocol;
  mime?: string;
  live?: boolean;
}

interface ElementState {
  playerId: string;
  name: string | undefined;
  /** Present only while a player-library integration (hls.js, Shaka) owns this element's source/quality/DRM facts. */
  integration: PlayerIntegration | undefined;
  loadStartT: number | undefined;
  sawFirstFrame: boolean;
  buffering: boolean;
  bufferStartT: number | undefined;
  /** Last known source facts (element-derived OR integration-reported) — cached so `reseed()` can re-announce them into a fresh session. */
  lastSource: SourceFacts | undefined;
  /** Last `drm` payload from the integration, cached for the same reseed reason as `lastSource`. */
  lastDrm: Record<string, unknown> | undefined;
  lastDroppedFrames: number;
  lastWidth: number;
  lastHeight: number;
  /** Timestamps of recent non-fatal integration errors, for the per-minute rate limit — see `allowNonFatalError`. */
  nonFatalErrorTs: number[];
  listeners: Array<[string, EventListener]>;
  /**
   * Codex round-3 finding F2 — per-element play/pause tracking. With two
   * attached players, the accumulator's own playCount (summary.ts) needs a
   * `pause` for EVERY element whose play span is still open when that
   * element goes away (detach/error/ended), never one it already closed
   * with a real `pause` — otherwise a spurious extra `pause` would
   * over-decrement the accumulator's shared count and could close the
   * OTHER element's still-open span. Set true on `play`, false on the real
   * `pause`/`ended`/an isPlaying-gated synthetic pause.
   *
   * Codex round-4 — this flag is now TRANSITION-GATED (see `setPlaying`):
   * every call site that used to assign it directly and unconditionally
   * emit now goes through `setPlaying`, which (a) no-ops entirely when the
   * element is already at the target state — fixing unconditional native
   * `play`/`pause` handlers double-emitting against bind-time seeding or a
   * stray queued native event — and (b), for the OPENING transition only,
   * emits BEFORE flipping the flag, so a `reseed()` invoked synchronously
   * inside that same emit's call chain (an idle/max-age rotation whose
   * triggering entry IS this transition) still observes the flag at its
   * OLD (false) value and correctly skips re-announcing the very event
   * that's already in flight — eliminating the reseed double-count.
   */
  isPlaying: boolean;
}

const MEDIA_SELECTOR = 'video, audio';
/** hls.js et al. can emit hundreds of non-fatal fragment/network errors a minute; unthrottled, that floods the ring buffer and evicts real events. Fatal errors always pass — they're rare and matter. */
const NON_FATAL_ERRORS_PER_MINUTE = 10;

export function attachPlayerVitals(deps: PlayerVitalsDeps): PlayerVitalsAdapter {
  const root = deps.root ?? document;
  const now = deps.now ?? (() => Date.now());
  const keepQuery = deps.keepSourceQuery === true;
  const state = new Map<HTMLMediaElement, ElementState>();
  /**
   * Elements explicitly released via `untrackPlayer` — a later DOM scan must
   * not silently re-bind them until `trackPlayer` is called again. Codex
   * round-2 item 4 — uses `deps.userDetached` when supplied (shared by
   * reference with `vitals/index.ts`'s module-scoped set) so a detach that
   * happened BEFORE this adapter instance existed is already honoured by
   * the very first scan below; falls back to a fresh, adapter-local set for
   * every caller that constructs the adapter directly (every existing unit
   * test), preserving prior behavior exactly.
   */
  const userDetached = deps.userDetached ?? new WeakSet<HTMLMediaElement>();
  const localIds = new WeakMap<HTMLMediaElement, string>();
  let nextLocalId = 1;
  /** Default id authority when no registry (task 7) supplies one: a stable local `p1`, `p2`… counter, one id per element for the adapter's lifetime. */
  const playerIdFor =
    deps.playerIdFor ??
    ((el: HTMLMediaElement): string => {
      let id = localIds.get(el);
      if (!id) {
        id = `p${nextLocalId++}`;
        localIds.set(el, id);
      }
      return id;
    });

  function emit(s: ElementState, type: VitalsPlayerEventType, data?: Record<string, unknown>, t: number = now()) {
    // exactOptionalPropertyTypes forbids `data: undefined` — omit the key entirely
    // rather than assign an explicit undefined onto an optional property.
    if (data === undefined) {
      deps.onEvent({ t, type, playerId: s.playerId });
    } else {
      deps.onEvent({ t, type, data, playerId: s.playerId });
    }
  }

  // ── source facts (element-derived; suppressed while an integration owns them) ──
  /** Matches a resolved `currentSrc` back to a `<source type="...">` child, if any, for the `mime` field. */
  function mimeFor(el: HTMLMediaElement, resolvedSrc: string): string | undefined {
    for (const source of Array.from(el.querySelectorAll('source'))) {
      const src = source.getAttribute('src');
      if (!src || !source.type) continue;
      try {
        if (new URL(src, root.baseURI).href === resolvedSrc) return source.type;
      } catch {
        /* malformed <source src> — not this one */
      }
    }
    return undefined;
  }
  function elementSource(el: HTMLMediaElement): SourceFacts | undefined {
    const raw = el.currentSrc || undefined;
    if (!raw) return undefined;
    const clean = sanitizeSource(raw, { keepQuery, baseURI: root.baseURI });
    const mime = mimeFor(el, raw);
    return mime ? { ...clean, mime } : clean;
  }
  /**
   * Element-level source facts — a deliberate no-op while an integration is
   * attached: the integration OWNS source truth (a `blob:` element URL would
   * otherwise mask the real manifest URL the integration reports).
   *
   * Reentrancy — codex round-1 item 3 REVERSES an earlier ruling here.
   * `collector.ts` fires `onRotate` (→ `reseed()`) synchronously AFTER
   * recording the triggering entry, so if this very `source_change` is what
   * trips an idle/max-age rotation, a nested `reseed()` runs before this
   * function returns. Emit-before-cache (the earlier fix) made that nested
   * reseed replay the STALE OLD source — the new session ends up with
   * `[new, old]`, and the admin's last-wins fold reports the WRONG,
   * stale value. `lastSource` is a snapshot folded last-wins, not a span
   * that accumulates, so a repeated IDENTICAL entry (`[new, new]`) is
   * harmless, while a stale final value is a visibly wrong player card.
   * Assign-before-emit trades one harmless duplicate for a correct final
   * value — the right trade for this field. This deliberately differs from
   * `setPlaying`/`setBuffering`, which genuinely must emit before flipping:
   * those open/close spans that would double-count on a replay, not just
   * repeat an identical last-wins fact.
   */
  function emitElementSource(s: ElementState, el: HTMLMediaElement, t: number): void {
    if (s.integration) return;
    const facts = elementSource(el);
    if (!facts) return;
    if (s.lastSource && facts.src === s.lastSource.src) return;
    s.lastSource = facts;
    emit(s, 'source_change', { ...facts }, t);
  }

  // ── integration plumbing ────────────────────────────────────────────────
  /** Non-fatal integration errors: at most 10 per rolling minute, per player. Fatal errors bypass this entirely (checked by the caller). */
  function allowNonFatalError(s: ElementState, t: number): boolean {
    s.nonFatalErrorTs = s.nonFatalErrorTs.filter((ts) => t - ts < 60_000);
    if (s.nonFatalErrorTs.length >= NON_FATAL_ERRORS_PER_MINUTE) return false;
    s.nonFatalErrorTs.push(t);
    return true;
  }
  /**
   * The `PlayerEmit` handed to `integration.attach()` — routes
   * `source_change`/`drm` through the adapter's own cache (so `reseed()` can
   * replay them) and rate-limits non-fatal `error`s. Wrapped in `safeWrap`:
   * this closure is the only foreign-code entry point in the file that
   * wasn't already covered by `on()`/the MutationObserver/`sampleQuality`/
   * `stop`/`reseed` — it's called synchronously from THIRD-PARTY library
   * code (hls.js/Shaka event dispatch), so an exception from `deps.onEvent`
   * must not propagate back into that dispatch loop and break playback on
   * the host page.
   */
  function integrationEmit(s: ElementState): PlayerEmit {
    return safeWrap(
      (type, data, t) => {
        const at = t ?? now();
        if (type === 'source_change') {
          // The integration owns source truth while attached — sanitise its
          // reported src the same way an element-derived one would be, so a
          // signed CDN/license URL's query string is stripped by default here
          // too, not just on the native-element path.
          const clean = sanitizeSource(typeof data?.src === 'string' ? data.src : undefined, {
            keepQuery,
            baseURI: root.baseURI,
          });
          const facts: SourceFacts = {
            src: clean.src,
            protocol: typeof data?.protocol === 'string' ? (data.protocol as SourceProtocol) : clean.protocol,
            ...(typeof data?.mime === 'string' ? { mime: data.mime } : {}),
            ...(typeof data?.live === 'boolean' ? { live: data.live } : {}),
          };
          // Reentrancy — codex round-1 item 3 reverses an earlier ruling
          // here; see `emitElementSource`'s doc-comment for the full
          // reasoning (same rule, same rotation scenario, this time for the
          // integration-reported source). Assign BEFORE emitting: `lastSource`
          // is a snapshot folded last-wins by the admin, not a span that
          // accumulates, so if this very emit trips a nested `reseed()` (an
          // idle/max-age rotation whose trigger IS this source_change), the
          // replay sees the CURRENT source and repeats an identical,
          // harmless entry — instead of replaying a now-stale one that would
          // make the admin report the WRONG final source.
          s.lastSource = facts;
          emit(s, 'source_change', { ...facts }, at);
          return;
        }
        if (type === 'drm') {
          // Copy once, share the copy between the emitted event and the
          // cache: an integration that reuses/mutates its payload object
          // after this call must not retroactively alter either an entry
          // already sitting in the ring buffer or the value `reseed()` will
          // replay later. Assign-before-emit for the same reentrancy reason
          // as `source_change` above — `lastDrm` is the same kind of
          // last-wins snapshot, so a nested reseed repeating the CURRENT
          // value is the correct trade over replaying a stale one.
          const facts = data ? { ...data } : data;
          s.lastDrm = facts;
          emit(s, 'drm', facts, at);
          return;
        }
        // Unlabelled (`fatal` absent) is treated as non-fatal — the safe
        // default, and what the field means: only an EXPLICIT `fatal: true`
        // should bypass the cap. `data?.fatal === false` would let an
        // integration that omits the key entirely flood the ring buffer
        // unbounded, which is exactly the eviction this cap exists to
        // prevent.
        if (type === 'error' && data?.fatal !== true && !allowNonFatalError(s, at)) return;
        // Copy for the same shared-mutable-reference reason as `drm` above —
        // this is the generic fallthrough for every OTHER integration event
        // type (error, bitrate_change, …), none of which get their own copy
        // otherwise.
        const payload = data ? { ...data } : data;
        // Codex round-2 item 1 — an integration's `error` text is free-form
        // prose that can embed the FULL failing request URL verbatim (a real
        // Shaka/hls.js HTTP failure does exactly this), and a signed CDN or
        // licence URL carries its token in the query string. `source_change`
        // above already sanitises `src` for the same reason; error text
        // walked straight around that because it isn't a `src` field at all.
        // Scrub any URL-shaped substring out of the free-text fields here —
        // the ONE funnel every integration's (built-in or a customer's own)
        // events pass through — reusing `sanitizeSource`'s own origin+path
        // reduction (`scrubUrlsInText`) rather than a second URL parser.
        if (type === 'error' && payload) {
          if (typeof payload.message === 'string') payload.message = scrubUrlsInText(payload.message);
          if (typeof payload.detail === 'string') payload.detail = scrubUrlsInText(payload.detail);
        }
        emit(s, type, payload, at);
      },
      { name: 'vitals.player.integrationEmit' },
    );
  }
  /**
   * `player_attach` payload: `name` only when set, `library` defaults to
   * `'native'` with no integration attached, `libraryVersion` only when the
   * integration reports one.
   *
   * Codex round-2 item 5 — `integration.library`/`.version` are read here
   * DEFENSIVELY, inside their own try/catch: a throwing metadata getter used
   * to escape straight out of `bind()`/`upgrade()` (both call this BEFORE
   * `startIntegration()` ever runs `attach()`), leaving the element's state
   * already inserted with `s.integration` set to an integration that never
   * attached — permanently suppressing native source/resize collection (see
   * `emitElementSource`/the `resize` listener's own `if (s.integration)
   * return` guards) with no `attach()` ever having run to trigger the
   * EXISTING correction path (`startIntegration`'s `degraded` return, used
   * by `upgrade()`/`bind()` below). A throw here degrades to native the same
   * way a failed `attach()` does — via the same `degradeIntegration` — and
   * does so BEFORE this `player_attach` goes out, so the single event
   * emitted here already names the library that will actually be collected.
   *
   * Codex round-2 item 11 — `library`/`libraryVersion` are coerced to
   * strings and capped at `MAX_PLAYER_LIBRARY_LENGTH` (spec: "library ≤ 32
   * chars"): both are foreign, integration-supplied values with no length
   * limit of their own, and an oversized one would otherwise inflate every
   * `player_attach` and, via the recent ring, every enriched report until it
   * expires.
   */
  function emitAttach(s: ElementState, el: HTMLMediaElement, t: number = now()): void {
    const lib = s.integration;
    let library = 'native';
    let libraryVersion: string | undefined;
    if (lib) {
      try {
        const rawLibrary = lib.library;
        const rawVersion = lib.version;
        library = (rawLibrary != null ? String(rawLibrary) : 'native').slice(0, MAX_PLAYER_LIBRARY_LENGTH) || 'native';
        libraryVersion = rawVersion != null ? String(rawVersion).slice(0, MAX_PLAYER_LIBRARY_LENGTH) : undefined;
      } catch {
        degradeIntegration(s, lib);
        library = 'native';
        libraryVersion = undefined;
      }
    }
    emit(
      s,
      'player_attach',
      {
        ...(s.name ? { name: s.name } : {}),
        // Codex round-7 item 4 — this two-way ternary is only safe because
        // `vitals/index.ts`'s `isMediaElement` now REJECTS anything whose
        // `tagName` isn't literally `'VIDEO'` or `'AUDIO'` (round 6's check
        // only required `tagName` to be a string, so a media-like custom
        // element or a `<div>` with the right duck-typed properties reached
        // here and was mislabeled `'audio'`, corrupting the player count and
        // timeline). `bind()` is only ever reached, in production, for an
        // element that already passed that gate.
        tag: el.tagName === 'VIDEO' ? 'video' : 'audio',
        library,
        ...(libraryVersion ? { libraryVersion } : {}),
      },
      t,
    );
  }
  /**
   * Fix wave item 5 — an integration can fail to subscribe two ways: it
   * throws (a bug), or its `attach()` returns `false` (a deliberate signal
   * — the duck-type check for the expected library shape failed, e.g. the
   * customer passed the wrong object). Both degrade the SAME way: drop the
   * integration so element-derived source/quality facts resume instead of
   * leaving the player labelled with a library that never reports anything.
   * Best-effort `detach()`: an `attach()` that failed PARTWAY (threw after
   * registering some listeners, or returned `false` after doing the same)
   * may already have wired something onto the player library — without
   * this, that leaks for the page's lifetime. Guarded the same way
   * `detachIntegration` guards its own call, since a library whose
   * `attach()` is broken enough to fail this way is not a library whose
   * `detach()` can be trusted not to either.
   */
  function degradeIntegration(s: ElementState, i: PlayerIntegration): void {
    s.integration = undefined;
    try {
      i.detach();
    } catch {
      /* integration bug must not take the adapter down */
    }
  }
  /**
   * Returns `true` when the integration was just degraded (attach() threw,
   * or returned `false`) — codex round-1 item 7 uses this to decide whether
   * a corrected `player_attach` is needed, since the caller already emitted
   * one naming the (now-rejected) integration's library before this ran.
   */
  function startIntegration(s: ElementState, el: HTMLMediaElement): boolean {
    const i = s.integration;
    if (!i) return false;
    try {
      const ok = i.attach({ element: el, emit: integrationEmit(s), now });
      if (ok === false) {
        degradeIntegration(s, i);
        return true;
      }
      return false;
    } catch {
      // A broken integration must not take the whole player down — fall
      // back to the native/element-level path as if none was ever supplied.
      degradeIntegration(s, i);
      return true;
    }
  }
  function detachIntegration(s: ElementState): void {
    const i = s.integration;
    if (!i) return;
    s.integration = undefined;
    try {
      i.detach();
    } catch {
      /* integration bug must not take the adapter down */
    }
  }
  function startupTimings(s: ElementState): Record<string, unknown> {
    try {
      return { ...(s.integration?.startupTimings?.() ?? {}) };
    } catch {
      return {};
    }
  }

  /**
   * Codex round-2 finding R9 — a single place that closes an OPEN buffer
   * span, called from every event/path that can end one:
   * pause/ended/error/loadstart, element detach (unbind), and adapter
   * stop(). Before this, only `playing` and (for the source-swap case)
   * `loadstart` closed a span — a `waiting` followed by `pause` (user pauses
   * while buffering, then never resumes), an `error` mid-rebuffer, or the
   * element being removed/the adapter stopping mid-rebuffer all left the
   * span open, poisoning `rebufferDurationMs` for the rest of the session
   * (or forever, for a session-ending stop()).
   */
  function closeOpenBufferSpan(s: ElementState, t: number): void {
    if (!s.buffering) return;
    s.buffering = false;
    emit(s, 'buffer_end', { durationMs: Math.max(0, t - (s.bufferStartT ?? t)) }, t);
    s.bufferStartT = undefined;
  }

  /**
   * Codex round-4 — single gated entry point for every `isPlaying`
   * transition. Two defects, one fix:
   *
   *  1. Unconditional emits (finding: "unconditional native emits"): every
   *     call site used to assign `s.isPlaying` and emit regardless of the
   *     CURRENT value — bind-time seeding emits a synthetic `play` (sets
   *     isPlaying=true), then the element's already-queued native `play`
   *     fires and emits AGAIN; symmetrically, an element paused at bind
   *     (isPlaying stays false) can still have a stray queued native
   *     `pause` fire and emit, decrementing the accumulator's SHARED
   *     playCount below zero-relative-to-reality and potentially closing
   *     another element's genuinely-open span. The `s.isPlaying === next`
   *     guard below makes every transition a no-op unless it's real.
   *
   *  2. Reseed double-count (finding: "reseed double-counts the rotation
   *     trigger"): a `play` handler emits -> the collector detects an
   *     idle/max-age boundary, rotates, and synchronously calls `onRotate`
   *     -> `reseed()`, all INSIDE this same call stack (everything here is
   *     synchronous). The old code set `s.isPlaying = true` BEFORE calling
   *     emit, so by the time reseed's synchronous nested call ran, it saw
   *     isPlaying already true and re-announced ANOTHER `play` for the
   *     very same element into the brand-new session — the new
   *     accumulator's playCount ends up at 2 for a span only one real
   *     `pause` will ever close, leaving it open (over-counting playtime)
   *     for the rest of the session. Emitting the OPENING transition
   *     (`play`) FIRST and flipping the flag only AFTER `emit` returns
   *     means reseed's nested read of `s.isPlaying` still sees the OLD
   *     (false) value and correctly skips re-announcing this element —
   *     `reseed()` itself is unchanged (per contract, it must not mutate
   *     state); only the ORDER on this side changed.
   *
   *     The CLOSING transition (`pause`) deliberately keeps the opposite,
   *     pre-existing order — flag flipped false BEFORE emit. This matters
   *     for the exact same reentrancy reason: a long-running play can
   *     itself be the rotation trigger when it finally pauses (this is
   *     precisely the scenario finding F3/round-3 built `reseed()` for —
   *     playback spanning an idle gap with no other entries in between).
   *     If the flag were still true during that pause's nested reseed
   *     call, reseed would wrongly re-announce a `play` for an element
   *     that is in the process of stopping, opening a phantom span in the
   *     new session that nothing will ever close. Flipping false first
   *     (as before) keeps that case correct.
   */
  function setPlaying(s: ElementState, next: boolean, t: number = now()): void {
    if (s.isPlaying === next) return;
    if (next) {
      emit(s, 'play', undefined, t);
      s.isPlaying = true;
    } else {
      s.isPlaying = false;
      emit(s, 'pause', undefined, t);
    }
  }

  /**
   * Codex round-4 — `setBuffering`'s buffering-flag counterpart to
   * `setPlaying` above, same two-defect fix and same asymmetric ordering:
   * the OPENING transition (`buffer_start`, e.g. a `waiting` entry that
   * itself triggers an idle/max-age rotation) emits before flipping
   * `s.buffering`, so a reentrant `reseed()` doesn't double-announce the
   * span it's in the middle of opening. The CLOSING transition delegates to
   * the pre-existing `closeOpenBufferSpan`, which already flips the flag
   * false before emitting `buffer_end` — correct as-is, unchanged.
   */
  function setBuffering(s: ElementState, next: boolean, t: number = now()): void {
    if (s.buffering === next) return;
    if (next) {
      emit(s, 'buffer_start', undefined, t);
      s.buffering = true;
      s.bufferStartT = t;
    } else {
      closeOpenBufferSpan(s, t);
    }
  }

  /** `<video>`-only: current `droppedVideoFrames`, or `undefined` when the API isn't available (audio, or an engine without it) — the caller decides what "no reading" means (bind-time baseline vs. a stats tick's delta). */
  function readDroppedFrames(el: HTMLMediaElement): number | undefined {
    if (el.tagName !== 'VIDEO') return undefined;
    const getQuality = (el as HTMLVideoElement).getVideoPlaybackQuality;
    if (typeof getQuality !== 'function') return undefined;
    try {
      return getQuality.call(el as HTMLVideoElement).droppedVideoFrames;
    } catch {
      return undefined;
    }
  }
  /** Milliseconds of buffer ahead of `currentTime` in the range that contains it — 0 if none does (nothing buffered there yet) or the element is detached. */
  function bufferAheadMs(el: HTMLMediaElement): number {
    try {
      const b = el.buffered;
      const ct = el.currentTime;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= ct && ct <= b.end(i)) return Math.max(0, Math.round((b.end(i) - ct) * 1000));
      }
    } catch {
      /* detached element — buffered/currentTime can throw */
    }
    return 0;
  }

  /**
   * `trackPlayer` on an element already in `state` upgrades it in place
   * instead of re-binding: a customer-declared `name` wins, and a NEW
   * integration (e.g. hls.js resolving after the element auto-bound as
   * native) replaces whatever was attached before and gets its own
   * `player_attach` announcing the new library — same playerId throughout,
   * since identity belongs to the ELEMENT, not to which library happens to
   * be driving it at a given moment.
   */
  function upgrade(s: ElementState, el: HTMLMediaElement, opts: TrackPlayerAdapterOptions | undefined): void {
    // Codex round-3 item 6 — captured BEFORE `s.name` is overwritten, so the
    // branch below can tell an actual change (customer supplies a NEW name)
    // from a repeat call that happens to supply the same one (a re-scan
    // that re-consults the registry for an already-bound element, or a
    // customer re-calling trackPlayer with unchanged options) — the latter
    // must stay a no-op, not emit a redundant player_attach.
    const nameChanged = opts?.name !== undefined && opts.name !== s.name;
    if (opts?.name !== undefined) s.name = opts.name;
    if (opts?.integration && opts.integration !== s.integration) {
      detachIntegration(s);
      s.integration = opts.integration;
      emitAttach(s, el);
      const degraded = startIntegration(s, el);
      // Codex round-1 item 7 — the `player_attach` just above already named
      // the requested (now-rejected) integration's library; emit a
      // corrected one so the admin card matches what will actually be
      // collected (native), instead of a session that collects native
      // facts under a label that says otherwise.
      if (degraded) emitAttach(s, el);
      // Fix wave item 5 — if `startIntegration` just degraded `s.integration`
      // back to undefined (wrong-instance `attach()` failure), immediately
      // re-describe the element's CURRENT source instead of waiting for the
      // next `loadstart` — mirrors `bind()`'s own bind-time
      // `emitElementSource` call for the same reason.
      emitElementSource(s, el, now());
    } else if (nameChanged) {
      // Codex round-3 item 6 — a repeat `trackPlayer()` that supplies ONLY a
      // new/first name (no integration change) used to update `s.name`
      // silently: the `emitAttach` above only ran from the integration-
      // changed branch. Auto-attach routinely binds a native element BEFORE
      // `trackPlayer({ element, name })` resolves — exactly what the React
      // hook and the example app do — so without this re-emit, the admin
      // timeline shows that player as unnamed for the entire session unless
      // an unrelated idle/max-age rotation happens to reseed it later.
      // `emitAttach` reads the already-updated `s.name`/`s.integration`, so
      // this correctly reports the CURRENT (unchanged) library alongside
      // the new name.
      emitAttach(s, el);
    }
  }

  function bind(el: HTMLMediaElement, opts?: TrackPlayerAdapterOptions): string {
    const existing = state.get(el);
    if (existing) {
      // Already attached — trackPlayer and the observer share this guard.
      // Bare re-calls (no opts) stay a no-op past this point, same as before
      // phase 4; a call carrying name/integration upgrades in place.
      upgrade(existing, el, opts);
      return existing.playerId;
    }
    // An explicit trackPlayer() call is customer intent that outranks a
    // prior untrackPlayer() — re-arm auto-rebind eligibility for this
    // element (the DOM scan itself never calls bind() with an element still
    // in userDetached; see scanForBind).
    userDetached.delete(el);

    // Codex round-2 finding R9 — bind-time seeding. `attachPlayerVitals` can
    // run AFTER an element has already started playing (config resolves
    // asynchronously, after an autoplaying element's own `playing` event
    // already fired) — the adapter must not assume every element starts
    // from a blank, pre-playback state.
    //
    // `sawFirstFrame`: readyState >= 3 (HAVE_FUTURE_DATA) + not paused means
    // frames are already flowing — without this, the NEXT `playing` (e.g.
    // after a later rebuffer) would be misread as a first-ever startup and
    // emit a bogus `startup` event with a meaningless ttffMs. This is
    // DELIBERATELY narrower than the synthetic-play condition below (Codex
    // round-3 finding F1) — a `readyState < 3` element that is already
    // playing has not yet rendered a first frame, so the next `playing`
    // SHOULD still be read as startup, not rebuffer recovery.
    const sawFirstFrame = !el.paused && el.readyState >= 3;
    // Codex round-3 finding F1 — whether to emit the bind-time synthetic
    // `play` must NOT depend on readyState. An element where `play` already
    // fired but the first frame hasn't arrived yet (paused === false,
    // readyState < 3) is genuinely playing (from the accumulator's
    // perspective, the play span is open) even though `sawFirstFrame` above
    // is correctly false for it — gating the synthetic play on the same
    // `readyState >= 3` check as sawFirstFrame left that playback's playtime
    // stuck at 0 for as long as it took the first frame to arrive.
    const isPlayingAtBind = !el.paused && !el.ended;
    // Dropped-frames baseline: seeded from the element's OWN current count,
    // not 0 — an element with history (already played for a while before
    // this adapter attached) would otherwise have every dropped frame from
    // BEFORE this session's start attributed to the first sampleQuality()
    // tick as a fresh delta.
    const initialDroppedFrames = readDroppedFrames(el) ?? 0;

    // Codex round-4 — `isPlaying` starts false unconditionally, even for an
    // element that's already mid-playback at bind time (`isPlayingAtBind`).
    // The bind-time synthetic `play` below now goes through `setPlaying`,
    // which gates on `s.isPlaying === next` — seeding this field to `true`
    // up front would make that very call a no-op and silently drop the
    // synthetic play. `setPlaying(s, true, ...)` is what actually flips it.
    const s: ElementState = {
      playerId: playerIdFor(el),
      name: opts?.name,
      integration: opts?.integration,
      loadStartT: undefined,
      sawFirstFrame,
      buffering: false,
      bufferStartT: undefined,
      lastSource: undefined,
      lastDrm: undefined,
      lastDroppedFrames: initialDroppedFrames,
      lastWidth: 0,
      lastHeight: 0,
      nonFatalErrorTs: [],
      listeners: [],
      isPlaying: false,
    };
    state.set(el, s);
    emitAttach(s, el);
    const degraded = startIntegration(s, el);
    // Codex round-1 item 7 — same correction as `upgrade()`: the
    // `player_attach` above already claimed the requested integration's
    // library before `attach()` got a chance to reject the instance.
    if (degraded) emitAttach(s, el);
    // A source that's already known at bind time (e.g. a `<video src>`
    // present before the SDK loaded) gets its own source_change right away —
    // otherwise nothing would ever report it, since `loadstart` won't fire
    // again for a src that was never (re)loaded after this adapter attached.
    emitElementSource(s, el, now());

    function on(type: string, handler: (ev: Event) => void) {
      const wrapped = safeWrap(handler, { name: `vitals.player.${type}` }) as EventListener;
      el.addEventListener(type, wrapped);
      s.listeners.push([type, wrapped]);
    }

    on('loadstart', () => {
      const t = now();
      // Fix T6-upgrade (final review); refactored onto closeOpenBufferSpan
      // (Codex round-2 finding R9) — a source change mid-rebuffer (waiting
      // → loadstart, e.g. a quality/source swap) must close the OPEN buffer
      // span before resetting `s.buffering` — otherwise the accumulator's
      // span never gets a `buffer_end` and stays open until the session
      // ends, poisoning rebufferDurationMs with everything from here to
      // end-of-session.
      setBuffering(s, false, t);
      // Codex round-5 finding F1 — replacing the source of a PLAYING element
      // resets `.paused` to true WITHOUT firing a `pause` event (the HTML
      // media load algorithm's src-change steps), then fires `loadstart`.
      // Without this, `isPlaying` stayed true straight through the
      // reload/startup gap: playtime kept accruing for however long the new
      // source took to start, and a rotation landing between this loadstart
      // and the next `playing` would have `reseed()` re-announce a `play`
      // for an element that, per the DOM, is not currently playing —
      // seeding a phantom span in the new session. `setPlaying` emits a
      // synthetic `pause` (transition-gated, so a genuinely-paused element
      // is a no-op) before the source/startup state below is reset.
      setPlaying(s, false, t);
      s.loadStartT = t;
      s.sawFirstFrame = false;
      // Phase 4 — `source_change` now carries a payload and fires on the
      // FIRST src too, not just a later change (the old "first non-empty src
      // is not a change" suppression is gone: bind-time seeding above
      // already covers the attach-then-set-src ordering, so a same-src
      // reload is the only thing `emitElementSource`'s own `lastSource`
      // check still needs to suppress).
      emitElementSource(s, el, t);
    });

    on('play', () => {
      // Codex round-4 — gated: bind-time seeding (below) may already have
      // marked this element playing and emitted the synthetic `play`; the
      // NATIVE `play` that was already queued at that moment must not emit
      // a second one. `setPlaying` no-ops when isPlaying already matches.
      setPlaying(s, true);
    });
    on('pause', () => {
      const t = now();
      // Codex round-2 finding R9 — a pause while buffering (user pauses
      // mid-rebuffer and never resumes into a `playing` event) must close
      // the span here, not leave it open indefinitely.
      setBuffering(s, false, t);
      // Codex round-4 — the real `pause` event used to be forwarded
      // UNCONDITIONALLY. An element already paused at bind time (isPlaying
      // stays false) can still have a stray native `pause` queued before
      // this adapter attached fire afterward; unconditionally emitting it
      // would decrement the accumulator's SHARED playCount (summary.ts)
      // below what reality warrants and could close another element's
      // genuinely-open span. `setPlaying` gates this exactly like the
      // isPlaying-gated SYNTHETIC pauses below (Codex round-3 finding F2).
      setPlaying(s, false, t);
    });

    // Codex round-2 finding R9 — `ended` has no dedicated
    // VitalsPlayerEventType of its own; it maps onto `pause` semantics
    // (closes the accumulator's open playtime span the same way an explicit
    // pause would) plus closes any still-open buffer span, since a `pause`
    // event is not guaranteed to fire before `ended` on every engine.
    //
    // Codex round-3 finding F2 — gate the synthetic pause on `isPlaying`:
    // some engines DO fire a real `pause` immediately before `ended`, which
    // already closed this element's play span (and cleared isPlaying). An
    // unconditional second `pause` here would over-decrement the
    // accumulator's shared playCount (summary.ts) and could incorrectly
    // close ANOTHER element's still-open play span in a multi-player
    // session.
    on('ended', () => {
      const t = now();
      setBuffering(s, false, t);
      setPlaying(s, false, t);
    });

    on('seeking', () => {
      emit(s, 'seek', { from: el.currentTime });
    });

    on('ratechange', () => emit(s, 'rate_change', { rate: el.playbackRate }));

    on('error', () => {
      const t = now();
      // Codex round-2 finding R9 — an error mid-rebuffer must close the
      // open span; the element may never emit another `playing` to do it.
      setBuffering(s, false, t);
      // Codex round-3 finding F2 — same isPlaying gate as `ended` above: an
      // error while genuinely playing must close this element's play span,
      // but only if it hasn't already been closed by a real `pause`.
      setPlaying(s, false, t);
      const err = el.error;
      // Phase 4 widens `error` to carry an optional `code` — for a native
      // MediaError that's 1-4, the signal an operator triaging a spike of
      // playback errors needs to separate a network failure from a decode
      // failure from an unsupported source. Only included when present, so
      // a schema-driven error without a numeric code still emits cleanly.
      emit(s, 'error', { message: err?.message ?? 'code ' + err?.code, ...(err?.code != null ? { code: err.code } : {}) }, t);
    });

    on('waiting', () => {
      if (!s.sawFirstFrame) return; // pre-first-frame waiting is startup latency, not a rebuffer
      // Codex round-4 — the `s.buffering` re-check that used to live here is
      // now `setBuffering`'s own no-op guard; this ALSO closes the reseed
      // reentrancy hole (see `setBuffering`'s doc-comment) for a `waiting`
      // that itself triggers an idle/max-age rotation.
      setBuffering(s, true);
    });

    on('playing', () => {
      // Codex round-3 finding F2 — `playing` is the DEFINITIVE "this element
      // is actively playing right now" signal (it can fire without a
      // preceding `play` observed by this adapter — e.g. resuming after a
      // rebuffer only fires `waiting`/`playing`, not another `play`), so it
      // must set isPlaying too, not just the `play` handler above. Without
      // this, an element that reached "playing" purely via a buffer
      // recovery would still read as NOT playing to the isPlaying-gated
      // synthetic-pause paths (unbind/error/ended) below.
      //
      // Deliberately a RAW assignment, not `setPlaying` — `playing` has no
      // VitalsPlayerEventType of its own to emit; it's bookkeeping only, so
      // there's no transition event whose ordering `setPlaying` needs to
      // gate against.
      s.isPlaying = true;
      if (!s.sawFirstFrame) {
        s.sawFirstFrame = true;
        const t = now();
        // Codex round-2 finding R9 — clamp ttffMs: a backwards clock (or a
        // loadStartT captured after this playing event, which should not
        // happen but must never produce a schema-invalid negative) must not
        // reach the accumulator as negative.
        //
        // Phase 4 — merged with `integration.startupTimings()` (manifest
        // fetch, license acquisition, first-fragment download — none of
        // which the bare element can see). `startupTimings` never throws
        // (wrapped internally) and returns `{}` with no integration.
        emit(s, 'startup', { ttffMs: Math.max(0, t - (s.loadStartT ?? t)), ...startupTimings(s) }, t);
        return;
      }
      setBuffering(s, false, now());
    });

    if (el.tagName === 'VIDEO') {
      // Native `quality_change` — dimensions only, and only while no
      // integration is attached: an ABR integration's own bitrate/quality
      // reporting (task 5/6) carries dimensions alongside bitrate/level, and
      // reporting both would double-report the same resize from two
      // sources with no way for a reader to tell they're the same event.
      on('resize', () => {
        if (s.integration) return;
        const v = el as HTMLVideoElement;
        const w = v.videoWidth;
        const h = v.videoHeight;
        if (w > 0 && h > 0 && (w !== s.lastWidth || h !== s.lastHeight)) {
          s.lastWidth = w;
          s.lastHeight = h;
          emit(s, 'quality_change', { width: w, height: h });
        }
      });
    }

    // Codex round-2 finding R9 (widened by round-3 finding F1) — bind-time
    // seeding: an element already mid-playback at bind time will never fire
    // another `play` event (it's already playing), so without a synthetic
    // one here the accumulator's playtime span never opens and this session
    // undercounts playtime by however long the element keeps playing. Gated
    // on `isPlayingAtBind` (paused/ended only), NOT `sawFirstFrame` — see
    // that variable's own comment above for why the two must diverge.
    //
    // Codex round-4 — routed through `setPlaying` (isPlaying was seeded
    // false above specifically so this call is a real transition, not a
    // no-op) so the element's ALREADY-QUEUED native `play` event firing
    // right after bind is correctly gated: `setPlaying`'s own no-op guard
    // (isPlaying already true) absorbs it instead of emitting a second
    // `play`.
    if (isPlayingAtBind) {
      setPlaying(s, true);
    }
    return s.playerId;
  }

  function unbind(el: HTMLMediaElement) {
    const s = state.get(el);
    if (!s) return;
    const t = now();
    // Codex round-2 finding R9 — close any open buffer span BEFORE removing
    // listeners/deleting state, so a detach mid-rebuffer still emits its
    // buffer_end (covers both direct removal and the adapter's own stop()
    // below, which unbinds every tracked element).
    setBuffering(s, false, t);
    // Codex round-3 finding F2 — detaching/replacing a PLAYING element must
    // close its play span with a synthetic `pause`, same isPlaying gate as
    // `ended`/`error` above. Before this fix, unbinding a playing element
    // (removed from the DOM, or replaced by a source-swap that the
    // MutationObserver sees as remove+add) emitted nothing, leaving that
    // element's play span open in the accumulator FOREVER — since stop()
    // itself unbinds every tracked element, this also covers the "stop()
    // closes all elements' open play spans" requirement.
    setPlaying(s, false, t);
    // Phase 4 — a library integration's own resources (event listeners onto
    // hls.js/Shaka, timers, sockets) must be torn down whenever the adapter
    // stops watching this element, not just when a NEW integration replaces
    // it in `upgrade()`.
    detachIntegration(s);
    for (const [type, handler] of s.listeners) {
      el.removeEventListener(type, handler);
    }
    state.delete(el);
    // Emitted AFTER state.delete so a broken onEvent handler that somehow
    // re-enters trackPlayer() for this element sees a clean slate, not a
    // half-torn-down one.
    emit(s, 'player_detach', undefined, t);
  }

  /**
   * Codex round-3 item 2 — every scan-driven bind (initial scan AND the
   * MutationObserver) consults `deps.registrationFor` so a re-added element
   * that was explicitly registered gets its name/integration back instead of
   * reattaching bare as unnamed `native`. `bind`/`upgrade` treat a `undefined`
   * lookup result exactly like the old bare `bind(el)` call — no behaviour
   * change for an auto-attached element with no registration.
   */
  function bindFromScan(el: HTMLMediaElement) {
    bind(el, deps.registrationFor?.(el));
  }

  function scanForBind(node: Node) {
    const el = node as Element;
    // `untrackPlayer` marks an element so a later DOM scan (this one, or the
    // MutationObserver's) does not silently re-bind it — only an explicit
    // `trackPlayer()` call re-arms it (see `bind`'s userDetached.delete).
    if (el.matches?.(MEDIA_SELECTOR) && !userDetached.has(el as HTMLMediaElement)) bindFromScan(el as HTMLMediaElement);
    el.querySelectorAll?.(MEDIA_SELECTOR).forEach((child) => {
      if (!userDetached.has(child as HTMLMediaElement)) bindFromScan(child as HTMLMediaElement);
    });
  }

  function scanForUnbind(node: Node) {
    const el = node as Element;
    if (el.matches?.(MEDIA_SELECTOR)) unbind(el as HTMLMediaElement);
    el.querySelectorAll?.(MEDIA_SELECTOR).forEach((child) => unbind(child as HTMLMediaElement));
  }

  // Explicit registrations (name/identity known up front) bind BEFORE the
  // DOM scan below, so their name/integration win over whatever the scan
  // would have auto-attached as a bare native element.
  //
  // Codex round-5 item 2 (safety-net half) — each registration is bound in
  // its OWN try/catch. `vitals/index.ts`'s `trackPlayer()` now rejects a
  // non-element up front (the honest-contract half of this same item — see
  // `isMediaElement`'s doc-comment there), but this loop must not depend on
  // every caller enforcing that: a caller constructing `attachPlayerVitals`
  // directly with a malformed `registered` list (every existing unit test
  // in this file does exactly this) is a real, supported entry point too.
  // Before this fix, `bind()` throwing here (e.g. a fake element with no
  // `addEventListener`) propagated straight out of this loop and out of
  // `attachPlayerVitals` itself — aborting `maybeStart()` in
  // `vitals/index.ts` and losing ALL telemetry for the page, not just the
  // one bad registration. A plain per-iteration try/catch (not `safeWrap`,
  // which only wraps a single call and doesn't help a `for` loop keep going
  // to its NEXT iteration) keeps every OTHER registration — and the DOM
  // scan after this loop — unaffected by one bad entry.
  for (const r of deps.registered ?? []) {
    try {
      bind(r.element, {
        ...(r.name !== undefined ? { name: r.name } : {}),
        ...(r.integration ? { integration: r.integration } : {}),
      });
    } catch {
      /* one bad registration must not take the rest of startup down */
    }
  }
  scanForBind(root.documentElement);

  const observer = new MutationObserver(
    safeWrap(
      (mutations: MutationRecord[]) => {
        for (const m of mutations) {
          m.addedNodes.forEach(scanForBind);
          m.removedNodes.forEach(scanForUnbind);
        }
      },
      { name: 'vitals.player.mutationObserver' },
    ),
  );
  observer.observe(root.documentElement, { childList: true, subtree: true });

  // Phase 4 — `stats` supersedes the old per-tick `dropped_frames`: one
  // entry per bound player, carrying bufferAheadMs and the droppedFrames
  // delta the old handler computed PLUS whatever the integration's
  // `snapshot()` knows (bitrate ladder, current rendition, bandwidth
  // estimate) that a bare media element cannot see. `dropped_frames` itself
  // is never emitted by this adapter anymore — the enum value stays only so
  // already-stored phase 1-3 sessions still parse.
  const sampleQuality = safeWrap(
    () => {
      for (const [el, s] of state) {
        // Fix wave item 6 — an element that has never had a known source
        // and isn't currently playing is idle (an unbound <video> on a
        // media-heavy page, or one whose source hasn't resolved yet): a
        // `stats` entry for it every 20s tells an operator nothing and
        // crowds the 400-entry report-enrichment tail that the play/error
        // events they actually read compete for. `s.lastSource` covers both
        // element-derived AND integration-reported sources, so a player
        // that has ever announced one keeps reporting even while paused.
        if (!s.lastSource && !s.isPlaying) continue;
        const data: Record<string, unknown> = { bufferAheadMs: bufferAheadMs(el), droppedFrames: 0 };
        const dropped = readDroppedFrames(el);
        if (dropped !== undefined) {
          data.droppedFrames = Math.max(0, dropped - s.lastDroppedFrames);
          s.lastDroppedFrames = dropped;
        }
        let snap: Record<string, unknown> | undefined;
        try {
          snap = s.integration?.snapshot?.() as Record<string, unknown> | undefined;
        } catch {
          snap = undefined; // a broken snapshot() must not drop the rest of the tick's payload
        }
        if (snap) {
          for (const k of ['bitrate', 'width', 'height', 'bandwidthEstimate'] as const) {
            if (Number.isFinite(snap[k] as number)) data[k] = snap[k];
          }
        }
        emit(s, 'stats', data);
      }
    },
    { name: 'vitals.player.sampleQuality' },
  );

  const stop = safeWrap(
    () => {
      observer.disconnect();
      for (const el of Array.from(state.keys())) {
        unbind(el);
      }
    },
    { name: 'vitals.player.stop' },
  );

  // Codex round-3 finding F3 — called by the collector right after an
  // idle/max-age rotation lands a fresh accumulator (VitalsCollectorDeps'
  // `onRotate`). Every attached element's ongoing state predates the new
  // session, so the new accumulator has to be told about it explicitly:
  //   - `player_attach` and the cached source/DRM facts, unconditionally —
  //     the new session has never heard of this player's identity or
  //     source at all, playing or not.
  //   - a still-playing element gets a synthetic `play` (its play span
  //     never closed — it just moved sessions).
  //   - an element mid-rebuffer gets a synthetic `buffer_start`, with its
  //     span's start time RESET to now — the old `bufferStartT` belongs to
  //     the OLD session, which already closed its own (necessarily open)
  //     buffer span in its final snapshot. Reusing that stale timestamp in
  //     the new accumulator would misattribute however long the rebuffer
  //     had already run, under the old session, to the new one.
  const reseed = safeWrap(
    () => {
      const t = now();
      for (const [el, s] of state) {
        emitAttach(s, el, t);
        if (s.lastSource) emit(s, 'source_change', { ...s.lastSource }, t);
        if (s.lastDrm) emit(s, 'drm', { ...s.lastDrm }, t);
        if (s.isPlaying) {
          emit(s, 'play', undefined, t);
        }
        if (s.buffering) {
          s.bufferStartT = t;
          emit(s, 'buffer_start', undefined, t);
        }
      }
    },
    { name: 'vitals.player.reseed' },
  );

  return {
    trackPlayer: (el, opts) => bind(el, opts),
    // `untrackPlayer` is explicit customer intent ("stop watching this
    // player") which outranks auto-attach — mark it BEFORE unbind so a
    // MutationObserver batch that both removes and (via some other
    // mutation) re-adds this exact element within the same microtask still
    // sees it as detached.
    untrackPlayer: (el) => {
      userDetached.add(el);
      unbind(el);
    },
    sampleQuality,
    reseed,
    stop,
  };
}
