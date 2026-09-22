// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Independent review, round 14 (codex round 12), Serious 2 — a behavioural
// test cannot reliably reproduce a Java Memory Model visibility hazard: it
// needs a genuine write on one thread racing a genuine read on another with
// no synchronization between them, and even then a JVM is free to make the
// write visible anyway on any given run (the hazard is real but not
// deterministically observable) — the same class of problem this codebase
// has already documented for a different race (`IdentityTokenHolderTests
// .testAFastResolvingProviderNeverLosesADeliveryToARegistrationRace`'s own
// doc comment, iOS: "did NOT reliably reproduce the mutation via raw
// statistical racing on this machine").
//
// `TraceItX._replaySession` is written under `stateLock` (`start()`'s
// `start.replay` block, `kill()`) and read WITHOUT it from
// `currentReplayConfig()` — the accessor every submit path (live, drain,
// crash-then-drain) uses to decide whether identity is enabled, and the one
// `__warmIdentityToken()`'s independently-launched, detached coroutine
// consults. `@Volatile` is what makes that lock-free read safe: it gives the
// stateLock-guarded write a JMM publication guarantee to any later
// unsynchronized read, matching this exact class's own established pattern
// for the same shape (`appContext`, `sharedOutbox`, `captureGate`).
//
// This mirrors the round-9 precedent (`TraceItXConfigSnapshotWiringSourceGateTest`)
// and iOS's own source-gate convention: a source gate is the right tool
// whenever a real race has been closed by a language-level guarantee
// (`@Volatile` here; a single atomic snapshot there) and only the WIRING that
// keeps it closed remains testable. Mutation-verified: removing `@Volatile`
// from `_replaySession`'s declaration makes this fail.
package com.traceitx

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class ReplaySessionVolatileSourceGateTest {

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

    @Test
    fun `_replaySession carries Volatile so currentReplayConfig's lock-free read has a publication guarantee`() {
        val code = traceItXSource()

        val fieldIndex = code.indexOf("internal var _replaySession: ReplaySession? = null")
        assertTrue(
            "TraceItX.kt's _replaySession field declaration was not found as expected — has it been renamed " +
                "or restructured? Update this gate to match.",
            fieldIndex >= 0,
        )

        // The annotation must appear on the line(s) immediately preceding the
        // field, not merely somewhere earlier in the file (e.g. on a
        // different field entirely) — take a narrow window right before the
        // declaration, the same shape @Volatile takes on appContext/
        // sharedOutbox/captureGate above it in this same file.
        val precedingWindow = code.substring(maxOf(0, fieldIndex - 120), fieldIndex)
        assertTrue(
            "TraceItX.kt's _replaySession is no longer annotated @Volatile immediately before its " +
                "declaration. Without it, currentReplayConfig()'s lock-free read of this stateLock-guarded " +
                "field has no JMM publication guarantee: __warmIdentityToken()'s independently-launched " +
                "warm can observe a stale OFF (skipping the only warm — reports stay anonymous forever) or " +
                "a stale ON (invoking the customer's provider for a project where identity is actually " +
                "disabled, violating the round-6 identity.enabled gate). Do not remove @Volatile to make " +
                "this field \"look like\" the rest of the class's plain-var-plus-stateLock fields — those " +
                "are read ONLY from inside a stateLock.withLock block, everywhere; this one is not, which " +
                "is exactly why it needs its own visibility guarantee.",
            precedingWindow.contains("@Volatile"),
        )
    }
}
