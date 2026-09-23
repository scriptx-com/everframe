// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Spec 2026-09-17 setExtra-resolver — Android core half of the RN
// ask-and-wait round trip. `Everframe.__pendingExtraResolveHook` is the seam
// `consumePendingAttachments()` calls right before it drains pending
// attachments; the RN bridge module installs a real implementation there
// (`EverframeModule.awaitJsExtraResolve`, which this repo's own build cannot
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
package dev.everframe

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
        Everframe.__pendingExtraResolveHook = null
        Everframe.clearExtra()
    }

    @Test
    fun `no hook installed drains pending extra exactly as before this feature`() = runTest {
        Everframe.__pendingExtraResolveHook = null
        Everframe.setExtra("pre-existing value")

        val (extra, _) = Everframe.consumePendingAttachments()

        assertEquals("pre-existing value", extra)
    }

    @Test
    fun `a registered hook that answers in time updates the drained value`() = runTest {
        Everframe.setExtra("stale")
        Everframe.__pendingExtraResolveHook = {
            // Mirrors what the RN implementation does when JS answers: push
            // a fresh value through the ordinary setExtra() entry point
            // BEFORE the hook returns.
            Everframe.setExtra("fresh from resolver")
        }

        val (extra, _) = Everframe.consumePendingAttachments()

        assertEquals("fresh from resolver", extra)
    }

    @Test
    fun `a throwing hook fails open — the report still proceeds with whatever was already pending`() = runTest {
        Everframe.setExtra("still ships")
        Everframe.__pendingExtraResolveHook = {
            throw RuntimeException("resolver blew up")
        }

        val (extra, _) = Everframe.consumePendingAttachments()

        assertEquals("still ships", extra)
    }

    @Test
    fun `a hook that never resumes but bounds itself still lets consumePendingAttachments return promptly`() = runTest {
        Everframe.setExtra("unchanged — JS never answered")
        val jsNeverAnswers = CompletableDeferred<Unit>()
        Everframe.__pendingExtraResolveHook = {
            // Mirrors awaitJsExtraResolve's real shape exactly (a bounded
            // wait on a signal nobody ever completes), just with a much
            // shorter bound so the test stays fast.
            withTimeoutOrNull(20) { jsNeverAnswers.await() }
        }

        val (extra, _) = Everframe.consumePendingAttachments()

        // The wait honoured its own timeout — the hook returned instead of
        // hanging — and the report proceeds with the last pushed value.
        assertEquals("unchanged — JS never answered", extra)
        assertTrue("the never-completed deferred must still be incomplete", !jsNeverAnswers.isCompleted)
    }

    @Test
    fun `consumePendingAttachments still clears pending state exactly once regardless of the hook`() = runTest {
        Everframe.setExtra("only once")
        Everframe.__pendingExtraResolveHook = null

        val (first, _) = Everframe.consumePendingAttachments()
        val (second, _) = Everframe.consumePendingAttachments()

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
    // the other gets nil. `Everframe.consumePendingAttachments()`'s
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

        Everframe.setExtra("stale")
        Everframe.__pendingExtraResolveHook = {
            callCount += 1
            val callIndex = callCount
            hookEvents += "enter-$callIndex"
            if (callIndex == 1) {
                deferredA.await()
                Everframe.setExtra("from A")
            } else {
                deferredB.await()
                Everframe.setExtra("from B")
            }
            hookEvents += "exit-$callIndex"
        }

        val resultA = async { Everframe.consumePendingAttachments() }
        val resultB = async { Everframe.consumePendingAttachments() }

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

        Everframe.__pendingExtraResolveHook = {
            callCount += 1
            if (callCount == 1) {
                deferredA.await()
                Everframe.setExtra("A's value")
            } else {
                Everframe.setExtra("B's value")
            }
        }

        val resultA = async { Everframe.consumePendingAttachments() }
        val resultB = async { Everframe.consumePendingAttachments() }

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
        Everframe.setExtra("must survive cancellation")
        Everframe.__pendingExtraResolveHook = {
            // Suspends until cancelled — nothing ever completes this.
            jsNeverAnswers.await()
        }

        val job = launch { Everframe.consumePendingAttachments() }
        // Let the job actually reach the suspension point inside the hook.
        testScheduler.advanceUntilIdle()
        job.cancelAndJoin()

        // If `CancellationException` were swallowed (the pre-fix
        // `runCatching { hook() }` shape), execution would fall through to
        // `drainPendingAttachmentsLocked()` anyway, clearing `_pendingExtra`
        // for a report that was abandoned — and the NEXT report would then
        // see nothing. With the fix, cancellation propagates before the
        // drain runs, so the value is still here for a real subsequent call.
        Everframe.__pendingExtraResolveHook = null
        val (extra, _) = Everframe.consumePendingAttachments()

        assertEquals("must survive cancellation", extra)
    }
}
