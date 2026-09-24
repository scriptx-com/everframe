// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Shared envelope-stamping logic for Session Vitals (spec 2026-09-01 §8).
// Both the report path (transport/draft-to-envelope.ts) and the crash path
// (adapter.ts's crashSink) need to attach whatever vitals session is
// ACTIVELY running to the envelope they are about to enqueue — sessionId
// plus a capped tail of `recent()` entries. Factored out here rather than
// left duplicated (Codex round-1 finding S2): both call sites must apply the
// exact same MAX_ENVELOPE_VITALS_ENTRIES cap or one of them silently drifts
// and starts producing envelopes the protocol schema rejects outright (it
// caps `payload.vitals` at that same limit and rejects the WHOLE report,
// non-retryable, when exceeded).
import { MAX_ENVELOPE_VITALS_ENTRIES } from '@everframe/protocol';
import type { ReportEnvelope } from '@everframe/protocol';
import { __getActiveVitals } from './index.js';

/**
 * Stamp `envelope.sessionId` + `envelope.payload.vitals` from whatever vitals
 * session is active RIGHT NOW — read live at call time, not captured earlier,
 * so a report/crash built seconds into a long-running page load reflects
 * whatever vitals session is actually running at that instant (including one
 * that has since rotated — `__getActiveVitals()`'s `sessionId` is itself a
 * live getter, see vitals/index.ts's `ActiveVitalsBox`).
 *
 * No-op when vitals never started this session (disabled, losing the
 * sampling draw, or killed before `setupVitals` reached its start gate) —
 * the envelope is left exactly as `buildEnvelope`/`buildCrashEnvelope`
 * produced it, which is the additive-optional contract spec 2026-09-01 §8
 * promises.
 */
export function stampActiveVitals(envelope: ReportEnvelope): void {
  const activeVitals = __getActiveVitals();
  if (!activeVitals) return;
  envelope.sessionId = activeVitals.sessionId;
  // `.slice(-N)` keeps the NEWEST entries, matching "recent" — `recent()` is
  // a 60s ring with no entry-count ceiling of its own, so a busy player can
  // pack more than MAX_ENVELOPE_VITALS_ENTRIES entries into that window.
  envelope.payload.vitals = activeVitals.recent().slice(-MAX_ENVELOPE_VITALS_ENTRIES);
}
