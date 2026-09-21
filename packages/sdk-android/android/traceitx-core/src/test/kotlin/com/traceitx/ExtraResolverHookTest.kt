// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Spec 2026-09-17 setExtra-resolver — Android core half of the RN
// ask-and-wait round trip. `TraceItX.__pendingExtraResolveHook` is the seam
// `consumePendingAttachments()` calls right before it drains pending
// attachments; the RN bridge module installs a real implementation there
// (`TraceItXModule.awaitJsExtraResolve`, which this repo's own build cannot
// compile standalone — see the report). This file tests the CORE contract
// directly, with a fake hook standing in for the RN implementation:
//
//   1. No hook installed → drains exactly as before this feature landed.
//   2. A hook that updates `_pendingExtra` before returning → the drained
//      value reflects that update (a resolver "answered in time").
//   3. A hook that throws → consumePendingAttachments still returns
//      normally (fail open) with whatever was already pending.
//   4. A hook that never resumes internally, but is itself bounded by its
//      own short timeout (mirroring `awaitJsExtraResolve`'s real
//      `withTimeoutOrNull(250)` shape) → consumePendingAttachments still
//      returns promptly — the wait honours its timeout and proceeds when
//      "JS" is silent.
package com.traceitx

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ExtraResolverHookTest {

    @After
    fun resetHookAndPendingState() {
        // Reset ALL slots this feature touches so tests are order-independent
        // and don't leak into unrelated suites sharing this JVM/classloader.
        TraceItX.__pendingExtraResolveHook = null
        TraceItX.clearExtra()
    }

    @Test
    fun `no hook installed drains pending extra exactly as before this feature`() = runTest {
        TraceItX.__pendingExtraResolveHook = null
        TraceItX.setExtra("pre-existing value")

        val (extra, _) = TraceItX.consumePendingAttachments()

        assertEquals("pre-existing value", extra)
    }

    @Test
    fun `a registered hook that answers in time updates the drained value`() = runTest {
        TraceItX.setExtra("stale")
        TraceItX.__pendingExtraResolveHook = {
            // Mirrors what the RN implementation does when JS answers: push
            // a fresh value through the ordinary setExtra() entry point
            // BEFORE the hook returns.
            TraceItX.setExtra("fresh from resolver")
        }

        val (extra, _) = TraceItX.consumePendingAttachments()

        assertEquals("fresh from resolver", extra)
    }

    @Test
    fun `a throwing hook fails open — the report still proceeds with whatever was already pending`() = runTest {
        TraceItX.setExtra("still ships")
        TraceItX.__pendingExtraResolveHook = {
            throw RuntimeException("resolver blew up")
        }

        val (extra, _) = TraceItX.consumePendingAttachments()

        assertEquals("still ships", extra)
    }

    @Test
    fun `a hook that never resumes but bounds itself still lets consumePendingAttachments return promptly`() = runTest {
        TraceItX.setExtra("unchanged — JS never answered")
        val jsNeverAnswers = CompletableDeferred<Unit>()
        TraceItX.__pendingExtraResolveHook = {
            // Mirrors awaitJsExtraResolve's real shape exactly (a bounded
            // wait on a signal nobody ever completes), just with a much
            // shorter bound so the test stays fast.
            withTimeoutOrNull(20) { jsNeverAnswers.await() }
        }

        val (extra, _) = TraceItX.consumePendingAttachments()

        // The wait honoured its own timeout — the hook returned instead of
        // hanging — and the report proceeds with the last pushed value.
        assertEquals("unchanged — JS never answered", extra)
        assertTrue("the never-completed deferred must still be incomplete", !jsNeverAnswers.isCompleted)
    }

    @Test
    fun `consumePendingAttachments still clears pending state exactly once regardless of the hook`() = runTest {
        TraceItX.setExtra("only once")
        TraceItX.__pendingExtraResolveHook = null

        val (first, _) = TraceItX.consumePendingAttachments()
        val (second, _) = TraceItX.consumePendingAttachments()

        assertEquals("only once", first)
        assertNull(second)
    }

    // ---------------- Finding F5 — concurrent ask-and-wait + drain ----------------
    //
    // The "…ExactlyOnceRegardlessOfTheHook" test above sets the hook to null
    // and drains SEQUENTIALLY — the await is never in play, so it proves
    // nothing about what happens when two reports race a REAL suspending
    // hook. The reachable interleaving: reports A and B both suspend in the
    // hook → JS answers A (`setExtra(X)`) then B (`setExtra(Y)`, overwriting
    // X) → without serialization, whichever drains first gets Y (not X) and
    // the other gets nil. `TraceItX.consumePendingAttachments()`'s
    // `extraResolveSerializer` (a `Mutex`) fixes this by construction: at
    // most one ask-and-wait + drain sequence is ever in flight, so B's hook
    // cannot even START until A's drain has completed and released the lock.
    // These tests exercise that directly with `runTest`'s deterministic
    // virtual-time scheduler — not a fake sequential drain.

    @Test
    fun `two concurrent consumePendingAttachments calls are serialized — B's hook does not start until A's whole ask-and-wait and drain finish`() = runTest {
        val hookEvents = mutableListOf<String>()
        val deferredA = CompletableDeferred<Unit>()
        val deferredB = CompletableDeferred<Unit>()
        var callCount = 0

        TraceItX.setExtra("stale")
        TraceItX.__pendingExtraResolveHook = {
            callCount += 1
            val callIndex = callCount
            hookEvents += "enter-$callIndex"
            if (callIndex == 1) {
                deferredA.await()
                TraceItX.setExtra("from A")
            } else {
                deferredB.await()
                TraceItX.setExtra("from B")
            }
            hookEvents += "exit-$callIndex"
        }

        val resultA = async { TraceItX.consumePendingAttachments() }
        val resultB = async { TraceItX.consumePendingAttachments() }

        // Let both coroutines run as far as they can WITHOUT JS answering
        // either one yet. If the two calls were NOT serialized, B's hook
        // would already have entered here (both would suspend inside the
        // hook concurrently, which is exactly the race this fix closes).
        testScheduler.advanceUntilIdle()
        assertEquals(
            "B's hook must not start while A's ask-and-wait + drain is still in flight",
            listOf("enter-1"),
            hookEvents,
        )

        // JS answers A. A's hook returns, A drains (reading "from A" — the
        // value ITS OWN call caused JS to push), and only THEN does the
        // serializer let B's hook start.
        deferredA.complete(Unit)
        testScheduler.advanceUntilIdle()
        assertEquals(
            "A must finish (hook return + drain) before B's hook starts",
            listOf("enter-1", "exit-1", "enter-2"),
            hookEvents,
        )

        // JS answers B.
        deferredB.complete(Unit)
        testScheduler.advanceUntilIdle()

        val (extraA, _) = resultA.await()
        val (extraB, _) = resultB.await()

        // Each call drains exactly the value ITS OWN resolve round trip
        // caused JS to push — not the other call's, and not nil. Before the
        // serializer fix, this is where B's overwrite of `_pendingExtra`
        // (before A's drain read it) could make A observe "from B" instead
        // of "from A", or make B observe nil because A already cleared the
        // slot.
        assertEquals("from A", extraA)
        assertEquals("from B", extraB)
    }

    @Test
    fun `a slow hook does not block report B from eventually shipping — it just serializes after A`() = runTest {
        val deferredA = CompletableDeferred<Unit>()
        var callCount = 0

        TraceItX.__pendingExtraResolveHook = {
            callCount += 1
            if (callCount == 1) {
                deferredA.await()
                TraceItX.setExtra("A's value")
            } else {
                TraceItX.setExtra("B's value")
            }
        }

        val resultA = async { TraceItX.consumePendingAttachments() }
        val resultB = async { TraceItX.consumePendingAttachments() }

        deferredA.complete(Unit)
        val (extraA, _) = resultA.await()
        val (extraB, _) = resultB.await()

        assertEquals("A's value", extraA)
        assertEquals("B's value", extraB)
    }

    // ---------------- Finding F6 — CancellationException must not be swallowed ----------------

    @Test
    fun `cancelling the report coroutine while suspended in the hook does not drain pending state for the next report`() = runTest {
        val jsNeverAnswers = CompletableDeferred<Unit>()
        TraceItX.setExtra("must survive cancellation")
        TraceItX.__pendingExtraResolveHook = {
            // Suspends until cancelled — nothing ever completes this.
            jsNeverAnswers.await()
        }

        val job = launch { TraceItX.consumePendingAttachments() }
        // Let the job actually reach the suspension point inside the hook.
        testScheduler.advanceUntilIdle()
        job.cancelAndJoin()

        // If `CancellationException` were swallowed (the pre-fix
        // `runCatching { hook() }` shape), execution would fall through to
        // `drainPendingAttachmentsLocked()` anyway, clearing `_pendingExtra`
        // for a report that was abandoned — and the NEXT report would then
        // see nothing. With the fix, cancellation propagates before the
        // drain runs, so the value is still here for a real subsequent call.
        TraceItX.__pendingExtraResolveHook = null
        val (extra, _) = TraceItX.consumePendingAttachments()

        assertEquals("must survive cancellation", extra)
    }
}
