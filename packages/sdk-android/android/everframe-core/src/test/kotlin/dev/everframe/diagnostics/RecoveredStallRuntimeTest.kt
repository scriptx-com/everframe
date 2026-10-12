// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.diagnostics

import dev.everframe.outbox.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class RecoveredStallRuntimeTest {
    @get:Rule val folder = TemporaryFolder()
    private class Session : RecoveredStallSession {
        var starts = 0; var closes = 0
        override val ready get() = starts > 0 && closes == 0
        override fun start() { starts++ }
        override fun close() { closes++ }
    }
    @Test fun `disabled or superseded enable never constructs a session`() {
        val owner = RecoveredStallOwner(); val old = owner.request(1, true)
        owner.request(1, false); val next = owner.request(1, true)
        var constructed = 0
        assertFalse(owner.enable(old, 1, { true }) { constructed++; Session() })
        assertEquals(0, constructed)
        val session = Session()
        assertTrue(owner.enable(next, 1, { true }) { session })
        assertEquals(1, session.starts); assertTrue(owner.ready(1)); assertFalse(owner.ready(2))
        owner.request(2, false); assertEquals(1, session.closes); assertFalse(owner.ready(1))
    }
    @Test fun `disable during construction closes the late session without starting it`() {
        val owner = RecoveredStallOwner(); val request = owner.request(1, true); val session = Session()
        assertFalse(owner.enable(request, 1, { true }) { owner.request(1, false); session })
        assertEquals(0, session.starts); assertEquals(1, session.closes)
        assertFalse(owner.ready(1))
    }
    @Test fun `duplicate opt-in does not replace an active observer and kill invalidates its gate`() {
        val owner = RecoveredStallOwner(); val request = owner.request(1, true); val session = Session()
        var gate: (() -> Boolean)? = null
        assertTrue(owner.enable(request, 1, { true }) { allowed -> gate = allowed; session })
        assertEquals(request, owner.request(1, true)); assertTrue(gate!!())
        assertTrue(owner.enable(request, 1, { true }) { error("must reuse existing owner") })
        owner.invalidate(); assertFalse(gate!!()); assertFalse(owner.ready(1)); assertEquals(1, session.closes)
    }
    @Test fun `live capture veto prevents install and admission even when opt-in request is unchanged`() {
        val owner = RecoveredStallOwner(); val request = owner.request(1, true)
        assertFalse(owner.enable(request, 1, { false }) { error("disabled capture") })
        var live = true; var gate: (() -> Boolean)? = null
        assertTrue(owner.enable(request, 1, { live }) { allowed -> gate = allowed; Session() })
        live = false; assertFalse(gate!!())
    }
    @Test fun `post-write consent revocation removes the pending report before admission returns`() {
        val owner = RecoveredStallOwner(); val request = owner.request(1, true)
        var gate: (() -> Boolean)? = null
        owner.enable(request, 1, { true }) { allowed -> gate = allowed; Session() }
        val ops = object : OutboxFileOps by JvmOutboxFileOps() {
            override fun syncFile(file: File) {
                JvmOutboxFileOps().syncFile(file)
                if (file.name.endsWith(".tmp")) owner.request(1, false)
            }
        }
        val store = OutboxStore(File(folder.root, "queue"), JceTestOutboxKeyProvider(), ops, 50, 64 * 1024 * 1024)
        val entry = recoveredStallEntry(template(), RecoveredStallObservation(1700000000000,1700000006000,6000), 24)
        try { store.enqueueSync(entry, object : OutboxAuthorization { override fun isAllowed() = gate!!() }); fail("revoked admission") }
        catch (_: OutboxWriteException) { }
        assertTrue(store.snapshotTokens().isEmpty())
    }
    @Test fun `accepted anonymous evidence preserves frozen bytes and route after observer disable`() {
        val owner = RecoveredStallOwner(); val request = owner.request(1, true); var gate: (() -> Boolean)? = null
        owner.enable(request, 1, { true }) { allowed -> gate = allowed; Session() }
        val store = OutboxStore(File(folder.root, "queue"), JceTestOutboxKeyProvider(), JvmOutboxFileOps(), 50, 64 * 1024 * 1024)
        val observation = RecoveredStallObservation(1700000000000,1700000006000,6000)
        val entry = recoveredStallEntry(template(), observation, 24)
        store.enqueueSync(entry, object : OutboxAuthorization { override fun isAllowed() = gate!!() })
        owner.request(1, false)
        val retained = store.readIfPresent(store.snapshotTokens().single())!!.entry
        assertArrayEquals(entry.envelopeBytes, retained.envelopeBytes); assertEquals("old-key", retained.sdkKey)
        assertEquals("https://old.example.test", retained.endpoint); assertNull(retained.identitySubject)
        val payload = Json.parseToJsonElement(retained.envelopeBytes.toString(Charsets.UTF_8)).jsonObject
        assertEquals("diagnostic", payload["source"]!!.jsonPrimitive.content)
        assertEquals(setOf("recoveredStall"), payload["payload"]!!.jsonObject.keys)
        assertNull(payload["sessionId"]); assertNull(payload["reporter"]!!.jsonObject["user"])
        assertEquals("recovered", payload["payload"]!!.jsonObject["recoveredStall"]!!.jsonObject["outcome"]!!.jsonPrimitive.content)
        assertTrue(store.hasCurrentLease())
    }
    @Test fun `every foreground screen debugger gate must pass`() {
        assertTrue(stallEligible(true, true, true, false, false))
        assertFalse(stallEligible(false, true, true, false, false))
        assertFalse(stallEligible(true, false, true, false, false))
        assertFalse(stallEligible(true, true, false, false, false))
        assertFalse(stallEligible(true, true, true, true, false))
        assertFalse(stallEligible(true, true, true, false, true))
    }
    private fun template() = OutboxEntry("template", 0,
        """{"reportId":"template","submittedAt":"old","sessionId":"private","reporter":{"user":{"id":"private"}},"payload":{"logs":["private"]},"context":{"app":{"version":"old-build"}},"attachments":[]}""".toByteArray(),
        "template", emptyList(), "old-key", "https://old.example.test", "private-subject")
}
