// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.vitals

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemotePlayerRegistryTest {
    private class FakeHandle(override val id: String) : PlayerHandle {
        val tracked = mutableListOf<Pair<String, Any?>>(); var detached = 0
        override fun track(name: String, data: Any?) { tracked += name to data }
        override fun detach() { detached++ }
    }

    private val registered = mutableListOf<Pair<PlayerIntegration, String?>>()
    private val handles = mutableListOf<FakeHandle>()
    private val sessionLines = mutableListOf<Pair<String, Any?>>()
    private val registry = RemotePlayerRegistry(
        register = { i, n -> registered += i to n; FakeHandle("p${handles.size + 1}").also { handles += it } },
        sessionTrack = { n, d -> sessionLines += n to d },
        captureSourceQuery = { false },
    )

    @Test fun `track registers a RemotePlayerIntegration with library, version and name`() {
        assertTrue(registry.track("rp1", "theoplayer", "main", "9.0"))
        val (integration, name) = registered.single()
        assertEquals("main", name); assertEquals("theoplayer", integration.library); assertEquals("9.0", integration.version)
    }

    @Test fun `duplicate live token is ignored`() {
        registry.track("rp1", "a", null, null)
        assertFalse(registry.track("rp1", "b", null, null)); assertEquals(1, registered.size)
    }

    @Test fun `detach calls the handle and frees the token — unknown token is a no-op`() {
        registry.track("rp1", "a", null, null)
        assertTrue(registry.detach("rp1")); assertEquals(1, handles[0].detached)
        assertFalse(registry.detach("rp1")); assertFalse(registry.detach("nope"))
        assertTrue(registry.track("rp1", "a", null, null))   // token reusable after detach
    }

    /**
     * `detachAll` is what the RN module calls on instance teardown (a Metro /
     * OTA reload). Every handle is detached exactly ONCE (so each open
     * play/buffer span closes once, not twice) and a second call is a no-op.
     *
     * Codex round-1, C5 — and the teardown is TERMINAL: the tokens do NOT
     * become re-trackable. This registry belongs to one module instance, and
     * the reload builds a NEW instance with a NEW registry for the new bundle,
     * so anything still calling this one is code from the dead bundle.
     * (Before C5 this test asserted the opposite — re-trackable tokens — which
     * is the expectation the ruling changed.)
     */
    @Test fun `detachAll detaches every handle once, is idempotent, and closes the registry for good`() {
        registry.track("rp1", "a", null, null)
        registry.track("rp2", "b", null, null)
        assertEquals(2, handles.size)

        registry.detachAll()
        assertEquals(1, handles[0].detached)
        assertEquals(1, handles[1].detached)

        // Terminal: neither token comes back, and nothing new registers.
        assertFalse(registry.track("rp1", "a", null, null))
        assertFalse(registry.track("rp3", "c", null, null))
        assertEquals(2, registered.size)

        // Idempotent — and it does not re-detach the handles it already closed.
        registry.detachAll()
        registry.detachAll()
        assertEquals(2, handles.size)
        handles.forEach { assertEquals(1, it.detached) }
    }

    /**
     * EVERY host-facing entry point no-ops once closed, `trackVitals` included.
     *
     * Codex round-8, J1 — this used to let a custom line fall through to `sessionTrack`
     * (session-scoped by nature, no player to attribute it to). But `sessionTrack` is
     * process-global: a line arriving through a torn-down module — the old bundle's
     * unsubscribed listener, a queued callback — landed in the session a NEWER instance
     * had since started. It is now dropped, with and without a token. (The unknown-token
     * fallback while the registry is OPEN is unchanged; see the routing test below.)
     */
    @Test fun `after detachAll every entry point no-ops, trackVitals included`() {
        registry.track("rp1", "a", null, null)
        registry.detachAll()
        assertFalse(registry.track("rp2", "b", null, null))
        assertFalse(registry.record("rp1", "play", 1.757e12, null))
        assertFalse(registry.updateStats("rp1", mapOf("bufferAheadMs" to 1.0)))
        assertFalse(registry.detach("rp1"))
        registry.trackVitals("x", "1", "rp1")
        registry.trackVitals("y", "1", null)
        assertTrue(sessionLines.isEmpty())                          // neither form reaches the live session
        assertTrue(handles.single().tracked.isEmpty())              // the dead handle got nothing
    }

    /**
     * Codex round-1, C5 — `register()` runs OUTSIDE the lock, so a `detachAll()` on
     * another thread can land in the middle of a `track()`. A register callback that
     * calls `detachAll()` itself drives that interleaving deterministically: the
     * in-flight registration must be REFUSED, its handle detached, and the map left empty
     * — otherwise it survives the teardown that was meant to end it.
     */
    @Test fun `a detachAll during register refuses the in-flight registration and detaches its handle`() {
        lateinit var reg: RemotePlayerRegistry
        val made = mutableListOf<FakeHandle>()
        reg = RemotePlayerRegistry(
            register = { _, _ -> reg.detachAll(); FakeHandle("p${made.size + 1}").also { made += it } },
            sessionTrack = { _, _ -> },
            captureSourceQuery = { false },
        )
        assertFalse(reg.track("rp1", "a", null, null))
        assertEquals(1, made.single().detached)
        assertFalse(reg.detach("rp1"))                             // nothing was ever published
        assertFalse(reg.record("rp1", "play", 1.757e12, null))
    }

    @Test fun `record and updateStats route to the integration and refuse unknown tokens`() {
        registry.track("rp1", "a", null, null)
        val i = registered.single().first as RemotePlayerIntegration
        val ctx = object : PlayerIntegrationContext {
            val types = mutableListOf<String>()
            override fun emit(type: String, data: Map<String, Any?>?, t: Long?): Boolean { types += type; return true }
            override fun now() = 0L
        }
        i.attach(ctx)
        assertTrue(registry.record("rp1", "play", 1.757e12, null)); assertEquals(listOf("play"), ctx.types)
        assertFalse(registry.record("zz", "play", 1.757e12, null))
        assertTrue(registry.updateStats("rp1", mapOf("bufferAheadMs" to 5.0))); assertFalse(registry.updateStats("zz", emptyMap()))
    }

    @Test fun `record drops a non-finite or negative timestamp`() {
        registry.track("rp1", "a", null, null)
        assertFalse(registry.record("rp1", "play", Double.NaN, null))
        assertFalse(registry.record("rp1", "play", -1.0, null))
        assertFalse(registry.record("rp1", "play", 1e300, null))
    }

    @Test fun `trackVitals parses JSON and routes through the handle or the session`() {
        registry.track("rp1", "a", null, null)
        registry.trackVitals("ad", """{"id":7}""", "rp1")
        assertEquals("ad", handles[0].tracked.single().first)
        registry.trackVitals("cdn", "[1,2]", null)
        assertEquals("cdn", sessionLines.single().first)
        registry.trackVitals("x", "not json", "rp1")   // unparseable → recorded without data
        assertNull(handles[0].tracked[1].second)
        registry.trackVitals("y", "1", "gone")          // unknown token → session-scoped
        assertEquals("y", sessionLines[1].first)
    }

    @Test fun `MAX_TOKENS bounds the live set`() {
        repeat(RemotePlayerRegistry.MAX_TOKENS) { assertTrue(registry.track("t$it", "a", null, null)) }
        assertFalse(registry.track("overflow", "a", null, null))
    }

    @Test fun `safeEpochMs`() {
        assertEquals(1_757_000_000_000L, RemotePlayerRegistry.safeEpochMs(1.757e12))
        assertNull(RemotePlayerRegistry.safeEpochMs(Double.NaN)); assertNull(RemotePlayerRegistry.safeEpochMs(-1.0))
        assertNull(RemotePlayerRegistry.safeEpochMs(9.3e18))
    }
}
