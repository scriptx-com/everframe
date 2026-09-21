// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Session vitals — runtime performance metrics over the lifetime of a user
// session: memory, CPU (native only), playback events (buffer, bitrate, rate,
// errors, frames, startup), and summary statistics. Two payload kinds:
// VitalsChunk (timestamped samples and player events) and SessionSummary
// (aggregated session-scoped metrics and dimensions).
//
// Spec: the public behavior contract
import { z } from 'zod';
import { SDKPlatform } from './sdk-platform.js';

/**
 * Ceiling on `payload.vitals` entries carried by a single ReportEnvelope
 * (report-enrichment "recent window", spec 2026-09-01 §2) — shared with
 * envelope.ts's `.max()` on that field so the schema cap and the SDK-side
 * stamp site (sdk-web's draft-to-envelope.ts) can never drift apart. A stamp
 * site that emits more than this makes the server reject the WHOLE report
 * (400, non-retryable) rather than merely dropping the vitals block.
 */
export const MAX_ENVELOPE_VITALS_ENTRIES = 400;

export const VitalsPlayerEventType = z.enum([
  'play', 'pause', 'seek', 'buffer_start', 'buffer_end', 'bitrate_change',
  'rate_change', 'error', 'startup', 'dropped_frames', 'source_change',
  // Phase 4 (spec 2026-09-02 §1). `stats` supersedes the per-tick
  // `dropped_frames` for new SDKs; the old value stays so stored sessions parse.
  'player_attach', 'player_detach', 'drm', 'quality_change', 'stats',
]).meta({ $id: 'VitalsPlayerEventType' });

/** Player identity (spec 2026-09-02 §1): registry-minted `p1`, `p2`, …; absent on phase-3 SDKs. */
export const MAX_PLAYER_ID_LENGTH = 32;
// No $id: the schema generator inlines this at two sites and ajv rejects a duplicated $id.
export const VitalsPlayerId = z.string().min(1).max(MAX_PLAYER_ID_LENGTH);

/** Ceiling on a `custom` entry's `data` once serialised (UTF-8 bytes). Enforced by the SDK (`boundJson`) AND here, so a hand-rolled client cannot bypass it. Tune in one place. */
export const MAX_CUSTOM_DATA_BYTES = 2048;
export const MAX_CUSTOM_NAME_LENGTH = 64;

/**
 * Ceiling on a `player` entry's `data` once serialised (UTF-8 bytes) —
 * codex round-5 item 3. Round 4 applied `MAX_CUSTOM_DATA_BYTES` (2048) to
 * player events too, but that cap is the CUSTOM-entry budget (spec
 * 2026-09-02 §2's `trackVitals` free-form log line), and it was too small
 * for a legitimate structured player error: a 3 KB `{ message, code, fatal,
 * detail }` payload — well within the ordinary transport budget — lost
 * every field but a generic "Error" once collapsed to fit 2048 bytes.
 *
 * 8192 (4x the custom-entry cap) comfortably holds any legitimate
 * structured error this SDK documents (`error { message, code?, fatal?,
 * detail? }`, `startup`, `stats`, `bitrate_change`, ...) — including one
 * with a substantial `detail` (a stack trace or a decoder's verbose
 * message) — while still protecting the report path from a pathological,
 * multi-megabyte payload: `MAX_ENVELOPE_VITALS_ENTRIES` (400) player
 * entries at this cap bound a single vitals block at ~3.2 MB worst case, a
 * small fraction of the report ingest's 25 MiB body limit
 * (the ingest API/src/server.ts), not the multi-MB-PER-ENTRY blowout this cap
 * exists to prevent.
 */
export const MAX_PLAYER_EVENT_DATA_BYTES = 8192;

/**
 * Codex round-2 item 11 — `player_attach.library`/`libraryVersion` cap
 * (spec 2026-09-02 §2: `PlayerIntegration.library` documented at "≤ 32
 * chars"; applied to `libraryVersion` too since it's the same
 * identity-metadata pair and was otherwise completely unbounded). An
 * uncapped, foreign-supplied string here would inflate `player_attach` and,
 * via the recent ring, every enriched bug report until it expires — same
 * class of risk `MAX_CUSTOM_NAME_LENGTH` already guards for player/custom
 * names.
 */
