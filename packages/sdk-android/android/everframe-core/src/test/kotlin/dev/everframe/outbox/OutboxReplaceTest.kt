// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.outbox

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OutboxReplaceTest {
    @get:Rule val tmp = TemporaryFolder()
    private val keys = JceTestOutboxKeyProvider()
    private val allow = object : OutboxAuthorization { override fun isAllowed() = true }
    private fun sidecar() = CrashSidecar(File(tmp.root, "crash-outbox.jsonl"), keys, JvmOutboxFileOps())
    private fun stored() = runBlocking { JSONLOutbox(File(tmp.root, "outbox.jsonl"), keys, JvmOutboxFileOps()).hydrate() }

    @Test fun `replacement swaps the queued error for the same report`() {
        val original = entry("error-1")
        val token = sidecar().appendHandledSyncToken(original, allow)!!
        val upgraded = original.copy(envelopeBytes = "{\"replay\":true}".toByteArray(), idempotencyKey = "idem-upgraded")
        assertTrue(sidecar().replaceSync(token, upgraded, allow))
        assertEquals(listOf(upgraded), stored())
        assertFalse("the retired token is gone", sidecar().replaceSync(token, upgraded, allow))
    }

    @Test fun `revoked replacement keeps the original`() {
        val original = entry("error-2")
        val token = sidecar().appendHandledSyncToken(original, allow)!!
        val deny = object : OutboxAuthorization { override fun isAllowed() = false }
        assertFalse(sidecar().replaceSync(token, original.copy(idempotencyKey = "other"), deny))
        assertEquals(listOf(original), stored())
    }

    @Test fun `a different report can never replace an entry`() {
        val token = sidecar().appendHandledSyncToken(entry("error-3"), allow)!!
        assertFalse(sidecar().replaceSync(token, entry("someone-else"), allow))
        assertEquals(listOf("error-3"), stored().map { it.reportId })
    }
}
