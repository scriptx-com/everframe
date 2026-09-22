// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Platform-neutral vitals collector. Buffers VitalsEntry events (samples +
// player events) into size/byte-capped chunks, flushes them on a timer or
// immediately (pagehide/beacon path), and periodically emits SessionSummary
// snapshots computed by the Task 3 accumulator — this module owns buffering,
// batching, and session lifecycle only; it never duplicates metric math.
//
// Session lifecycle: an idle gap longer than `maxIdleMs` between two entries
// finalizes the current session (flush + final summary) and rotates to a
// fresh sessionId/seq/accumulator before recording the triggering entry.
//
// Codex round-1 finding S4 — a session that never goes idle (a visible page
// left open, continuously sampling/playing) never hit the idle-gap split
// above and could run forever: `duration_ms` is carried as a plain number
// through the protocol/DB layer, and a session's wall-clock ms crosses
// int32 range (~24.8 days) well before any realistic "how long has this tab
// been open" ceiling. `maxSessionMs` (default 24h) is a SECOND, independent
// rotation trigger — same finalize-then-rotate sequence as the idle split,
// just gated on session AGE rather than gap size. The controller ruling kept
// the idle split's own semantics untouched: a visible page IS a live
// session, so this does not shorten idle-driven sessions, it only bounds
// ones that never idle at all.
import type {
  SessionSummary,
  SessionSummaryDims,
  VitalsChunk,
  VitalsCustomEntry,
  VitalsEntry,
  VitalsPlayerEvent,
  VitalsSample,
} from '@traceitx/protocol';
import { MAX_PLAYER_EVENT_DATA_BYTES, utf8ByteLength } from '@traceitx/protocol';
import { safeWrap } from '../safe-wrap.js';
import { projectUserMetadata } from '../user-projection.js';
import { boundStructuredJson } from './bound-json.js';
import { createSummaryAccumulator, type SummaryAccumulator } from './summary.js';

/**
 * Client-side CEILINGS for the self-declared `user` block on a summary,
 * matching the lengths the server would keep anyway: `the ingest API/src/reporter/
 * self-declared-identity.ts`'s `SELF_DECLARED_SUBJECT_MAX` (255) for the
 * subject key, `SELF_DECLARED_ATTR_MAX` (320) for the stored attributes.
 * Duplicated rather than imported because the SDK cannot depend on the API,
 * and deliberately NOT put in `@traceitx/protocol`: these are not wire
 * validation and must never become it (see `boundClaimedUser`). A value past
 * one of them is DROPPED, never shortened — see that function for why.
 */
const USER_SUBJECT_MAX = 255;
const USER_ATTR_MAX = 320;

export interface VitalsCollector {
  /** Stable getter — may rotate after an idle-gap session split. */
  readonly sessionId: string;
  recordSample(s: Omit<VitalsSample, 'kind'>): void;
  /** Player-library-controlled event (spec 2026-09-02 §1) — `data` is
   * free-form and library-supplied (bitrate_change, error, stats, …), so it
   * is bounded with `boundStructuredJson` here, the one place every
   * platform's call funnels through (Codex round-4 finding 1 — player
   * payloads were the one unbounded path left; an integration emitting a
   * multi-MB `error.message` could otherwise ride the recent ring into an
   * unrelated bug report). Codex round-5 item 3 — bounded at
   * `MAX_PLAYER_EVENT_DATA_BYTES`, its OWN larger budget, not
   * `recordCustom`'s `MAX_CUSTOM_DATA_BYTES`, and structure-preserving (long
   * string fields shrink; every scalar field — `code`, `fatal`, … —
   * survives) rather than collapsed to an opaque preview; see
   * `boundPlayerEventData`'s own doc-comment below. */
  recordPlayerEvent(e: Omit<VitalsPlayerEvent, 'kind'>): void;
  /** Customer-facing structured log line (spec 2026-09-02 §2) — bounded by
   * boundJson at the call site, not here; the collector just buffers it. */
  recordCustom(e: Omit<VitalsCustomEntry, 'kind'>): void;
  /** Entries from the last `windowMs` (default 60s) — report enrichment. */
  recent(windowMs?: number): VitalsEntry[];
  /** Immediate flush — pagehide path. */
  flushNow(opts?: { beacon?: boolean }): void;
  /** Final flush + final summary + clear timer. Idempotent. */
  stop(): void;
}

/**
 * ONE READ of the host's identity, covering everything a single summary needs
 * to say about who was watching.
 *
 * IT IS A SNAPSHOT, AND THAT IS THE WHOLE POINT (round-4 finding 5,
 * reproduced with no asynchronous interleaving at all). The `token` and the
 * `user` block used to be fetched by two different callers — the collector
 * read the provider for `user`, the transport read it again for `token` — and
 * two reads of a live provider can disagree: build the summary while the
 * cached token has 30,001 ms of life, let the clock advance 1 ms, and the
 * second read returns nothing because the cache has entered
 * `IDENTITY_REFRESH_MARGIN_MS`. The summary then went out carrying
 * `user: {id:'alice'}` and NO credential — an unverified person minted where a
 * verified one was intended, which is the downgrade the design spec's
 * invariant 1 forbids, and the beacon path and the retry carried it too.
 *
 * So `sendSummary` reads the provider exactly once and both halves travel
 * together from there: the `user` block onto the body, the `token` through
 * `send`'s `opts.identityToken`. There is no second read to disagree with the
 * first.
 */
