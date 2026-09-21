// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.traceitx.outbox

import android.content.Context
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** API matrix with real encrypted files and a host JCE key provider, not Android Keystore acceptance. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 25, 35])
class CrashSidecarApiTest {
    @get:Rule val tmp = TemporaryFolder()
    private val keys = JceTestOutboxKeyProvider()
    private fun entry(id: String) = OutboxEntry(id, 1L, "{}".toByteArray(), "k-$id", emptyList(), "key", "https://test.example.com")

    @Test fun `public descriptors retain Unit append and separate acceptance`() {
        assertNotNull(CrashSidecar::class.java.getConstructor(File::class.java))
        assertNotNull(CrashSidecar::class.java.getConstructor(Context::class.java))
        assertEquals(Void.TYPE, CrashSidecar::class.java.getMethod("appendSync", OutboxEntry::class.java).returnType)
        assertEquals(Boolean::class.javaPrimitiveType, CrashSidecar::class.java.getMethod("appendSyncAccepted", OutboxEntry::class.java).returnType)
    }

    @Test fun `accepted writes reopen encrypted with no sidecar transfer`() = runBlocking {
        val file = File(tmp.root, "crash-outbox.jsonl")
        val sidecar = CrashSidecar(file, keys, JvmOutboxFileOps())
        assertTrue(sidecar.appendSyncAccepted(entry("first")))
        sidecar.appendSync(entry("second"))
        val reopened = JSONLOutbox(File(tmp.root, "outbox.jsonl"), keys, JvmOutboxFileOps())
        assertEquals(0, sidecar.hydrateInto(reopened))
        assertEquals(setOf("first", "second"), reopened.hydrate().map { it.reportId }.toSet())
        assertFalse(file.exists())
    }

    @Test fun `failed sync rejects without losing previous encrypted acceptance`() = runBlocking {
        val file = File(tmp.root, "crash-outbox.jsonl")
        assertTrue(CrashSidecar(file, keys, JvmOutboxFileOps()).appendSyncAccepted(entry("accepted")))
        val failing = object : OutboxFileOps by JvmOutboxFileOps() {
            override fun syncFile(file: File) { throw java.io.IOException("failed") }
        }
        assertFalse(CrashSidecar(file, keys, failing).appendSyncAccepted(entry("rejected")))
        assertEquals(listOf("accepted"), JSONLOutbox(File(tmp.root, "outbox.jsonl"), keys, JvmOutboxFileOps()).hydrate().map { it.reportId })
        assertFalse(file.exists())
    }
}