export const MAX_PLAYER_LIBRARY_LENGTH = 32;

/**
 * UTF-8 byte length without allocating an encoder per call site.
 *
 * Codex review (task 1 fix round) — a high surrogate (0xd800-0xdbff) only
 * forms a 4-byte encoding when it is immediately followed by a REAL low
 * surrogate (0xdc00-0xdfff); naively counting 4 bytes and skipping ahead
 * whenever a lone high surrogate appears both mis-sizes the lone surrogate
 * AND silently consumes (and never counts) the next code unit. An unpaired
 * high surrogate, and a standalone low surrogate (which never matches the
 * high-surrogate branch and already fell through correctly), each encode as
 * the 3-byte UTF-8 replacement character — matching `TextEncoder` — so both
 * must count as 3 bytes without advancing `i` past their neighbour.
 */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i++; } // real surrogate pair
      else bytes += 3; // unpaired high surrogate
    }
    else bytes += 3;
  }
  return bytes;
}

export const VitalsSample = z.object({
  kind: z.literal('sample'),
  /** Epoch ms — same shared clock as breadcrumbs. */
  t: z.number(),
  /** Fraction of one core (0–n). Absent on web — no browser CPU API. */
  cpu: z.number().min(0).optional(),
  /** Bytes. Web: usedJSHeapSize (0 when unavailable). Native: phys footprint / PSS. */
  mem: z.number().nonnegative(),
  /** Platform extras — web sends { longTaskMs, loopLagMs }. */
  extras: z.record(z.string(), z.number()).optional(),
}).meta({ $id: 'VitalsSample' });

export const VitalsPlayerEvent = z.object({
  kind: z.literal('player'),
  t: z.number(),
  type: VitalsPlayerEventType,
  playerId: VitalsPlayerId.optional(),
  /** Type-specific payload: startup { ttffMs, manifestMs?, licenseMs?,
   *  firstFragmentMs? }, buffer_end { durationMs }, bitrate_change { bitrate,
   *  width?, height?, level?, reason? }, rate_change { rate }, error
   *  { message, code?, fatal?, detail? }, dropped_frames { count }.
   *  `source_change` carries NO payload on phase-3 SDKs — the player adapter
   *  records the first non-empty `src` it observes silently and emits this
   *  event only on a later CHANGE to a different src; phase-4 SDKs now also
   *  fire it on the FIRST source with { src, protocol, mime?, live? }.
   *  Phase 4 additions: player_attach { name?, tag, library, libraryVersion? },
   *  drm { keySystem, licenseMs? }, quality_change { width, height }, stats
   *  { bufferAheadMs, bandwidthEstimate?, bitrate?, width?, height?,
   *  droppedFrames }. Bounded by the SDK at `MAX_PLAYER_EVENT_DATA_BYTES`
   *  (structure-preserving — see that constant's doc-comment), not the
   *  entries cap alone. */
  data: z.record(z.string(), z.unknown()).optional(),
  /**
   * Codex round-5 item 3 — set by the SDK when `data` had to be shrunk to
   * fit `MAX_PLAYER_EVENT_DATA_BYTES` (one or more string fields cut; every
   * scalar field is kept intact regardless). Absent means untouched, the
   * same convention `VitalsCustomEntry.truncated` already uses — an
   * operator or the admin UI can surface this without having to notice a
   * field went missing on their own.
   */
  truncated: z.boolean().optional(),
}).meta({ $id: 'VitalsPlayerEvent' });

/**
 * Customer-fed log line (spec 2026-09-02 §1): `trackVitals(name, data)`.
 * `data` is any JSON value; the refinement measures it exactly the way the
 * SDK's `boundJson` does (JSON.stringify → UTF-8 bytes) so the two caps can
 * never disagree. `truncated` is set by the SDK when it had to cut `data`.
 */