export interface VitalsIdentitySnapshot {
  /**
   * The verified credential to present with this summary. Never part of the
   * summary BODY — the transport puts it in a header (fetch) or the request
   * envelope (beacon).
   */
  token?: string;
  /**
   * True while the VERIFIED tier is configured but has nothing to present —
   * an identity token source is set and enabled, and no usable token is
   * cached right now (web: `IdentityTokenHolder.hasUnresolvedSource(now)`,
   * reached through the adapter's identity gate). False whenever the verified
   * tier is not in play at all: no source configured, or identity disabled
   * for the project.
   *
   * The collector uses it to WITHHOLD the self-declared `user` block while
   * that holds; see `claimedUser`, and `hasUnresolvedSource` for why the
   * predicate is deliberately stateless and what that costs.
   */
  tokenPending?: boolean;
  /** The host's self-declared `setUser` label — a claim, never a credential. */
  user?: { id?: string; email?: string; displayName?: string };
}

export interface VitalsCollectorDeps {
  dims: SessionSummaryDims;
  now(): number;
  /**
   * Deliver one payload.
   *
   * `opts.identityToken` is the VERIFIED credential to present with THIS
   * payload — set only for summaries, and only ever from the same single read
   * of `identity()` that produced the summary's `user` block. See
   * `sendSummary` for why it travels with the body instead of being fetched
   * again by the transport.
   */
  send(
    body: VitalsChunk | SessionSummary,
    opts: { beacon: boolean; identityToken?: string },
  ): void;
  /** Injected uuid source — used for the initial session and idle rotations. */
  newSessionId(): string;
  flushIntervalMs?: number;
  maxEntriesPerChunk?: number;
  maxBufferBytes?: number;
  summaryEveryChunks?: number;
  maxIdleMs?: number;
  /** Force-rotate a session once it has run this long, regardless of idle
   *  gaps (Codex round-1 finding S4). Default 24h. */
  maxSessionMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  /**
   * Codex round-3 finding F3 — invoked once a rotation (idle-gap or
   * max-age) has finished landing the NEW session/accumulator, so a caller
   * (sdk-web's player adapter) can re-seed ongoing per-element state
   * (currently-playing, currently-buffering) into the fresh accumulator,
   * which otherwise has no way to know playback didn't actually stop just
   * because the session id did. Called AFTER the triggering entry has been
   * recorded (so `recent()`/the new session already reflect it), wrapped so
   * a throwing callback can never break the collector itself.
   */
  onRotate?: () => void;
  /**
   * Codex round-3 item 8 — the UTF-8 byte length of the apiKey the platform
   * transport will embed in ITS OWN wrapper around a chunk, when it knows
   * one (sdk-web's beacon path sends `{"apiKey":"<key>","payload":<chunk>}`
   * on pagehide — see transport.ts). This platform-neutral module still
   * doesn't need to know the wrapper's exact shape, only how many bytes the
   * key itself costs, so `requestWrapperReserveBytes` below can size the
   * reserve correctly instead of guessing. Omitted (every platform/test that
   * doesn't pass it) falls back to `DEFAULT_API_KEY_RESERVE_BYTES`, a bound
   * generous enough to cover the documented 41-char SDK key format with
   * plenty of room to spare.
   */
  apiKeyByteLength?: number;
  /**
   * Task 11 (spec 2026-09-10 — playback session identity). "Who is signed in
   * RIGHT NOW", read once per summary. Until this is wired, every playback
   * session stays anonymous in practice regardless of what the server can
   * resolve, because a deployed SDK sends no identity at all.
   *
   * SYNCHRONOUS by controller ruling R7, not async: `sendSummary` below is
   * synchronous and also fires from `stop()` on the unload path, where
   * awaiting anything is impossible. The web wiring therefore builds this on
   * the adapter's CACHE-ONLY token accessor (`__peekIdentityToken`), never on
   * the async `identityTokenReader.get()` that invokes the host's provider.
   *
   * `token` is a verified credential the transport presents as a header /
   * beacon body field (it is not part of the summary body and is never read
   * here); `user` is the host's self-declared `setUser` label, stamped onto
   * the summary itself. Returning `null` — or not wiring a provider at all —
   * means "nothing to say", and `user` is then omitted from the wire entirely.
   */
  identity?: () => VitalsIdentitySnapshot | null;
  /**
   * Fire-and-forget request to REFRESH whatever `identity()` reads from —
   * the counterpart that makes the cache-only read above able to return
   * anything at all.
   *
   * WHY THIS EXISTS (adversarial review of PR #218, finding 1 — the verified
   * tier was dead on a fresh install). `identity()` is cache-only by ruling
   * R7, and on web that cache (`IdentityTokenHolder`, sdk-core's
   * `reporter/identity-token.ts`) is populated ONLY by `get()`, which
   * `setIdentityToken()` does not call — `set()` in fact DROPS the cache. So
   * on a fresh browser where the host sets a valid token and the viewer only
   * WATCHES, never filing a report, nothing ever called `get()`: `peek()`
   * returned null forever and every summary was anonymous. That is precisely
   * the viewer this feature exists to recognize.
   *
   * Called on the flush cadence (`tick`) and once at construction, NEVER from
   * `flushNow`/`stop` — the unload path must stay synchronous and must not
   * kick off work the page is about to discard. It returns nothing and is
   * wrapped like every other host-adjacent callback here: it must never
   * throw, never reject unhandled, and never block or delay a flush. A warm
   * that has not landed yet simply means this summary carries no token and a
   * later one does — the same gradual-adoption story as before, except the
   * cache now actually fills.
   */
  warmIdentity?: () => void;
}

