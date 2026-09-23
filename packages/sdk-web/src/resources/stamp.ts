// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report Resource Window (spec 2026-09-05, Task 9) — shared envelope-stamping
// logic. Both the report path (transport/draft-to-envelope.ts) and the crash
// path (adapter.ts's crash sink) call this ONE helper to attach whatever
// resource ring is ACTIVELY running to the envelope they are about to
// enqueue. Factored out here rather than left duplicated (same doctrine as
// vitals/stamp-active-vitals.ts, Codex round-1 finding S2): both call sites
// must apply the exact same MAX_RESOURCE_SAMPLES cap or one of them silently
// drifts and starts producing envelopes the protocol schema rejects
// outright (it caps `payload.resources` at that same limit and rejects the
// WHOLE report, non-retryable, when exceeded).
//
// DELIBERATELY separate from stamp-active-vitals.ts / vitals/index.ts's
// `_active` box — Session Vitals is not modified by this work (Global
// Constraints), and `resources.ts` (protocol) is itself a deliberately
// separate block from `vitals.ts` for the same reason (see that file's
// header). This module owns its OWN box.
import { MAX_RESOURCE_SAMPLES } from '@everframe/protocol';
import type { ReportEnvelope, ResourceSampleT } from '@everframe/protocol';

/** What `__getActiveResources()` hands back while sampling is running. */
export interface ActiveResourcesBox {
  snapshot(): ResourceSampleT[];
}

let _active: ActiveResourcesBox | undefined;

/** Test-only / adapter-lifecycle seam — set by adapter.ts when the ring starts/stops. */
export function __setActiveResources(box: ActiveResourcesBox | undefined): void {
  _active = box;
}

/** Present only while the resource sampler is actually running; undefined otherwise. */
export function __getActiveResources(): ActiveResourcesBox | undefined {
  return _active;
}

/**
 * Stamp `envelope.payload.resources` from whatever resource ring is active
 * RIGHT NOW — read live at call time, not captured earlier, mirroring
 * `stampActiveVitals`'s `__getActiveVitals()` box pattern.
 *
 * No-op when the feature never started this session (disabled by server
 * config, or killed before the sampler started) — the envelope is left
 * exactly as the caller built it.
 *
 * Must never throw: the crash path calls this on a dying code path, and a
 * throwing stamp would be worse than a missing one.
 */
export function stampResources(envelope: ReportEnvelope): void {
  try {
    const active = _active;
    if (!active) return;
    // `.slice(-N)` keeps the NEWEST entries — the ring itself is already
    // capped at MAX_RESOURCE_SAMPLES, but re-applying the cap here (rather
    // than trusting the ring) is what keeps this call site and any future
    // one from drifting apart on the number that matters to the server.
    const capped = active.snapshot().slice(-MAX_RESOURCE_SAMPLES);
    // Round-review Finding 4 (2026-09-05) — an empty snapshot (report filed
    // within one sample tick of the ring starting, or every sample aged out
    // while the tab was hidden) must OMIT the key entirely, not assign
    // `resources: []`. Both natives already omit it in this case
    // (`EnvelopeBuilder.swift:230`'s `!resources.isEmpty` guard;
    // `EnvelopeBuilder.kt:344`'s `if (cappedResources.isEmpty()) null`) —
    // an unconditional assignment here was the one wire-shape web/native
    // could disagree on for identical underlying state.
    if (capped.length === 0) return;
    envelope.payload.resources = capped;
  } catch {
    /* swallow — must never throw, the crash path calls this */
  }
}
