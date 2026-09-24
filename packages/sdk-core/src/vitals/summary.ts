// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Session vitals summary accumulator — aggregates VitalsEntry events into a
// SessionSummary. Tracks rebuffers, startup time, bitrate, playtime, memory
// peaks/averages, and error counts across the session lifetime.
import type { VitalsEntry, SessionSummary, SessionSummaryDims } from '@everframe/protocol';

export interface SummaryAccumulator {
  onEntry(entry: VitalsEntry): void;
  snapshot(opts: { final: boolean; now: number }): SessionSummary;
}

export function createSummaryAccumulator(init: {
  sessionId: string;
  startedAt: number;
  dims: SessionSummaryDims;
}): SummaryAccumulator {
  const { sessionId, startedAt, dims } = init;

  // Rebuffer tracking.
  //
  // Codex round-3 finding F2 — COUNT-based union semantics, not a single
  // boolean/open-span pair. A session can have more than one attached
  // <video>/<audio> element (multi-player pages) all feeding the SAME
  // accumulator; a plain boolean conflates them — one element's buffer_end
  // would close a span that in reality belongs to (or overlaps) another
  // element's still-open rebuffer, and an overlapping second buffer_start
  // would vanish entirely (already "open"). `bufferCount` tracks how many
  // elements are CURRENTLY buffering; a union span is open whenever
  // count > 0, opened on the 0->1 transition and closed on the 1->0
  // transition. rebufferDurationMs is therefore WALL TIME during which AT
  // LEAST ONE player was buffering, not the sum of each element's own
  // buffering time (two elements buffering concurrently for 1s count as 1s
  // of rebuffer time, not 2s). Consequently the per-element `durationMs`
  // carried on the wire `buffer_end` event (still useful to Phase-2 readers
  // for per-element detail) is NOT used here — only the union span's own
  // open/close transition timestamps are, since only those reflect the
  // union's true boundaries.
  let bufferCount = 0;
  let bufferSpanStartT: number | null = null;
  let rebufferCount = 0;
  let rebufferDurationMs = 0;

  // Startup and bitrate tracking
  let startupTimeMs: number | null = null;
  let bitrateSum = 0;
  let bitrateN = 0;

  // Error tracking
  let errorCount = 0;

  // Playtime tracking.
  //
  // Codex round-3 finding F2 — same count-based union semantics as
  // buffering above: "playtime = wall time during which >=1 player was
  // playing" (union, not the sum of each element's own playing time).
  // `playCount` counts currently-playing elements; the play span opens on
  // the 0->1 transition and closes on the 1->0 transition.
  let playCount = 0;
  let playSpanStartT: number | null = null;
  let playtimeMs = 0;

  // Memory tracking
  let memPeak = 0;
  let memSum = 0;
  let memN = 0;

  // Player identity tracking (phase 4). Counts distinct playerIds seen on
  // ANY player event — not just player_attach — because an integration may
  // never fire an explicit attach event, and a phase-3-style event with no
  // playerId still represents a (single, unnamed) player. `''` stands in for
  // "no id" so those collapse into one bucket instead of being ignored.
  // Custom entries deliberately do NOT feed this set — a custom log line can
  // reference a playerId without that player actually being attached.
  //
  // Codex round-3 item 4 — this set has no detach path of its own, unlike
  // the registry's explicit registrations (a customer's own `detach()`):
  // it covers AUTOMATICALLY discovered players too, so an id for an
  // auto-attached element removed from the DOM long ago sits here for the
  // rest of the session regardless. An infinite-scroll feed spawning one
  // fresh <video> a second retains on the order of 86,000 strings over a
  // day-long session with no rotation. `MAX_TRACKED_PLAYERS` bounds
  // cardinality, not identity: this feeds exactly ONE report field
  // (`playerCount`, a bare number), so once the true count is well past any
  // real player-per-session count, the EXACT figure stops mattering — only
  // "did this session have an unusually large number of distinct players"
  // does, and the cap still answers that. 1,000 is comfortably above any
  // legitimate session's real distinct-player count (even a "video wall"
  // page showing dozens of players at once) while keeping worst-case
  // retention to ~1,000 short strings, a few tens of KB, regardless of how
  // long the session runs or how pathological the churn is.
  const players = new Set<string>();
  const MAX_TRACKED_PLAYERS = 1000;
  // Codex round-4 finding 4 — `playerCount` (players.size) silently
  // saturates at MAX_TRACKED_PLAYERS with no way for a reader to tell
  // "exactly 1,000" apart from "1,000+, more were refused". Set the FIRST
  // time a genuinely NEW id (not already tracked) arrives once the cap is
  // already full — see the branch in `onEntry` below.
  let playerCountSaturated = false;

  return {
    onEntry(entry: VitalsEntry): void {
      if (entry.kind === 'sample') {
        // Track memory peak and average
        if (entry.mem > memPeak) memPeak = entry.mem;
        memSum += entry.mem;
        memN++;
      } else if (entry.kind === 'player') {
        const { type, data, t } = entry;

        // Phase 4 — every player event counts toward playerCount, whatever
        // its type, so a library that never emits player_attach (or an
        // integration not yet wired up) still gets counted.
        //
        // Codex round-3 item 4 — gated on the cap: an id already IN the set
        // is always a safe no-op re-add (Set semantics), so this only ever
        // refuses a GENUINELY NEW id once `players.size` has already
        // reached `MAX_TRACKED_PLAYERS`. Past that point `playerCount`
        // saturates at the cap instead of growing further — a session that
        // truly cycles through more than 1,000 distinct player ids reports
        // exactly 1,000, a floor on "at least this many," rather than the
        // true (and by then meaningless) larger figure.
        const playerId = entry.playerId ?? '';
        if (!players.has(playerId)) {
          if (players.size < MAX_TRACKED_PLAYERS) {
            players.add(playerId);
          } else {
            // Codex round-4 finding 4 — a genuinely NEW id showed up with
            // the cap already full: `playerCount` is now a floor, not the
            // true count. Recorded so the summary/UI can say "1000+"
            // instead of a false exact number.
            playerCountSaturated = true;
          }
        }

        if (type === 'buffer_start') {
          // Codex round-3 finding F2 — count-based union span: only the
          // 0->1 transition opens the span and counts a NEW rebuffer;
          // a second (or third...) concurrently-buffering element just
          // bumps the count without touching rebufferCount or the span's
          // start time — the union span already covers it.
          bufferCount++;
          if (bufferCount === 1) {
            bufferSpanStartT = t;
            rebufferCount++;
          }
        } else if (type === 'buffer_end') {
          // Floor at 0 — a stray/duplicate buffer_end (no matching open
          // count) must not go negative and poison the next real pair.
          if (bufferCount > 0) {
            bufferCount--;
            // Only the transition back to 0 closes the union span. Per-
            // element `data.durationMs` is deliberately NOT used here (see
            // the field-level comment above `bufferCount`'s declaration) —
            // the union's own start/end timestamps are what's correct for
            // a multi-player session.
            if (bufferCount === 0 && bufferSpanStartT !== null) {
              // Fix T3-upgrade (final review): clamp — a backwards clock
              // jump must not produce a negative rebufferDurationMs. The
              // route's SessionSummary schema requires `.nonnegative()`, so
              // an unclamped negative here would 400 the whole summary for
              // the rest of the session.
              rebufferDurationMs += Math.max(0, t - bufferSpanStartT);
              bufferSpanStartT = null;
            }
          }
        } else if (type === 'startup') {
          // Take first startup ttff
          if (startupTimeMs === null && typeof data?.ttffMs === 'number') {
            startupTimeMs = data.ttffMs;
          }
        } else if (type === 'bitrate_change') {
          // Track bitrate for averaging
          if (typeof data?.bitrate === 'number') {
            bitrateSum += data.bitrate;
            bitrateN++;
          }
        } else if (type === 'error') {
          // Count errors
          errorCount++;
        } else if (type === 'play') {
          // Codex round-3 finding F2 — count-based union span, same shape
          // as buffering above: only the 0->1 transition opens the span.
          // A second attached element's `play` while the first is already
          // playing just bumps the count — playtime keeps accruing under
          // the ALREADY-open span rather than being double-counted or
          // (worse, under the old single-flag design) having the SECOND
          // element's play silently ignored as "already playing".
          playCount++;
          if (playCount === 1) {
            playSpanStartT = t;
          }
        } else if (type === 'pause') {
          // Floor at 0 — a stray/duplicate pause (no matching open count)
          // must not go negative and poison the next real pair.
          if (playCount > 0) {
            playCount--;
            // Only the transition back to 0 closes the union span — e.g.
            // with two players, the FIRST element's pause must not close a
            // span the SECOND element is still keeping open.
            if (playCount === 0 && playSpanStartT !== null) {
              // Fix T3-upgrade (final review): same clamp as
              // rebufferDurationMs above — a backwards clock jump must not
              // produce a negative playtimeMs (schema `.nonnegative()`,
              // same 400 hazard).
              playtimeMs += Math.max(0, t - playSpanStartT);
              playSpanStartT = null;
            }
          }
        }
      }
    },

    snapshot(opts: { final: boolean; now: number }): SessionSummary {
      // Close any open spans without mutating state
      let adjustedPlaytimeMs = playtimeMs;
      if (playCount > 0 && playSpanStartT !== null) {
        // Codex round-2 finding R8 — round-1's clamps covered the CLOSED-span
        // accumulation paths (onEntry's `pause`/`buffer_end` handlers above);
        // this open-span closure computed directly from `now - openT` was
        // still unclamped. A backwards clock (or a `now` earlier than the
        // span's start — see collector.ts's Codex round-2 finding R6, which
        // can now pass an explicit historical `now`) must not produce a
        // negative, schema-invalid summary here either.
        //
        // Codex round-3 finding F2 — `rebufferCount`/the union span itself
        // are keyed off `playCount`/`bufferCount` now, not a boolean; a
        // still-open union span here means count > 0. `rebufferCount` was
        // already incremented at the 0->1 transition inside `onEntry`
        // (unlike the old design, which counted at CLOSE time), so there is
        // no matching "+1 for the still-open span" to add here — only the
        // duration needs the open-span adjustment.
        adjustedPlaytimeMs += Math.max(0, opts.now - playSpanStartT);
      }

      const adjustedRebufferCount = rebufferCount;
      let adjustedRebufferDurationMs = rebufferDurationMs;
      if (bufferCount > 0 && bufferSpanStartT !== null) {
        // Codex round-2 finding R8 — same clamp as the playtime span above.
        // See the comment above `adjustedPlaytimeMs` for why this branch,
        // under the round-3 count-based design, adjusts ONLY the duration
        // and not `adjustedRebufferCount` (already counted at open time).
        adjustedRebufferDurationMs += Math.max(0, opts.now - bufferSpanStartT);
      }

      const durationMs = Math.max(0, opts.now - startedAt);
      const memAvg = memN > 0 ? Math.round(memSum / memN) : 0;
      const bitrateMean = bitrateN > 0 ? Math.round(bitrateSum / bitrateN) : null;

      // Codex round-2 finding R4 — `durationMs`/`playtimeMs`/`startupTimeMs`/
      // `rebufferDurationMs` now land in `integer` (int4) DB columns and the
      // protocol schema gained `.int()` to match (protocol/src/vitals.ts).
      // Every one of these is computed from clock/timestamp arithmetic
      // (`now - startedAt`, `t - spanStartT`, a caller-supplied `ttffMs`)
      // that can legitimately produce a fractional millisecond value —
      // rounding here (not rejecting) keeps a genuinely-valid summary from
      // 400ing at ingest just because its inputs weren't already integers.
      return {
        kind: 'summary',
        sessionId,
        final: opts.final,
        startedAt,
        durationMs: Math.round(durationMs),
        playtimeMs: Math.round(adjustedPlaytimeMs),
        startupTimeMs: startupTimeMs === null ? null : Math.round(startupTimeMs),
        rebufferCount: adjustedRebufferCount,
        rebufferDurationMs: Math.round(adjustedRebufferDurationMs),
        bitrateMean,
        errorCount,
        memPeak,
        memAvg,
        playerCount: players.size,
        // Codex round-4 finding 4 — always present (never omitted when
        // false), unlike the phase-3-compat optionality on `playerCount`
        // itself: this accumulator always KNOWS whether it saturated, so
        // there is no "predates this field" case to preserve here the way
        // there is for `playerCount` on an old SDK.
        playerCountSaturated,
        dims,
      };
    },
  };
}