const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_MAX_ENTRIES_PER_CHUNK = 50;
const DEFAULT_MAX_BUFFER_BYTES = 65_536;
const DEFAULT_SUMMARY_EVERY_CHUNKS = 5;
const DEFAULT_MAX_IDLE_MS = 1_800_000;
const DEFAULT_RECENT_WINDOW_MS = 60_000;
// 24h. Well below int32 ms range (~24.8 days) so a bounded session's
// duration_ms can never overflow it (Codex round-1 finding S4).
const DEFAULT_MAX_SESSION_MS = 86_400_000;
// Codex round-2 finding R7 — hard cap on the `recent()` ring, independent of
// its time-window pruning. `pruneRing` only trims entries OLDER than the
// window; an event storm inside one second (a runaway loop emitting samples,
// a buggy caller) can push arbitrarily many entries into the ring before the
// next prune ever looks at them, growing it unboundedly for that window's
// duration. 800 is 2x the envelope's own cap
// (`MAX_ENVELOPE_VITALS_ENTRIES` = 400, protocol/src/vitals.ts) — comfortably
// more than any single `.slice(-400)` read ever needs, so the slice always
// has fresh material even right after a storm.
const MAX_RING_ENTRIES = 800;

/**
 * Codex round-4 finding 1 (bounding at all) + round-5 item 3 (bounding
 * correctly) — bounds a player event's free-form `data`, the one place
 * every platform's player adapter funnels through, so the guarantee holds
 * even for a platform whose adapter only shallow-copies its payload
 * (sdk-web's `player-adapter.ts` does exactly that).
 *
 * Round 4 reused `recordCustom`'s `MAX_CUSTOM_DATA_BYTES` cap and `boundJson`
 * — wrong on both counts. That cap belongs to the CUSTOM entry (spec
 * 2026-09-02 §2's `trackVitals` free-form log line), and it was too small
 * for a legitimate structured player error (a 3 KB `{ message, code, fatal,
 * detail }` fits the ordinary transport budget comfortably). `boundJson`
 * collapsing the WHOLE object to `{ truncated, preview }` on overflow lost
 * `code`/`fatal` along with the message — an operator needs to know a
 * decode error was FATAL even when the message itself got cut.
 *
 * `boundStructuredJson` at player events' own, larger
 * `MAX_PLAYER_EVENT_DATA_BYTES` budget fixes both: every scalar field
 * survives regardless of size, only the free-text string fields shrink, and
 * it still covers the cyclic/unserializable case (falls back to rebuilding
 * field-by-field, same as the plain-oversized case) — closing both the
 * transport-eviction and the report-corruption paths described at
 * `addEntry`'s oversized-entry comment below, without destroying a payload
 * that easily fits the ordinary budget.
 */
function boundPlayerEventData(
  data: Record<string, unknown> | undefined
): { data?: Record<string, unknown>; truncated?: boolean } {
  const bounded = boundStructuredJson(data, MAX_PLAYER_EVENT_DATA_BYTES);
  return {
    ...(bounded.data !== undefined ? { data: bounded.data } : {}),
    ...(bounded.truncated ? { truncated: true } : {}),
  };
}

/**
 * Codex round-2 item 3 — the real wire cost of a chunk is NOT the sum of its
 * entries' own serialised sizes: a JSON array pays one comma per separator
 * (`entries.length - 1` bytes a per-entry sum never counts), and the chunk
 * itself is wrapped in its own envelope (`{"kind":"chunk","sessionId":"...",
 * "seq":123,"entries":[...]}"`) — the `kind`/`sessionId`/`seq` keys and
 * values, and the object/array punctuation, all cost real bytes too.
 * Reproduced upstream: 32 entries individually summing to 65,408 bytes
 * produced a 65,539-byte FINAL request body — over the browser's
 * ~65,536-byte `fetch(..., { keepalive: true })` body limit, which fails
 * both the send and its one retry and loses the whole chunk.
 *
 * Must measure UTF-8 BYTES throughout (Codex round-1 item 4), the unit the
 * transport (and that keepalive body budget) actually counts, not UTF-16
 * code units — multibyte content (emoji, non-Latin scripts) can serialise to
 * roughly 2-4x its `.length` in bytes, so a cap measured in code units can
 * silently exceed the real wire budget.
 *
 * `chunkCost` measures the actual framed chunk object (envelope + commas
 * included) in one `JSON.stringify`, rather than summing parts, so nothing
 * about the array/object framing can be missed. It still can't see the ONE
 * further wrapping layer the transport itself adds on top of this object
 * (sdk-web's `transport.ts` sends `{"payload": <this chunk>}`, exactly 12
 * bytes of its own framing) — `REQUEST_WRAPPER_RESERVE_BYTES` below reserves
 * fixed headroom for that instead, so this platform-neutral module never has
 * to know the wrapper's exact shape, only a safe upper bound on its cost.
 */
function chunkCost(sessionId: string, seq: number, entries: VitalsEntry[]): number {
  try {
    return utf8ByteLength(JSON.stringify({ kind: 'chunk', sessionId, seq, entries }));
  } catch {
    return Number.POSITIVE_INFINITY; // unserialisable — treat as over-cap so eviction still makes progress
  }
}

// Codex round-2 item 3 — fixed headroom reserved out of `maxBufferBytes` for
// the transport's OWN request-level wrapper around the chunk object
// (`{"payload": <chunk>}` on the web transport costs exactly 12 bytes:
// `{"payload":` + `}`). Rounded up generously so a structurally similar
// wrapper on another platform transport (or a future field added to this
// one) stays covered without this file needing to know its exact shape.
const FETCH_WRAPPER_RESERVE_BYTES = 32;

