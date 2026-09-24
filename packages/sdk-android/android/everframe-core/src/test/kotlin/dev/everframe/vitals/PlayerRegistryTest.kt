// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.vitals

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PlayerRegistryTest {
    private class NoopIntegration : PlayerIntegration {
        override val library = "fake"; override val version: String? = null
        override fun attach(ctx: PlayerIntegrationContext) = true
        override fun snapshot(onResult: (PlayerSnapshot?) -> Boolean) { onResult(null) }
        override fun startupTimings(): StartupTimings? = null
        override fun describe(ctx: PlayerIntegrationContext) {}
        override fun detach() {}
    }

    private fun PlayerRegistry.registerNow(i: PlayerIntegration, name: String?) =
        reserve(i, name).also { publish(it) }

    @Test
    fun `a reserved registration is invisible until it is published`() {
        // Codex round-1, Important 2: the id is minted before attach() runs,
        // but nothing may see the registration until attach() has succeeded.
        val r = PlayerRegistry()
        val a = r.reserve(NoopIntegration(), "main")
        assertEquals("p1", a.id)
        assertEquals(emptyList<String>(), r.live().map { it.id })
        assertEquals(false, r.isLive(a.token))
        r.publish(a)
        assertEquals(listOf("p1"), r.live().map { it.id })
        assertEquals(true, r.isLive(a.token))
    }

    @Test
    fun `mints ids in attach order and never reuses them`() {
        val r = PlayerRegistry()
        val a = r.registerNow(NoopIntegration(), "main"); val b = r.registerNow(NoopIntegration(), null)
        assertEquals(listOf("p1", "p2"), listOf(a.id, b.id))
        r.unregister(a.token)
        assertEquals("p3", r.registerNow(NoopIntegration(), null).id)
        assertEquals(listOf("p2", "p3"), r.live().map { it.id })
    }

    @Test
    fun `unregister is idempotent and a stale token cannot remove a later registration`() {
        val r = PlayerRegistry()
        val a = r.registerNow(NoopIntegration(), null)
        assertEquals(a, r.unregister(a.token)); assertNull(r.unregister(a.token))
        val b = r.registerNow(NoopIntegration(), null)
        assertNull(r.unregister(a.token))
        assertEquals(listOf(b.id), r.live().map { it.id })
    }

    @Test
    fun `clear returns what was live and keeps the id counter`() {
        val r = PlayerRegistry()
        r.registerNow(NoopIntegration(), null)
        assertEquals(1, r.clear().size); assertEquals(0, r.live().size)
        assertEquals("p2", r.registerNow(NoopIntegration(), null).id)
    }

    @Test
    fun `name is cut to 64 chars`() {
        assertEquals(64, PlayerRegistry().reserve(NoopIntegration(), "n".repeat(100)).name!!.length)
    }
}
