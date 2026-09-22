// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.outbox

import android.content.Context
import android.content.ContextWrapper
import android.graphics.Bitmap
import androidx.test.core.app.ApplicationProvider
import androidx.test.filters.SdkSuppress
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.traceitx.transport.MultipartUploader
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.ByteString.Companion.toByteString
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Real Android Keystore and Os operations. No fake crypto/filesystem in this platform proof. */
@RunWith(AndroidJUnit4::class)
class EncryptedOutboxInstrumentedTest {
    private lateinit var isolated: File
    private lateinit var app: Context
    private val generations = mutableSetOf<String>()
    private val allowed = object : OutboxAuthorization { override fun isAllowed() = true }
    private val root get() = File(context().noBackupFilesDir, "com.traceitx/outbox-v1")

    @Before fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        isolated = File(app.noBackupFilesDir, "outbox-platform-test-${UUID.randomUUID()}")
        check(isolated.mkdirs())
    }
    private fun context(): Context = object : ContextWrapper(app) {
        override fun getApplicationContext(): Context = this
        override fun getNoBackupFilesDir() = File(isolated, "no-backup").apply { mkdirs() }
        override fun getCacheDir() = File(isolated, "cache").apply { mkdirs() }
        override fun getFilesDir() = File(isolated, "files").apply { mkdirs() }
    }
    @After fun cleanOnlyTestOwnership() {
        // Include a generation created before an admission assertion failed, from this root only.
        File(root, "active").listFiles().orEmpty().filter { it.name.startsWith("generation.") }.forEach {
            val generation = it.name.removePrefix("generation.")
            if (runCatching { UUID.fromString(generation).toString() == generation }.getOrDefault(false)) generations += generation
        }
        try { generations.forEach { AndroidOutboxKeyProvider().deleteGeneration(it) } }
        finally { assertTrue("Test-owned root cleanup failed", isolated.deleteRecursively()) }
    }

    @Test fun ordinaryReportReopensAndRetriesOnEverySupportedApi() = runBlocking {
        reopenAndRetry(1024)
    }
    @Test @SdkSuppress(minSdkVersion = 29)
    fun videoSizedAttachmentReopensAndRetriesWithScreenshot() = runBlocking {
        reopenAndRetry(8 * 1024 * 1024)
    }

    private suspend fun reopenAndRetry(attachmentBytes: Int) {
        val server = MockWebServer()
        server.start()
        val client = OkHttpClient.Builder().callTimeout(30, TimeUnit.SECONDS).build()
        try {
            val entry = fixture(server.url("/original/api/ingest").toString(), attachmentBytes)
            val firstContext = context()
            val first = JSONLOutbox(firstContext)
            first.enqueue(entry, allowed)
            val token = first.store.snapshotTokens().single().also { generations += it.generation }
            val owned = File(root, "active/${token.fileId}.txq")
            assertTrue(root.canonicalPath.startsWith(firstContext.noBackupFilesDir.canonicalPath + File.separator))
            assertTrue(owned.isFile)
            assertTrue(owned.length() > attachmentBytes)
            assertTrue(File(root, "active").listFiles().orEmpty().none { it.extension == "tmp" })
            assertNoPlaintext(entry)
            val other = entry.copy(reportId = UUID.randomUUID().toString(), createdAt = entry.createdAt + 1,
                idempotencyKey = UUID.randomUUID().toString(), attachmentRefs = emptyList())
            first.enqueue(other, allowed)
            val otherToken = first.store.snapshotTokens().single { it != token }
            val otherFile = File(root, "active/${otherToken.fileId}.txq")
            val secondContext = context()
            assertNotSame(firstContext, secondContext)
            val reopened = JSONLOutbox(secondContext)
            assertEquals(entry, reopened.hydrate().single { it.reportId == entry.reportId })
            val uploader = MultipartUploader(client)
            for (status in listOf(503, 200)) {
                server.enqueue(MockResponse().setResponseCode(status))
                reopened.drain { queued ->
                    if (queued.reportId != entry.reportId) false else {
                        assertEquals(entry, queued)
                        val response = uploader.upload(queued.endpoint, queued.sdkKey, queued.idempotencyKey,
                            queued.envelopeBytes, queued.attachmentRefs.map {
                                MultipartUploader.Part(it.name, it.filename, it.data, it.contentType)
                            })
                        assertEquals(status, response.statusCode)
                        response.statusCode in 200..299
                    }
                }
                val request = server.takeRequest(5, TimeUnit.SECONDS) ?: error("Missing HTTP request")
                assertEquals("/original/api/ingest", request.path)
                assertEquals("Bearer ${entry.sdkKey}", request.getHeader("Authorization"))
                assertEquals(entry.idempotencyKey, request.getHeader("X-TraceItX-Idempotency-Key"))
                assertTrue(request.body.indexOf(entry.envelopeBytes.toByteString()) >= 0)
                entry.attachmentRefs.forEach { assertTrue(request.body.indexOf(it.data.toByteString()) >= 0) }
                assertEquals(status != 200, owned.exists())
                assertTrue("Other owner must survive exact-token cleanup", otherFile.isFile)
            }
            assertEquals(2, server.requestCount)
            assertEquals(listOf(other), reopened.hydrate())
            reopened.removeWhere { it.reportId == other.reportId }
            assertFalse(otherFile.exists())
            assertEquals(0, reopened.count())
            assertNoPlaintext(entry)
        } finally {
            client.dispatcher.executorService.shutdown()
            client.connectionPool.evictAll()
            server.shutdown()
        }
    }

    @Test fun deletedGenerationKeyBlocksReopenWithoutFallbackOrUpload() = runBlocking {
        blockedReopen(OutboxFailure.KEY_UNAVAILABLE) { token, _ ->
            AndroidOutboxKeyProvider().deleteGeneration(token.generation)
        }
    }
    @Test fun changedCiphertextAuthenticatesBeforeUploadAndRetainsQuota() = runBlocking {
        blockedReopen(OutboxFailure.CORRUPT) { _, file ->
            RandomAccessFile(file, "rw").use {
                val at = it.length() - 1
                it.seek(at); val before = it.readByte().toInt()
                it.seek(at); it.writeByte(before xor 1); it.fd.sync()
            }
        }
    }
    private suspend fun blockedReopen(expected: OutboxFailure, breakStorage: (OutboxToken, File) -> Unit) {
        val entry = fixture("https://example.invalid/api/ingest", 4096)
        val outbox = JSONLOutbox(context(), maxEntries = 1)
        outbox.enqueue(entry, allowed)
        val token = outbox.store.snapshotTokens().single().also { generations += it.generation }
        val owned = File(root, "active/${token.fileId}.txq")
        val bytes = owned.length()
        breakStorage(token, owned)
        val damagedBytes = owned.readBytes()
        val reopened = JSONLOutbox(context(), maxEntries = 1, maxTotalBytes = bytes + 1024 * 1024)
        var uploads = 0
        expectFailure(expected) { reopened.drain { uploads++; true } }
        assertEquals(0, uploads)
        expectFailure(expected) { reopened.hydrate() }
        // Blocking data cannot become an empty queue with reclaimed admission capacity.
        expectFailure(expected) { reopened.enqueue(entry.copy(reportId = UUID.randomUUID().toString()), allowed) }
        if (expected == OutboxFailure.KEY_UNAVAILABLE) {
            // Presence revalidates the generation key too; unavailable storage stays fail closed.
            expectFailure(expected) { reopened.store.isPresent(token) }
        } else assertTrue(reopened.store.isPresent(token))
        assertEquals(bytes, owned.length())
        assertArrayEquals(damagedBytes, owned.readBytes())
        assertEquals(1, File(root, "active").listFiles().orEmpty().count { it.extension == "txq" })
        assertNoPlaintext(entry)
    }
    private suspend fun expectFailure(expected: OutboxFailure, action: suspend () -> Unit) {
        try { action(); fail("Expected blocked outbox") }
        catch (failure: OutboxWriteException) { assertEquals(expected, failure.failure) }
    }
    private fun fixture(endpoint: String, payloadBytes: Int): OutboxEntry {
        val marker = "platform-captured-private-marker"
        val payload = ByteArray(payloadBytes) { (it % 251).toByte() }
        marker.toByteArray().copyInto(payload)
        val bitmap = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888)
        val screenshot = try { ByteArrayOutputStream().use {
            check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)); it.toByteArray()
        } } finally { bitmap.recycle() }
        fun attachment(name: String, contentType: String, data: ByteArray) = OutboxEntry.AttachmentRef(
            name, name, contentType, data,
            MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) })
        val reportId = UUID.randomUUID().toString()
        return OutboxEntry(reportId, 123, """{"reportId":"$reportId","title":"$marker"}""".toByteArray(),
            UUID.randomUUID().toString(), listOf(attachment("fixture.bin", "application/octet-stream", payload),
                attachment("screenshot.png", "image/png", screenshot)),
            "platform-captured-sdk-key", endpoint, "platform-captured-subject")
    }
    private fun assertNoPlaintext(entry: OutboxEntry) {
        val markers = listOf("platform-captured-private-marker", entry.sdkKey, entry.identitySubject!!,
            entry.reportId, entry.idempotencyKey, entry.endpoint)
        isolated.walkTopDown().filter { it.isFile }.forEach { file ->
            val bytes = file.readBytes().toString(Charsets.ISO_8859_1)
            markers.forEach { assertFalse("Captured data found in test disk bytes", bytes.contains(it)) }
        }
        assertTrue(context().cacheDir.walkTopDown().none { it.isFile })
        assertTrue(context().filesDir.walkTopDown().none { it.isFile })
    }
}