// Codex round-3 item 8 — round-2's fixed 32-byte reserve covered the FETCH
// wrapper (`{"payload":<chunk>}`, 12 bytes) but not the BEACON wrapper,
// which additionally embeds the apiKey: `{"apiKey":"<key>","payload":<chunk>}`
// (sdk-web's transport.ts — sendBeacon can't set headers, so the key rides
// in the body). That fixed punctuation/keys cost is 24 bytes
// (`{"apiKey":"` + `","payload":` + the closing `}`) — 11 + 12 + 1 — on top
// of the key's own byte length. With the documented 41-char SDK key format,
// the beacon wrapper alone costs 24 + 41 = 65 bytes, more than double the
// old 32-byte reserve: an admitted 65,504-byte chunk (65,536 - 32) became a
// 65,569-byte beacon body — over the browser's 64 KiB limit — and pagehide's
// beacon send was refused, falling back to the less reliable unload-fetch
// path.
const BEACON_WRAPPER_FIXED_BYTES = 24;
// Fallback when the caller doesn't know (or doesn't pass) the real apiKey
// length — every platform/test constructed without `apiKeyByteLength`. Well
// above the documented 41-char key format, so a caller that DOES supply the
// real length gets an exact reserve, and one that doesn't still gets a
// bound that provably covers today's key format with room for a
// considerably longer one.
const DEFAULT_API_KEY_RESERVE_BYTES = 128;

/**
 * What `safeWrap` is allowed to LOG when a host identity callback throws
 * (adversarial review of PR #218 round 6, finding 2 — reproduced: a callback
 * throwing `Error('identity refresh failed for Bearer ' + jwt)` put the
 * complete live credential into `console.error`, from where a console-capture
 * integration exports it).
 *
 * The error NAME only — a message can carry the very token the callback was
 * fetching. Same projection, same reason, as
 * `types/replay/config-provider.ts`'s refresh failure, which logs
 * `err.name` because its message can carry the URL and with it the key.
 *
 * Identity call sites ONLY: every other `safeWrap` caller keeps the full
 * error, because no other wrapped callback here is holding a credential.
 *
 * Fix round (7 codex rounds in — the only remaining finding) — `err.name` is
 * a GETTER, and a host callback controls the `Error` it throws, so it can
 * make that getter throw too. Unguarded, that exception used to escape this
 * projection: during `stop()` it aborted the final summary outright (no
 * second attempt — teardown), and `safeWrap` then logged the GETTER's own
 * error unredacted, reopening the exact credential-disclosure hole this
 * projection exists to close. Every read that can run host-authored code —
 * the `instanceof` check included, since a subclassed `Symbol.hasInstance`
 * is just as host-controlled as the getter — is inside the guard, and any
 * failure yields this constant, credential-free string instead of
 * propagating.
 */
const identityErrorLabel = (err: unknown): string => {
  try {
    return err instanceof Error ? err.name : typeof err;
  } catch {
    return 'unreadable identity error';
  }
};