export const VitalsCustomEntry = z.object({
  kind: z.literal('custom'),
  t: z.number(),
  name: z.string().min(1).max(MAX_CUSTOM_NAME_LENGTH),
  data: z.unknown().optional(),
  truncated: z.boolean().optional(),
  playerId: VitalsPlayerId.optional(),
}).refine(
  (e) => e.data === undefined || utf8ByteLength(JSON.stringify(e.data) ?? '') <= MAX_CUSTOM_DATA_BYTES,
  { message: `custom data exceeds ${MAX_CUSTOM_DATA_BYTES} bytes`, path: ['data'] },
).meta({ $id: 'VitalsCustomEntry' });

export const VitalsEntry = z.discriminatedUnion('kind', [VitalsSample, VitalsPlayerEvent, VitalsCustomEntry]);

export const VitalsChunk = z.object({
  kind: z.literal('chunk'),
  sessionId: z.string().uuid(),
  /**
   * Monotonic per-session chunk number, from 0.
   *
   * Codex round-2 finding R4 — capped at 1,000,000: at the SDK's ~30s flush
   * cadence, 24h of continuous session life is ~2,880 chunks, so 1e6 is
   * generous headroom for any legitimate session while still keeping
   * `seq + 1` (the chunk-count high-water mark stored in
   * `vitals_sessions.chunk_count`, an int4 column — see
   * the server schema) far inside int32 range. Without this, a
   * malformed/hostile `seq` near `Number.MAX_SAFE_INTEGER` would overflow
   * that column on write.
   */
  seq: z.number().int().nonnegative().max(1_000_000),
  entries: z.array(VitalsEntry).min(1).max(200),
}).meta({ $id: 'VitalsChunk' });

export const SessionSummaryDims = z.object({
  platform: SDKPlatform,
  appVersion: z.string(),
  sdkVersion: z.string(),
  deviceModel: z.string().optional(),
  osVersion: z.string().optional(),
}).meta({ $id: 'SessionSummaryDims' });

/**
 * Codex round-2 finding R4 — every DB-backed numeric below is bounded to
 * match the column it lands in (the server schema's
 * `vitalsSessions`), so a malformed/hostile summary 400s at the schema
 * boundary instead of overflowing (or erroring on) the write:
 *   - `durationMs`/`playtimeMs`/`startupTimeMs`/`rebufferCount`/
 *     `rebufferDurationMs`/`errorCount` are `integer` (int4, max
 *     2,147,483,647) columns — `.max(2_147_483_647)`. The four that were not
 *     already `.int()` (durationMs, playtimeMs, startupTimeMs,
 *     rebufferDurationMs — accumulated from wall-clock deltas, which can
 *     arrive fractional) now also get `.int()`; `rebufferCount`/`errorCount`
 *     were already `.int()` (they're counts).
 *   - `memPeak`/`memAvg` are `bigint` (mode: 'number') columns and
 *     `bitrateMean` is `real` — none needs `.int()`, but all three still
 *     need an upper bound to stay inside what a JS `number` can represent
 *     exactly once round-tripped through the DB driver: `.max(Number.MAX_SAFE_INTEGER)`.
 */
const INT32_MAX = 2_147_483_647;

