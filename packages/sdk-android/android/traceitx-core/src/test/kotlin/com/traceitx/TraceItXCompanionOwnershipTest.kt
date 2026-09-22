// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// External review (naming-native branch), finding NN1 — the companion client
// used to have TWO independent owners: this core facade's own
// `_companionClient` and a completely separate field on the RN bridge's
// `TraceItXModule` (`:sdk-react-native`, a separate Gradle module). A hybrid
// host embedding both could construct and START two live `RelayWSClient`s
// racing over the same process-global `Companion` StateFlow object, and even
// a single caller's own "check then set" was two statements, not one.
//
// `TraceItX.__registerCompanionClient` / `__unregisterCompanionClient` are
// the fix: a single `@Synchronized` check-create-store pair that both this
// facade's `startCompanionInternal`/`stopCompanion` AND `TraceItXModule`
// route every registration through — first caller wins.
//
// This file covers the pure bookkeeping semantics of the two seams and
// `startCompanionInternal`'s use of them, all from THIS module (no real
// network — every client here is either never started, or discarded before
// `client.start()` is ever reached). The cross-module "RN loses to an
// already-started native facade" scenario lives on the OTHER side, in
// `:sdk-react-native`'s own `TraceItXCompanionOwnershipTest.kt` — this module
// cannot reach `TraceItXModule` (dependency runs the other way), so the two
// halves cannot live in one file.
package com.traceitx

import com.traceitx.companion.RelayWSClient
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class TraceItXCompanionOwnershipTest {

    private fun newClient(): RelayWSClient = RelayWSClient(client = OkHttpClient())

    @After
    fun tearDown() {
        TraceItX.__resetCompanionClientForTesting()
    }

    @Test
    fun registerCompanionClient_firstCallerWins_secondIsRejected() {
        val a = newClient()
        val b = newClient()

        assertTrue("the first caller must claim the slot", TraceItX.__registerCompanionClient(a))
        assertFalse(
            "a second caller must be rejected while a client is live",
            TraceItX.__registerCompanionClient(b),
        )
        assertSame("the slot must still hold the FIRST client", a, TraceItX.companionClientForTesting())
    }

    @Test
    fun unregisterCompanionClient_withADifferentClient_isANoOp() {
        val a = newClient()
        val b = newClient()
        TraceItX.__registerCompanionClient(a)

        TraceItX.__unregisterCompanionClient(b)

        assertSame(
            "unregistering a client that isn't the stored one must not clear the slot",
            a,
            TraceItX.companionClientForTesting(),
        )
        assertFalse(
            "the slot is still held — a new caller must still be rejected",
            TraceItX.__registerCompanionClient(b),
        )
    }

    @Test
    fun unregisterCompanionClient_withTheStoredClient_clearsTheSlot() {
        val a = newClient()
        TraceItX.__registerCompanionClient(a)

        TraceItX.__unregisterCompanionClient(a)

        assertNull(
            "the slot must be empty after unregistering the stored client",
            TraceItX.companionClientForTesting(),
        )
        val b = newClient()
        assertTrue(
            "a fresh caller must be able to claim the now-empty slot",
            TraceItX.__registerCompanionClient(b),
        )
    }

    /**
     * The concurrency guarantee itself: N threads all racing to be "the"
     * companion client — exactly what N concurrent `start()` attempts (native
     * facade and/or RN, in any combination) funnel into. Exactly one must
     * win, regardless of interleaving.
     */
    @Test
    fun concurrentRegisterCompanionClient_yieldsExactlyOneWinner() {
        val threadCount = 16
        val pool = Executors.newFixedThreadPool(threadCount)
        val ready = CountDownLatch(threadCount)
        val go = CountDownLatch(1)
        val winners = AtomicInteger(0)
        val clients = (0 until threadCount).map { newClient() }

        try {
            val futures = clients.map { client ->
                pool.submit {
                    ready.countDown()
                    go.await()
                    if (TraceItX.__registerCompanionClient(client)) winners.incrementAndGet()
                }
            }
            ready.await(5, TimeUnit.SECONDS)
            go.countDown()
            futures.forEach { it.get(5, TimeUnit.SECONDS) }
        } finally {
            pool.shutdown()
        }

        assertEquals("exactly one concurrent registration attempt must win", 1, winners.get())
        val registered = TraceItX.companionClientForTesting()
        assertTrue(
            "the winning client must be one of the constructed clients",
            clients.any { it === registered },
        )
    }

    @Test
    fun startCompanionInternal_whenAnotherCallerAlreadyRegistered_returnsTheExistingClientWithoutTouchingIt() {
        val existing = newClient()
        TraceItX.__registerCompanionClient(existing)

        val result = TraceItX.startCompanionInternal(
            context = androidx.test.core.app.ApplicationProvider.getApplicationContext(),
            config = null,
        )

        assertSame(
            "a caller landing after another already registered must get back the existing client, never a new one",
            existing,
            result,
        )
        assertSame(
            "the slot must still hold the original client",
            existing,
            TraceItX.companionClientForTesting(),
        )
    }
}