export function createVitalsCollector(deps: VitalsCollectorDeps): VitalsCollector {
  const {
    dims,
    now,
    send,
    newSessionId,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    maxEntriesPerChunk = DEFAULT_MAX_ENTRIES_PER_CHUNK,
    maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
    summaryEveryChunks = DEFAULT_SUMMARY_EVERY_CHUNKS,
    maxIdleMs = DEFAULT_MAX_IDLE_MS,
    maxSessionMs = DEFAULT_MAX_SESSION_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    apiKeyByteLength = DEFAULT_API_KEY_RESERVE_BYTES,
  } = deps;

  // Codex round-3 item 8 — the effective reserve is whichever wrapper costs
  // MORE: the plain fetch wrapper's fixed 32 bytes, or the beacon wrapper's
  // fixed 24 bytes PLUS the actual (or fallback) apiKey length. A single
  // chunk can be sent via EITHER path (a beacon send that's refused falls
  // back to fetch — see transport.ts), so the cap must protect whichever one
  // a given send ends up taking, not just whichever happens to be smaller.
  const requestWrapperReserveBytes = Math.max(
    FETCH_WRAPPER_RESERVE_BYTES,
    BEACON_WRAPPER_FIXED_BYTES + apiKeyByteLength,
  );

  // Codex round-3 finding F3 — wrapped once, up front, exactly like `tick`
  // below: a throwing `onRotate` must be logged (safeWrap's own behavior)
  // and swallowed, never propagate out of `addEntry` and break recording of
  // the entry that triggered the rotation (or any entry after it).
  const onRotate = deps.onRotate
    ? safeWrap(deps.onRotate, { name: 'VitalsCollector.onRotate' })
    : undefined;

  // Wrapped once, up front, exactly like `onRotate` above and `tick` below:
  // the identity provider is host-adjacent code, and identity is an
  // ENRICHMENT of the summary — a throwing provider must cost the session its
  // attribution, never its metrics.
  const readIdentity = deps.identity
    ? safeWrap(deps.identity, {
        name: 'VitalsCollector.identity',
        projectError: identityErrorLabel,
      })
    : undefined;

  // Same treatment, same reason — see `warmIdentity`'s doc-comment. A
  // throwing warm costs its own call and nothing else.
  const warmIdentity = deps.warmIdentity
    ? safeWrap(deps.warmIdentity, {
        name: 'VitalsCollector.warmIdentity',
        projectError: identityErrorLabel,
      })
    : undefined;

  /**
   * The self-declared user block to stamp on the summary about to go out, or
   * `undefined` when there is nothing to say.
   *
   * Takes the snapshot `sendSummary` already read rather than reading the
   * provider itself — there is exactly one read per summary, and the
   * credential travelling beside this block came out of the same one (see
   * `VitalsIdentitySnapshot`).
   *
   * An EMPTY object is "nothing to say" too: `setUser({})` is legal, and
   * `projectUserMetadata` keeps only string-valued `id`/`email`/`displayName`,
   * so a host object with none of them projects to `{}`. An empty object on
   * the wire is not the same as an absent key — the ingest route treats a
   * present `user` block as a self-declared claim.
   *
   * Fix round (review, Minor) — `deps.identity` is typed
   * `{ id?: string; email?: string; displayName?: string }`, but that type
   * only binds a TypeScript caller. `createVitalsCollector` is also a
   * supported entry point for an untyped JS host calling it (or
   * `setupVitals`) directly with no compiler to stop it, and this collector
   * used to check only that a field was DEFINED, not that it was a STRING —
   * `{ user: { id: 123 } }` forwarded straight onto the wire. The ingest
   * route's zod schema rejects a non-string `id`, and that failure takes down
   * the WHOLE summary — every metric in it, not just the bad field — which is
   * precisely the outcome `packages/protocol/src/vitals.ts` documents these
   * fields being left UNBOUNDED (rather than validated) on the wire to avoid.
   * `projectUserMetadata` (this package's own host-boundary sanitizer,
   * already used by `client.setUser()` and sdk-react's submit-boundary
   * snapshot) keeps only string-valued `id`/`email`/`displayName` and drops
   * everything else — extra keys, non-string values, a non-object `user`
   * entirely — without ever throwing, so it doubles as the fix here.
   */
  function claimedUser(
    identity: VitalsIdentitySnapshot | null | undefined,
  ): { id?: string; email?: string; displayName?: string } | undefined {
    // COLD-START TWIN GUARD (adversarial review of PR #218 round 2, finding 3
    // — reproduced with a correctly signed token and no report filed: TWO
    // identity rows for one fresh session).
    //
    // `identity()` is cache-only and synchronous (ruling R7), and `warmIdentity`
    // below fires the asynchronous fill. The very first summary goes out in the
    // same synchronous turn as that warm, so it CANNOT carry a token. With
    // `setUser` also set it used to carry the self-declared block instead — and
    // the server, seeing a `user` and no token, minted an UNVERIFIED person.
    // Thirty seconds later the warm had landed, the next summary carried the
    // token, and the VERIFIED person was minted alongside it. Two rows, one
    // viewer, permanently.
    //
    // So while a token is still coming, say nothing. One anonymous interval is
    // the correct trade and the one the design spec makes everywhere else:
    // transient anonymity over a persistent twin — an attribution arriving a
    // summary late is invisible, a duplicate person in the directory is not.
    // The block still goes out whenever the verified tier is not in play at
    // all — no identity token source configured, or identity disabled for the
    // project — which is the whole self-declared-only population; they are
    // unaffected. A host that wires a token source AND wants the self-declared
    // tier for signed-out viewers calls `setIdentityToken(null)` for them; see
    // `IdentityTokenHolder.hasUnresolvedSource`.
    if (identity?.tokenPending === true && identity.token === undefined) return undefined;
    const user = identity?.user;
    if (!user) return undefined;
    const projected = projectUserMetadata(user);
    if (!projected) return undefined;
    const bounded = boundClaimedUser(projected);
    return Object.keys(bounded).length > 0 ? bounded : undefined;
  }

  /**
   * DROPS any of the three attributes that exceeds
   * `USER_SUBJECT_MAX`/`USER_ATTR_MAX`. Never truncates one.
   *
   * A BOUND, not wire validation — and the distinction is the whole point.
   * `packages/protocol/src/vitals.ts` deliberately leaves these fields
   * unbounded (and, since the PR #218 review, type-tolerant) because a schema
   * rejection would 400 the request and lose the summary's dims and metrics
   * over an identity attribute. The same reasoning applies one layer earlier,
   * here: an over-long attribute must not be allowed to cost the summary its
   * DELIVERY either. It was doing exactly that (PR #218 review round 1,
   * finding 6 — measured): `projectUserMetadata` filters types and keys but
   * not LENGTH, so `setUser({ id: 'alice', displayName: 'x'.repeat(70000) })`
   * produced a 70,553-byte beacon body and a 70,421-byte `keepalive` fetch
   * fallback, both past `sendBeacon`'s 64 KiB ceiling, so the summary could
   * not be delivered at all.
   *
   * DROPPED, not truncated — round 1 truncated, and that was worse than the
   * bug it fixed (round-2 finding 4, reproduced: two sessions with distinct
   * input ids referencing ONE person). `user.id` is the identity KEY the
   * server derives `subject_key` from, so shortening it does not degrade a
   * claim, it REWRITES it: `'x'.repeat(255) + 'a'` and `'x'.repeat(255) + 'b'`
   * truncate to the same 255 characters and two different people merge into
   * one. An identifier must never be edited — either it is the one the host
   * gave us or we do not have it.
   *
   * Dropping is also exactly what the server does with the same value:
   * `readString` in `the server self-declared identity contract` returns
   * null past its maximum. A dropped `id` lets the email key apply, or leaves
   * the block unkeyable and the session anonymous — the identical outcome to
   * sending it and letting the server discard it, minus the bytes. So the
   * delivery problem stays solved: a dropped value adds none.
   */
  function boundClaimedUser(u: {
    id?: string;
    email?: string;
    displayName?: string;
  }): { id?: string; email?: string; displayName?: string } {
    const out: { id?: string; email?: string; displayName?: string } = {};
    if (u.id !== undefined && u.id.length <= USER_SUBJECT_MAX) out.id = u.id;
    if (u.email !== undefined && u.email.length <= USER_ATTR_MAX) out.email = u.email;
    if (u.displayName !== undefined && u.displayName.length <= USER_ATTR_MAX) {
      out.displayName = u.displayName;
    }
    return out;
  }

  let sessionId = newSessionId();
  let seq = 0;
  // Codex round-6 item 3 — a SEPARATE monotonic counter from the chunk `seq`
  // above: this stamps `SessionSummary.seq` (protocol/src/vitals.ts), which
  // the ingest route uses to break a duration tie between two summaries
  // (duration alone is millisecond-rounded and carries no ordering
  // information at a tie — three prior ingest-side fixes tried anyway and
  // each shipped a new hole). Incremented once per `sendSummary` call, reset
  // alongside the chunk `seq` on session rotation (a new sessionId is a new,
  // independent DB row — vitals-route.ts upserts on (appId, sessionId) — so
  // there is no cross-session ordering to preserve).
  let summarySeq = 0;
  let stopped = false;
  let chunksSinceSummary = 0;
  /**
   * Entries of ANY kind recorded since the last summary went out — including
   * samples, which are not transported but do move `memPeak`/`memAvg`. Gates
   * `bumpSummaryCadence` so an idle collector stays silent.
   */
  let entriesSinceSummary = 0;
  let lastEntryAt: number | null = null;
  let sessionStartedAt = now();

  // Chunk buffer — cleared on every flush.
  let pending: VitalsEntry[] = [];

  // Separate rolling window for recent() — independent of chunk flushing.
  const ring: VitalsEntry[] = [];

  let accumulator: SummaryAccumulator = createSummaryAccumulator({
    sessionId,
    startedAt: sessionStartedAt,
    dims,
  });

  // Codex round-2 finding R6 — `at` defaults to `now()` (the ordinary,
  // non-rotation call sites: the initial summary, periodic chunk-driven
  // summaries, `flushNow()`, and `stop()`'s own finalization, none of which
  // is attributing a gap to the wrong session), but a rotation's finalize
  // call passes an explicit boundary instead — see `finalizeSession`.
  function sendSummary(final: boolean, beacon: boolean, at: number = now()): void {
    const summary = accumulator.snapshot({ final, now: at });
    // Codex round-6 item 3 — stamped here, not in `summary.ts`'s own
    // `snapshot()`: the accumulator has no notion of "which send attempt is
    // this," only the collector does.
    // Task 11 — read PER SUMMARY, not once at construction: a session that
    // starts anonymous and then signs in must become attributed, and the
    // collector has no other moment to notice.
    //
    // AND READ EXACTLY ONCE FOR THIS SUMMARY (round-4 finding 5). Both halves
    // of the answer come out of this single call and travel together from
    // here: the self-declared `user` onto the body (omitted entirely, not sent
    // as an empty object, when there is nothing to say — see `claimedUser`),
    // the verified `token` through `send`'s `opts.identityToken`. Nothing
    // downstream re-reads the provider, so the credential and the claim can no
    // longer describe two different moments — see `VitalsIdentitySnapshot`.
    const identity = readIdentity?.();
    const token = typeof identity?.token === 'string' ? identity.token : undefined;
    // Adversarial review of PR #218 round 6, finding 1 — reproduced through
    // the real collector and transport. A `token` property that is PRESENT but
    // not a usable string (`null`, a number, an object, an array — an untyped
    // JS host, the same population `claimedUser` already sanitizes for) is a
    // credential that was SUPPLIED AND FAILED, not an absent one. Coercing it
    // to `undefined` while keeping `user` told the transport "no token was
    // offered", so the summary went out claiming a person with no credential
    // beside it and ingest minted an ordinary UNVERIFIED person — the exact
    // downgrade invariant 1 forbids.
    //
    // The rule already exists one layer down for a rejected STRING token
    // (sdk-web's `transport.ts` `bodyFor`): whichever layer rejects the
    // credential, the claim goes with it. These shapes never reach that layer
    // AS a token at all, so the same rule has to be applied here.
    //
    // `token: undefined` counts as ABSENT, deliberately. It is what ordinary
    // optional-field wiring produces (`{ token: cached ?? undefined }`), and
    // distinguishing it from an omitted key would make that wiring silently
    // lose the self-declared tier. Only a genuinely absent token — the
    // property missing or explicitly `undefined`, or no identity result at
    // all — keeps the claim.
    const tokenRejected = identity?.token !== undefined && token === undefined;
    const claimed = tokenRejected ? undefined : claimedUser(identity);
    send(
      claimed ? { ...summary, seq: summarySeq, user: claimed } : { ...summary, seq: summarySeq },
      token !== undefined ? { beacon, identityToken: token } : { beacon }
    );
    summarySeq++;
    // Reset AFTER the send, matching this file's send-then-advance
    // discipline: a throwing transport must leave the collector believing it
    // still owes a summary, or the throw silently discards the fact that
    // anything was accumulated and the next periodic summary never fires.
    entriesSinceSummary = 0;
  }

  /** Sends the current pending buffer as a chunk, if non-empty. */
  function sendChunk(beacon: boolean): void {
    if (pending.length === 0) return;
    const chunk: VitalsChunk = { kind: 'chunk', sessionId, seq, entries: pending };
    send(chunk, { beacon });
    seq++;
    pending = [];
    bumpSummaryCadence();
  }

  /**
   * Advances the periodic non-final summary cadence by one interval.
   *
   * Called from `sendChunk` AND from the flush tick when there was nothing to
   * send. Both matter: the cadence used to live inside `sendChunk` alone, and
   * `sendChunk` returns early on an empty buffer — so once samples stopped
   * being transported, a session with no playback activity produced no chunks
   * and therefore no periodic summaries at all. That silently broke two
   * things. `memPeak`/`memAvg` only reached the server if the session ended
   * cleanly, so an app killed by the OS lost them entirely; and the server's
   * `lastSeenAt` stopped advancing while the session was still live, which is
   * what drives stale-session detection and retention. Keyed off the flush
   * interval, the cadence is now the same wall-clock period it always was
   * (`summaryEveryChunks` × `flushIntervalMs`) whether or not entries flow.
   */
  function bumpSummaryCadence(): void {
    // Nothing has been recorded since the last summary, so there is nothing
    // new to report: a collector sitting on a genuinely dead session must stay
    // silent rather than heartbeat forever. Samples count as accumulation even
    // though they are not transported — reporting their memPeak/memAvg is the
    // whole reason this path exists.
    if (entriesSinceSummary === 0) return;
    chunksSinceSummary++;
    if (chunksSinceSummary >= summaryEveryChunks) {
      chunksSinceSummary = 0;
      sendSummary(false, false);
    }
  }

  /**
   * Finalizes the current session (flush + final summary).
   *
   * Codex round-2 finding R6 — `at` is the moment the session's own final
   * summary should be snapshotted AS OF, which is NOT always "right now":
   *   - `stop()` (kill/destroy) — the session is ending right now, so the
   *     default (`now()`) is correct and callers pass nothing.
   *   - idle-gap rotation — the OLD session actually stopped living at its
   *     last recorded entry, potentially hours before this rotation is being
   *     processed (the triggering entry is what revealed the gap). Snapshotting
   *     with the current `now()` would attribute the whole idle gap — plus
   *     any still-open play/buffer span — to the old session's durationMs
   *     and open-span math. The caller passes `lastEntryAt` for this case.
   *   - max-age rotation — the session is being cut off at its own age
   *     ceiling, not at whatever moment happened to trigger the check. The
   *     caller passes `sessionStartedAt + maxSessionMs` so `durationMs`
   *     comes out to exactly `maxSessionMs`, not `maxSessionMs` plus however
   *     long it took the next entry to arrive.
   */
  function finalizeSession(at: number = now()): void {
    sendChunk(false);
    sendSummary(true, false, at);
  }

  /** Rotates to a brand-new session and announces it with an initial summary. */
  function startNewSession(startedAt: number): void {
    sessionId = newSessionId();
    seq = 0;
    summarySeq = 0;
    chunksSinceSummary = 0;
    sessionStartedAt = startedAt;
    accumulator = createSummaryAccumulator({ sessionId, startedAt, dims });
    // Fix I2 (final review): `recent()` reads this ring, and a report built
    // just after an idle-rotation must never carry the PREVIOUS session's
    // entries under the NEW sessionId — clear it here, in the same place
    // sessionId itself rotates, rather than leaving it to drain via
    // `pruneRing`'s time-window (which could still return stale entries for
    // up to `DEFAULT_RECENT_WINDOW_MS` after rotation).
    ring.length = 0;
    sendSummary(false, false);
  }

  function addEntry(entry: VitalsEntry): void {
    const nowT = now();
    const idleGapExceeded = lastEntryAt !== null && nowT - lastEntryAt > maxIdleMs;
    // Codex round-1 finding S4 — force-rotate a session that has simply run
    // too long, independent of the idle-gap check above (a continuously
    // visible/active page never trips that one at all). `>=`, not `>`: a
    // session landing exactly on the boundary should not get one more entry
    // under the old id.
    const maxAgeExceeded = nowT - sessionStartedAt >= maxSessionMs;
    // Codex round-2 finding R6 — each rotation trigger finalizes the OLD
    // session as of the moment that is actually true for it, not as of
    // `nowT` (the triggering entry's own arrival time) in both cases. See
    // `finalizeSession`'s doc-comment for the reasoning behind each branch.
    // Idle takes priority when (degenerately) both are true at once — an
    // idle gap is a stronger, more specific signal about when the old
    // session actually ended than the age ceiling is.
    // Codex round-3 finding F3 — tracked so `onRotate` can be invoked AFTER
    // the triggering entry below is fully recorded (pending/ring/accumulator),
    // not right here at the moment the new session is created.
    let rotated = false;
    if (idleGapExceeded) {
      // `lastEntryAt` is non-null here — `idleGapExceeded` can only be true
      // when the `lastEntryAt !== null` check above it already passed.
      finalizeSession(lastEntryAt as number);
      startNewSession(nowT);
      rotated = true;
    } else if (maxAgeExceeded) {
      finalizeSession(sessionStartedAt + maxSessionMs);
      startNewSession(nowT);
      rotated = true;
    }
    lastEntryAt = nowT;

    // CPU/memory samples feed the accumulator (so `memPeak`/`memAvg` still
    // land on the summary) and count as activity above (so session rotation
    // and `lastEntryAt` are unchanged) — but they are never transported.
    // Resource consumption is covered by the report resource window
    // (packages/protocol/src/resources.ts): a 2-second-resolution ring
    // attached to the report or crash that explains it, which is both finer
    // than this 30-second stream and actually aligned to the failure. The
    // stream cost nearly everything and explained little — measured
    // server-side, 79% of stored chunks came from sessions where no video
    // ever played, and one 10-hour session produced 1,154 objects holding
    // nothing but samples.
    //
    // Skipped here rather than in `recordSample` deliberately: routing
    // samples around `addEntry` entirely would also skip the rotation and
    // `lastEntryAt` bookkeeping above, silently shortening the lifetime of a
    // session whose only activity is sampling.
    const transported = entry.kind !== 'sample';
    if (transported) {
      pending.push(entry);
      // Codex round-2 item 3 — measure the actual framed chunk (envelope +
      // separators) against the cap, not a sum of per-entry costs that never
      // counted either; see `chunkCost`'s own comment. The reserve carves out
      // headroom for the transport's one further wrapping layer, which this
      // platform-neutral module never serialises itself.
      while (
        pending.length > 0 &&
        chunkCost(sessionId, seq, pending) > maxBufferBytes - requestWrapperReserveBytes
      ) {
        pending.shift();
      }
      // Codex round-4 finding 1 — `pending` just lost every entry, INCLUDING
      // `entry` itself (the one this call just pushed as the array's last
      // element), only when `entry` alone still can't fit the chunk budget
      // even with no other entry competing for it: the while loop above only
      // stops early once the remaining cost fits, so an empty `pending` here
      // is possible ONLY when the last-remaining, just-added entry was still
      // over budget on its own. That is the transport definitively refusing
      // this specific entry, not routine chunk-budget housekeeping — and
      // retaining a transport-refused entry anywhere else (the recent ring
      // below, later stamped verbatim into a bug/crash report) is exactly
      // what let an oversized entry survive vitals eviction only to break an
      // unrelated report. `boundPlayerEventData` above should make this
      // unreachable for player events in practice, but this guard is the
      // actual invariant — it holds regardless of which entry kind, or a
      // future one, manages to be oversized.
      const transportRefusedEntry = pending.length === 0;

      if (!transportRefusedEntry) {
        // The ring is stamped verbatim into a bug/crash report, so an entry
        // that is not transported must not enter it either — a sample riding
        // into a report is exactly what the resource window replaces.
        ring.push(entry);
        // Codex round-2 finding R7 — hard cap independent of the time-window
        // prune below: drop the OLDEST entries first so the newest survive an
        // event storm.
        while (ring.length > MAX_RING_ENTRIES) ring.shift();
      }
    }
    pruneRing(nowT - DEFAULT_RECENT_WINDOW_MS);
    accumulator.onEntry(entry);
    // Marked beside the accumulator call that gives it meaning, not earlier.
    // sdk-core evicts rather than flushing mid-`addEntry` (unlike the native
    // collectors' FLUSH BEFORE ADMIT), so it cannot emit a summary before the
    // entry is applied — but keeping one rule across all three is worth the
    // two lines.
    entriesSinceSummary += 1;

    if (transported && pending.length >= maxEntriesPerChunk) {
      sendChunk(false);
    }

    // Codex round-3 finding F3 — fire AFTER the triggering entry above is
    // fully recorded into the NEW session (accumulator.onEntry already ran
    // against the fresh accumulator startNewSession created). `onRotate`
    // itself is pre-wrapped with safeWrap, so a throwing callback logs and
    // returns undefined rather than escaping addEntry.
    if (rotated) {
      onRotate?.();
    }
  }

  function pruneRing(cutoff: number): void {
    while (ring.length > 0 && (ring[0]?.t ?? cutoff) < cutoff) ring.shift();
  }

  // Wrapped like the public methods: a throwing send() during a periodic
  // flush must not become an unhandled exception inside the timer, and must
  // not prevent later ticks from running.
  const tick = safeWrap(
    (): void => {
      if (stopped) return;
      // FIRST, and outside every branch below: the whole point is that the
      // cache `identity()` reads is warm by the time the NEXT summary is
      // built, and a tick that has a chunk to send returns early.
      warmIdentity?.();
      if (pending.length > 0) {
        sendChunk(false);
        return;
      }
      // Nothing to send, but the session is still alive and still
      // accumulating — see `bumpSummaryCadence`.
      bumpSummaryCadence();
    },
    { name: 'VitalsCollector.tick' }
  );

  let timer: ReturnType<typeof setInterval> | null = setIntervalFn(tick, flushIntervalMs);

  // Once at startup, before the initial summary below — that summary itself
  // can't carry a token (the warm is asynchronous and this is not), but it
  // starts the cache filling immediately rather than a whole flush interval
  // later.
  warmIdentity?.();

  // Initial non-final summary — creates the DB row with dims before any
  // chunk lands.
  sendSummary(false, false);

  return {
    get sessionId(): string {
      return sessionId;
    },

    recordSample: safeWrap(
      (s: Omit<VitalsSample, 'kind'>): void => {
        if (stopped) return;
        addEntry({ kind: 'sample', ...s });
      },
      { name: 'VitalsCollector.recordSample' }
    ),

    recordPlayerEvent: safeWrap(
      (e: Omit<VitalsPlayerEvent, 'kind'>): void => {
        if (stopped) return;
        // Codex round-4 finding 1 — bound the free-form payload BEFORE it
        // ever becomes an entry, so nothing downstream (pending/ring/report
        // enrichment) ever sees an oversized one. `data` is destructured out
        // and re-added via `boundPlayerEventData` rather than spread
        // straight through, so an explicit `data: undefined` on `e` can't
        // survive the spread (exactOptionalPropertyTypes forbids assigning
        // it back onto `VitalsPlayerEvent.data`).
        const { data, ...rest } = e;
        addEntry({ kind: 'player', ...rest, ...boundPlayerEventData(data) });
      },
      { name: 'VitalsCollector.recordPlayerEvent' }
    ),

    recordCustom: safeWrap(
      (e: Omit<VitalsCustomEntry, 'kind'>): void => {
        if (stopped) return;
        addEntry({ kind: 'custom', ...e });
      },
      { name: 'VitalsCollector.recordCustom' }
    ),

    recent: safeWrap(
      (windowMs: number = DEFAULT_RECENT_WINDOW_MS): VitalsEntry[] => {
        pruneRing(now() - windowMs);
        return ring.slice();
      },
      { name: 'VitalsCollector.recent' }
    ) as (windowMs?: number) => VitalsEntry[],

    flushNow: safeWrap(
      (opts?: { beacon?: boolean }): void => {
        if (stopped) return;
        const beacon = opts?.beacon ?? false;
        sendChunk(beacon);
        sendSummary(false, beacon);
      },
      { name: 'VitalsCollector.flushNow' }
    ),

    stop: safeWrap(
      (): void => {
        if (stopped) return;
        // try/finally: a throwing send() inside finalizeSession() (a real
        // pagehide/beacon failure mode) must not leave the collector
        // half-stopped — the flag and timer teardown always happen.
        try {
          finalizeSession();
        } finally {
          stopped = true;
          if (timer !== null) {
            clearIntervalFn(timer);
            timer = null;
          }
        }
      },
      { name: 'VitalsCollector.stop' }
    ),
  };
}
