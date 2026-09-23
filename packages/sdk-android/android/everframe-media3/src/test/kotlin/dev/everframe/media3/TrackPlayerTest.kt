// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.media3

import androidx.media3.common.util.UnstableApi
import dev.everframe.vitals.PlayerHandle
import dev.everframe.vitals.PlayerIntegration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TrackPlayerTest {
    /**
     * Codex round-7, #3 — stands in for `VitalsRuntime.DeferredPlayerHandle`,
     * the handle `Everframe.trackPlayer` returns while no controller is
     * installed. The real one is `internal` to :everframe-core and Kotlin's
     * `internal` is MODULE-scoped, so it is invisible from this module (the
     * same reason `Media3Integration` cannot call core's `InternalLogger`).
     * What matters here is its pre-drain contract, reproduced exactly: a
     * `detach()` before a real delegate arrives marks [detachedEarly], which
     * is what makes the drain skip the registration instead of attaching a
     * player the caller has already given up on.
     *
     * Codex round-8, #1 — and it now releases the INTEGRATION as well, which
     * is what the real handle's `onCancel` does (`VitalsRuntime.trackPlayer`
     * wires it, `VitalsRuntime.releasePending` does the same for a revoked
     * entry). Reproducing that here is the point: the declaration-time
     * release observer must come off through `PlayerIntegration.detach()`,
     * the one call every teardown path makes, and not through a handle
     * wrapper only the caller reaches.
     */
    private class FakeDeferredHandle : PlayerHandle {
        var integration: PlayerIntegration? = null
        var detachedEarly = false
            private set
        override val id = ""
        override fun track(name: String, data: Any?) = Unit
        override fun detach() {
            detachedEarly = true
            integration?.detach()
        }
    }

    @Test
    fun `builds a Media3Integration, registers it, and release detaches through the handle`() {
        val facade = FakeFacade()
        var registered: PlayerIntegration? = null
        var detached = 0
        val handle = object : PlayerHandle {
            override val id = "p7"
            override fun track(name: String, data: Any?) {}
            override fun detach() { detached++ }
        }
        val h = trackPlayerWith(facade, "main", register = { i, n -> registered = i; assertEquals("main", n); i.attach(RecordingContext { 0L }); handle }, captureSourceQuery = { false }, post = { it.run(); true })
        // Codex round-8, #1: `register`'s handle, returned DIRECTLY. Round 7's
        // wrapper — which existed only to take the release observer off — is
        // gone; the integration owns that observer now.
        assertSame("the registered handle is returned unwrapped", handle, h)
        assertEquals("p7", h.id)
        assertEquals("media3", registered!!.library)
        facade.listener!!.onPlayerReleased(eventTime())
        assertEquals(1, detached)
    }

    // ---- Codex round-7, #3: a pending player self-detaches on release ----

    @Test
    fun `a player released before start detaches its pending registration`() {
        // `trackPlayer(exoPlayer)` before `start()` only QUEUES the
        // registration, so `Media3Integration.attach()` — and with it the
        // listener that invokes `onReleased` — has never run. Releasing the
        // player therefore reached nobody, and the deferred handle held the
        // released ExoPlayer until a `start()` that may never come; every
        // repeated declaration added another. The declaration-time observer is
        // what notices.
        val facade = FakeFacade()
        val deferred = FakeDeferredHandle()
        trackPlayerWith(facade, null, register = { i, _ -> deferred.integration = i; deferred }, captureSourceQuery = { false }, post = { it.run(); true })

        assertNotNull("the release observer is installed even though attach() never ran", facade.listener)
        facade.listener!!.onPlayerReleased(eventTime())

        assertTrue("the pending registration is cancelled by the release", deferred.detachedEarly)
        assertNull("...and the observer takes itself off the player", facade.listener)
    }

    @Test
    fun `a normal detach removes the release observer too`() {
        val facade = FakeFacade()
        val deferred = FakeDeferredHandle()
        val h = trackPlayerWith(facade, null, register = { i, _ -> deferred.integration = i; deferred }, captureSourceQuery = { false }, post = { it.run(); true })
        assertNotNull(facade.listener)

        h.detach()

        assertTrue(deferred.detachedEarly)
        assertNull("a caller-driven detach must not leave the observer subscribed", facade.listener)
    }

    // ---- Codex round-8, #1: the observer's lifetime is the integration's ----

    @Test
    fun `a teardown that bypasses the handle still removes the release observer`() {
        // THE finding. `kill()`, a superseding `start()`, a revoked or
        // cancelled pending registration all end a declaration by calling
        // `PlayerIntegration.detach()` directly — never the handle
        // `trackPlayer()` returned. Round 7 removed the observer in a wrapper
        // around that handle, so every one of those teardowns left one more
        // observer on a long-lived ExoPlayer, retaining the dead controller
        // behind it.
        val facade = FakeFacade()
        var integration: PlayerIntegration? = null
        trackPlayerWith(
            facade,
            null,
            register = { i, _ -> integration = i; FakeDeferredHandle() },
            captureSourceQuery = { false },
            post = { it.run(); true },
        )
        assertEquals("precondition: the declaration subscribed exactly one observer", 1, facade.listeners.size)

        // Exactly what VitalsRuntime does for a revoked pending entry: the
        // integration never attached, and the handle is not involved at all.
        integration!!.detach()

        assertEquals("a controller-driven teardown must leave the player clean", 0, facade.listeners.size)
    }

    @Test
    fun `an attached player torn down through the integration leaves no listener behind`() {
        // The same path once the registration HAS been drained into a
        // controller: `VitalsController.shutdown()` detaches every
        // integration, and both subscriptions — the declaration observer and
        // the integration's own analytics listener — must come off together.
        val facade = FakeFacade()
        var integration: PlayerIntegration? = null
        trackPlayerWith(
            facade,
            null,
            register = { i, _ -> integration = i; i.attach(RecordingContext { 0L }); FakeDeferredHandle() },
            captureSourceQuery = { false },
            post = { it.run(); true },
        )
        assertEquals("precondition: observer + analytics listener", 2, facade.listeners.size)

        integration!!.detach()

        assertEquals(0, facade.listeners.size)
    }

    @Test
    fun `the release observer is installed only once however often it is asked for`() {
        val facade = FakeFacade()
        trackPlayerWith(facade, null, register = { i, _ -> (i as Media3Integration).observeRelease(); FakeDeferredHandle() }, captureSourceQuery = { false }, post = { it.run(); true })
        assertEquals(1, facade.listeners.size)
    }

    @Test
    fun `a rejected observer subscription detaches the declaration instead of leaving it unobserved`() {
        // `post` answers false once the looper is quitting — the player is
        // already unusable, and nothing will ever come to unregister it.
        val facade = FakeFacade()
        val deferred = FakeDeferredHandle()
        trackPlayerWith(facade, null, register = { i, _ -> deferred.integration = i; deferred }, captureSourceQuery = { false }, post = { false })

        assertNull(facade.listener)
        assertTrue(deferred.detachedEarly)
    }
}