/**
 * Self-declared (UNVERIFIED) end-user identity, shaped exactly like a report
 * envelope's `reporter.user` so `normalizeSelfDeclaredUser`
 * (the server self-declared identity contract) consumes it unchanged.
 *
 * DELIBERATELY UNBOUNDED here, mirroring `reporter.user` in envelope.ts: this
 * rides under the PUBLISHABLE SDK key, so anyone who extracts that key from
 * the customer's app can assert anything, and the server treats it as a
 * claim, never as authentication — see the `verified` column on
 * `reporter_identities`. A `.max()` here would mean a Zod failure 400s the
 * whole request, and for a vitals summary the `user` block rides alongside
 * the row's ONLY source of dims and metrics — rejecting the summary over one
 * over-long identity attribute would cost ingest the row entirely, not just
 * the identity claim. `normalizeSelfDeclaredUser` already discards over-long
 * values before storage, so nothing unbounded is persisted.
 *
 * And TYPE-TOLERANT for the same reason, one step further (adversarial review
 * of PR #218, finding 4 — all four shapes reproduced against the running
 * route). "Unbounded" only covered over-long STRINGS; a wrong TYPE still
 * failed validation and took the whole summary with it — `user: {id: 123}`
 * from an untyped JS host, `user: null` from `setUser(null)`, a
 * `{email: null}` from an ORM row that spells "absent" as null, each a 400
 * that stored NO session at all. Identity data must cost ATTRIBUTION, never
 * dims and metrics (the design spec's invariant 2).
 *
 * `.catch()` makes every one of those degrade instead of reject: each
 * attribute that isn't a string becomes `undefined`, and a `user` that isn't
 * an object at all becomes an absent block. The server side needs no change —
 * `normalizeSelfDeclaredUser(user: unknown)` is already defensive about
 * arbitrary input and simply resolves the summary anonymous.
 *
 * Do not add `.email()`, `.max()`, or `.min()` back here, and do not remove
 * the `.catch()`es.
 */
export const SessionSummaryUser = z.object({
  id: z.string().optional().catch(undefined),
  email: z.string().optional().catch(undefined),
  displayName: z.string().optional().catch(undefined),
}).meta({ $id: 'SessionSummaryUser' });

export const SessionSummary = z.object({
  kind: z.literal('summary'),
  sessionId: z.string().uuid(),
  /** true only on the session-ending summary (kill/destroy). */
  final: z.boolean(),
  /**
   * Codex round-6 item 3 / round-7 item 1 — monotonically increasing
   * per-session sequence number, stamped by the collector (packages/sdk-core/
   * src/vitals/collector.ts) once per snapshot, mirroring `VitalsChunk.seq`
   * above (same established pattern, a different payload kind). Four rounds
   * of ingest fixes tried to infer which of two summaries was "fresher" from
   * `durationMs` alone and each shipped a new hole — duration is
   * millisecond-rounded (so two summaries can share a value with no ordering
   * information) and, per round 7, not even monotonic across a session: a
   * FINAL summary can legitimately snapshot at `lastEntryAt` after a long
   * BFCache/idle gap, reporting a LOWER duration than an earlier mid-session
   * summary despite being the newer one. `seq` is immune to both problems, so
   * the ingest route (the server vitals contract) treats it as the
   * PRIMARY freshness signal for every gated field whenever both the incoming
   * and stored summary carry one — duration comparison is the legacy
   * fallback used only when either side lacks it. Optional on the wire: a
   * phase-3 SDK (predates this field) omits it entirely, which is exactly
   * the case that falls back. Capped the same as `VitalsChunk.seq` (chunk
   * cadence bounds a session's realistic chunk count; a summary is emitted
   * at most once per `summaryEveryChunks` chunks, so it can never outrun
   * that cap).
   */
  seq: z.number().int().nonnegative().max(1_000_000).optional(),
  // `.catch()` for the same reason as the attributes inside it: a `user` that
  // is not an object at all (`null`, a number, an array) becomes an ABSENT
  // block rather than a 400 that loses the summary. See `SessionSummaryUser`.
  user: SessionSummaryUser.optional().catch(undefined),
  startedAt: z.number(),
  durationMs: z.number().int().nonnegative().max(INT32_MAX),
  playtimeMs: z.number().int().nonnegative().max(INT32_MAX),
  startupTimeMs: z.number().int().nonnegative().max(INT32_MAX).nullable(),
  rebufferCount: z.number().int().nonnegative().max(INT32_MAX),
  rebufferDurationMs: z.number().int().nonnegative().max(INT32_MAX),
  bitrateMean: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  errorCount: z.number().int().nonnegative().max(INT32_MAX),
  memPeak: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
  memAvg: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** Phase 4: distinct players seen this session. Optional on the wire — phase-3 SDKs omit it; ingest writes 0. */
  playerCount: z.number().int().nonnegative().max(INT32_MAX).optional(),
  /**
   * Codex round-4 finding 4 — `true` when the SDK's own distinct-player
   * cap (`MAX_TRACKED_PLAYERS`, packages/sdk-core/src/vitals/summary.ts)
   * was hit and at least one FURTHER distinct player id was seen and
   * refused: `playerCount` at that point is a floor ("at least this many"),
   * not the true count. Optional/absent (not merely `false`) on the wire —
   * a phase-3 SDK that predates this field omits it entirely, and ingest
   * must not invent a `false` that implies "definitely not saturated" for
   * an SDK that never checked.
   */
  playerCountSaturated: z.boolean().optional(),
  dims: SessionSummaryDims,
}).meta({ $id: 'SessionSummary' });

