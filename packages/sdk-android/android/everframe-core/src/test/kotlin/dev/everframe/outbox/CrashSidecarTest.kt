// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.outbox

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class CrashSidecarTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private var timestamp = 0L

    private fun makeEntry(id: String) = OutboxEntry(
        reportId = id,
        createdAt = ++timestamp,
        envelopeBytes = "{\"reportId\":\"$id\"}".toByteArray(),
        idempotencyKey = "k-$id",
        attachmentRefs = emptyList(),
        sdkKey = "test-key",
        endpoint = "https://test.example.com",
    )

    private fun sidecarFile() = File(tmp.newFolder("dev.everframe"), "crash-outbox.jsonl")

    private val keys = JceTestOutboxKeyProvider()
    private fun sidecar(file: File, capacity: Int = 50, ops: OutboxFileOps = JvmOutboxFileOps()) =
        CrashSidecar(file, keys, ops, capacity)
    private fun outbox(file: File) = JSONLOutbox(File(file.parentFile, "outbox.jsonl"), keys, JvmOutboxFileOps())

    @Test fun `crash append reopens encrypted exact entry without migration`() = runBlocking {
        val file = sidecarFile()
        val original = makeEntry("sensitive").copy(identitySubject = "captured-person")
        sidecar(file).appendSync(original)
        assertFalse(file.exists())
        assertEquals(listOf(original), outbox(file).hydrate())
        assertEquals(0, sidecar(file).hydrateInto(outbox(file)))
        val bytes = File(file.parentFile, "outbox.jsonl.encrypted").walkTopDown()
            .filter { it.isFile }.flatMap { it.readBytes().asSequence() }.toList().toByteArray()
        assertFalse(String(bytes).contains("sensitive"))
        assertFalse(String(bytes).contains("captured-person"))
    }

    @Test fun `crash capacity retains accepted oldest entries`() = runBlocking {
        val file = sidecarFile()
        val crash = sidecar(file, 3)
        for (i in 1..4) crash.appendSync(makeEntry("r-$i"))
        assertEquals(listOf("r-1", "r-2", "r-3"), outbox(file).hydrate().map { it.reportId })
        assertFalse(file.exists())
    }

    @Test fun `crash capacity shares normal report quota`() = runBlocking {
        val file = sidecarFile()
        val box = outbox(file)
        box.enqueue(makeEntry("normal"))
        sidecar(file, 1).appendSync(makeEntry("crash"))
        assertEquals(listOf("normal"), box.hydrate().map { it.reportId })
    }

    @Test fun `failed encryption is never accepted or written plaintext`() = runBlocking {
        val file = sidecarFile()
        val broken = object : OutboxKeyProvider by keys {
            override fun createGeneration(generation: String): javax.crypto.SecretKey = error("unavailable")
        }
        CrashSidecar(file, broken, JvmOutboxFileOps()).appendSync(makeEntry("lost"))
        assertFalse(file.exists())
        assertEquals(0, outbox(file).count())
    }

    @Test fun `crash admission rejects coordinator contention without waiting`() {
        val file = sidecarFile()
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val ops = object : OutboxFileOps by JvmOutboxFileOps() {
            override fun syncFile(file: File) {
                if (file.extension == "tmp") { entered.countDown(); check(release.await(5, java.util.concurrent.TimeUnit.SECONDS)) }
                JvmOutboxFileOps().syncFile(file)
            }
        }
        val writer = java.util.concurrent.Executors.newSingleThreadExecutor()
        try {
            val write = writer.submit { sidecar(file, ops = ops).appendSync(makeEntry("normal")) }
            org.junit.Assert.assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
            val crash = java.util.concurrent.Executors.newSingleThreadExecutor()
            try { crash.submit { sidecar(file).appendSync(makeEntry("rejected")) }.get(1, java.util.concurrent.TimeUnit.SECONDS) }
            finally { crash.shutdownNow(); release.countDown() }
            write.get(5, java.util.concurrent.TimeUnit.SECONDS)
            assertEquals(listOf("normal"), runBlocking { outbox(file).hydrate() }.map { it.reportId })
        } finally { release.countDown(); writer.shutdownNow() }
    }

    @Test fun `crash captured before kill cannot enter freshly constructed facade`() = runBlocking {
        val file = sidecarFile()
        dev.everframe.Everframe.captureGate = true
        val captured = dev.everframe.Everframe.captureSessionSnapshot()
        val permission = object : OutboxAuthorization {
            override fun isAllowed() = dev.everframe.Everframe.captureGate &&
                !dev.everframe.Everframe.killGenerationChangedVolatile(captured.killGeneration)
        }
        dev.everframe.Everframe.kill()
        dev.everframe.Everframe.captureGate = true
        sidecar(file).appendSync(makeEntry("old"), permission)
        assertEquals(0, outbox(file).count())
        sidecar(file).appendSync(makeEntry("fresh"))
        assertEquals(1, outbox(file).count())
        dev.everframe.Everframe.captureGate = false
    }

    @Test fun `legacy hydration remains separate from new encrypted appends`() = runBlocking {
        val file = sidecarFile()
        file.writeText(kotlinx.serialization.json.Json.encodeToString(OutboxEntry.serializer(), makeEntry("legacy")) + "\nNOT-JSON\n")
        val original = file.readBytes()
        assertEquals(1, sidecar(file).hydrateInto(outbox(file)))
        org.junit.Assert.assertArrayEquals(original, file.readBytes())
        outbox(file).drain { true }
        assertEquals(0, sidecar(file).hydrateInto(outbox(file)))
        assertEquals(0, outbox(file).count())
        org.junit.Assert.assertArrayEquals(original, file.readBytes())
    }
}
