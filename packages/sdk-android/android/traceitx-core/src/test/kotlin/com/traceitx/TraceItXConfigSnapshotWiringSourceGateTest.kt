// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Independent review, round 9, P1 — a behavioural test cannot reproduce the
// defect this pins: `TraceItX.captureSessionSnapshot()` reads `_config`/
// `_user` (whose `startEpoch` this gate cares about) in ONE `stateLock`
// acquisition (see `TXCapturedSession`'s doc comment), so there is no longer
// any window between "config read" and "epoch read" for a `start(projectB)`
// to land in — the interleaving the P1 finding described is now structurally
// unreachable, which is the intended outcome, not a gap in coverage. What CAN
// still regress silently is the WIRING: a future edit to `TraceItX.kt`'s
// `requestOutboxDrain()` could reintroduce a separate `currentStartEpoch()`
// read at the drain-kickoff point instead of reusing the snapshot's own
// `user.startEpoch`, quietly reopening the exact "sampled separately" hazard
// this round closed — indistinguishable from the fixed code in any test that
// (like every behavioural test in this suite) exercises the reads
// sequentially, with nothing else running between them.
//
// This mirrors iOS's established source-gate convention
// (`CrashReporterConfigSnapshotSourceGate` in `EnvelopeUserTests.swift`),
// used there because `ReporterSubmission.swift` is UIKit-gated and
// unreachable from `swift test`. Android's `requestOutboxDrain()` has no
// such reachability problem — it is exercised behaviourally elsewhere
// (`CrashDeliveryTest.kt`) — but the SPECIFIC hazard here (two independently
// sampled reads that happen to agree in any single-threaded test run) is
// exactly as invisible to a behavioural assertion on this platform as it is
// on iOS. A source gate is the right tool regardless of platform whenever a
// real race has been closed structurally and only the WIRING that keeps it
// closed remains testable.
//
// Merge note (native-identity x captured-session, 2026-08-16): this
// originally pinned the now-removed `TXCapturedConfig`/`captureConfigSnapshot()`
// pairing. `TXCapturedSession`/`captureSessionSnapshot()` subsumes that job
// (it already carries `config` alongside `user`/`startEpoch`/the revocation
// counter from the SAME acquisition), so the wiring this gate protects is now
// "read config and epoch from `captured`, never re-acquire," not "call a
// second snapshot function." Updated in place — the invariant is unchanged,
// only which snapshot carries it.
package com.traceitx

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class TraceItXConfigSnapshotWiringSourceGateTest {

    /**
     * Reads `TraceItX.kt` as text — no Robolectric, no `TraceItX` singleton
     * touched, so this can never be confused with (or masked by) any other
     * test's process-global state.
     */
    private fun traceItXSource(): String {
        val candidates = listOf(
            File("src/main/kotlin/com/traceitx/TraceItX.kt"),
            File("traceitx-core/src/main/kotlin/com/traceitx/TraceItX.kt"),
            File("android/traceitx-core/src/main/kotlin/com/traceitx/TraceItX.kt"),
        )
        val file = candidates.firstOrNull { it.exists() }
            ?: error(
                "TraceItX.kt not found relative to ${File(".").absolutePath} — tried " +
                    candidates.joinToString { it.path },
            )
        return file.readText()
    }

    private fun strippingLineComments(source: String): String =
        source.lineSequence().joinToString("\n") { line ->
            val idx = line.indexOf("//")
            if (idx >= 0) line.substring(0, idx) else line
        }

    @Test
    fun `requestOutboxDrain reads config and epoch from one atomic snapshot not two separate reads`() {
        val code = strippingLineComments(traceItXSource())

        val snapshotCallIndex = code.indexOf("val captured = captureSessionSnapshot()")
        assertTrue(
            "TraceItX.kt's requestOutboxDrain() no longer captures config and epoch together via " +
                "captureSessionSnapshot(). Reading _config and currentStartEpoch() as two SEPARATE " +
                "statements re-opens the round-9 P1 hazard: a start(projectB) landing between the two " +
                "reads pairs project A's config with project B's epoch, and drainOutbox's guards cannot " +
                "tell that pairing apart from a genuinely consistent one.",
            snapshotCallIndex >= 0,
        )

        val cfgLineIndex = code.indexOf("val cfg = captured.config ?: return", snapshotCallIndex)
        assertTrue(
            "TraceItX.kt no longer resolves `cfg` from captured.config — has requestOutboxDrain() " +
                "been restructured?",
            cfgLineIndex >= snapshotCallIndex,
        )

        val epochLineIndex = code.indexOf("val epochAtInitiation = captured.user.startEpoch", cfgLineIndex)
        assertTrue(
            "TraceItX.kt's requestOutboxDrain() no longer threads epochAtInitiation from " +
                "captured.user.startEpoch — the SAME value cfg came from. A separate, later " +
                "currentStartEpoch() read here would reopen the round-9 P1 hazard: reverting to two " +
                "independently-sampled reads instead of one atomic snapshot.",
            epochLineIndex >= cfgLineIndex,
        )
    }
}