export const VitalsIngestBody = z.discriminatedUnion('kind', [VitalsChunk, SessionSummary]);

/**
 * Route-level wrapper. `apiKey` exists because sendBeacon cannot set an
 * Authorization header — the unload path carries the key in the body; the
 * fetch path uses the header and omits it. The route accepts either.
 */
export const VitalsIngestRequest = z.object({
  apiKey: z.string().optional(),
  payload: VitalsIngestBody,
  /**
   * The verified identity token, on the beacon path only.
   *
   * `navigator.sendBeacon` cannot set headers — which is exactly why `apiKey`
   * above already rides in the body — so the `x-tx-identity-token` header's
   * value comes through here instead when a summary is flushed on unload. The
   * ingest route prefers the header when both are present.
   *
   * DELIBERATELY UNBOUNDED, like `SessionSummaryUser`'s attributes: a Zod
   * failure would 400 the whole request and lose the summary. An over-long or
   * malformed token is rejected at verification, where it degrades to an
   * anonymous session instead.
   *
   * And `.catch()`-tolerant of a wrong TYPE for exactly that reason
   * (adversarial review of PR #218, finding 4): `identityToken: null` — the
   * shape a host gets from `token ?? null` — used to 400 the whole envelope
   * and store no session.
   *
   * IT CATCHES TO `''`, NOT TO `undefined` (round-2 finding 2, reproduced with
   * arrays, objects, numbers and null). `undefined` is the wire's word for
   * "no token was presented", and the ingest route reads it that way: an
   * absent token is the ONE condition under which the unverified,
   * self-declared `user` block is consulted. Catching a malformed value to
   * `undefined` therefore erased the difference between "absent" and
   * "presented but broken", and `identityToken: ['invalid.token.value']`
   * alongside a `user` block minted an unverified person — the exact
   * self-declared FALLBACK the design spec's invariant 1 forbids, quietly
   * re-enabled by a validation fix.
   *
   * `''` is the honest reading: something was presented. The route treats ANY
   * string, blank included, as a presentation (see
   * `the server vitals identity contract`), so a malformed token now fails
   * the structural pre-screen, logs `malformed`, and resolves ANONYMOUS with
   * no fallback — while the summary's dims and metrics still land, which is
   * what finding 4 was about. `.optional()` runs first, so a genuinely ABSENT
   * field still parses to `undefined` without ever reaching this catch.
   */
  identityToken: z.string().optional().catch(''),
}).meta({ $id: 'VitalsIngestRequest' });

export type VitalsPlayerEventType = z.infer<typeof VitalsPlayerEventType>;
export type VitalsPlayerId = z.infer<typeof VitalsPlayerId>;
export type VitalsSample = z.infer<typeof VitalsSample>;
export type VitalsPlayerEvent = z.infer<typeof VitalsPlayerEvent>;
export type VitalsCustomEntry = z.infer<typeof VitalsCustomEntry>;
export type VitalsEntry = z.infer<typeof VitalsEntry>;
export type VitalsChunk = z.infer<typeof VitalsChunk>;
export type SessionSummaryDims = z.infer<typeof SessionSummaryDims>;
export type SessionSummaryUser = z.infer<typeof SessionSummaryUser>;
export type SessionSummary = z.infer<typeof SessionSummary>;
export type VitalsIngestBody = z.infer<typeof VitalsIngestBody>;
export type VitalsIngestRequest = z.infer<typeof VitalsIngestRequest>;
