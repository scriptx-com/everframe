// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 05-05 Task 2 — ReportSubmitter unit tests via MockWebServer.
//
// CRITICAL invariant tested: ReportSubmitter's internal client does NOT include
// TraceItXInterceptor (no recursive capture). Verified by source-grep gate
// `grep -c 'addTraceItXInterceptor' ReportSubmitter.kt == 0` AND by introspecting
// the runtime client's interceptor list at the bottom of this file.
package com.traceitx.transport

import com.traceitx.outbox.JceTestOutboxKeyProvider
import com.traceitx.outbox.JvmOutboxFileOps

import com.traceitx.TraceItX
import com.traceitx.config.IdentityConfigWire
import com.traceitx.config.ReplayConfig
import com.traceitx.config.ReportResult
import com.traceitx.config.TraceItXConfig
import com.traceitx.envelope.txGuardSuspend
import com.traceitx.identity.IdentityTokenHolder
import com.traceitx.identity.IdentityTokenSource
import com.traceitx.identity.resolveIdentityHeader
import com.traceitx.outbox.JSONLOutbox
import com.traceitx.outbox.OutboxEntry
import kotlinx.coroutines.delay
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.Rule
import java.io.File
import java.util.Base64
import java.util.concurrent.TimeUnit

// Route-override regressions assign the debug-only EndpointOverride; release deliberately exposes only a getter.
class ReportSubmitterTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var server: MockWebServer
    private lateinit var outboxFile: File
    private lateinit var outbox: JSONLOutbox
    private lateinit var client: OkHttpClient

    @Before
    fun setUp() {
        server = MockWebServer().apply { dispatcher = ConfigAwareDispatcher() }
        server.start()
        outboxFile = File(tmp.newFolder("com.traceitx"), "outbox.jsonl")
        outbox = JSONLOutbox(outboxFile, keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps())
        client = OkHttpClient.Builder()
            .connectTimeout(2, TimeUnit.SECONDS)
            .readTimeout(2, TimeUnit.SECONDS)
            .writeTimeout(2, TimeUnit.SECONDS)
            .build()
        // Capture pipeline ON for the duration of the tests.
        TraceItX.captureGate = true
    }

    @After
    fun tearDown() {
        server.shutdown()
        TraceItX.captureGate = false
    }

    private fun makeConfig(): TraceItXConfig = TraceItXConfig(
        appId = "app-id",
        sdkKey = "test-sdk-key",
    )

    private fun makeSubmitter(): ReportSubmitter = ReportSubmitter(
        config = makeConfig(),
        outbox = outbox,
        uploader = MultipartUploader(client),
        endpointOverride = server.url("/api/ingest").toString(),
    )

    @Test
    fun `oversized captured routing are rejected without admission`() = runBlocking {
        val failure = runCatching { makeSubmitter().submit("{}".toByteArray(), "x".repeat(16_385), emptyList()) }.exceptionOrNull()
        assertTrue(failure is IllegalArgumentException)
        assertEquals(0, server.requestCount)
        assertTrue(outbox.hydrate().isEmpty())
    }

    @Test
    fun `kill revokes permission even when resolving storage context throws`() {
        val contextField = TraceItX::class.java.getDeclaredField("appContext").apply { isAccessible = true }
        val sharedField = TraceItX::class.java.getDeclaredField("sharedOutbox").apply { isAccessible = true }
        val previousContext = contextField.get(TraceItX)
        val previousOutbox = sharedField.get(TraceItX)
        val pendingField = TraceItX::class.java.getDeclaredField("pendingOutboxRevocation").apply { isAccessible = true }
        val unresolvedField = TraceItX::class.java.getDeclaredField("unresolvedOutboxRevocationContext").apply { isAccessible = true }
        val previousPending = pendingField.get(TraceItX)
        val previousUnresolved = unresolvedField.get(TraceItX)
        val directory = tmp.newFolder()
        val keys = JceTestOutboxKeyProvider()
        val root = File(directory, "com.traceitx/outbox-v1")
        val oldStore = com.traceitx.outbox.OutboxStore(root, keys, JvmOutboxFileOps())
        val permission = object : com.traceitx.outbox.OutboxAuthorization { override fun isAllowed() = true }
        val oldToken = oldStore.enqueueSync(com.traceitx.outbox.entry("before-unresolved-kill"), permission)
        var unavailable = true
        val context = object : android.content.ContextWrapper(null) {
            override fun getNoBackupFilesDir(): File {
                if (unavailable) throw java.io.IOException("storage unavailable")
                return directory
            }
        }
        try {
            contextField.set(TraceItX, context)
            sharedField.set(TraceItX, null)
            val captured = TraceItX.captureSessionSnapshot()
            TraceItX.kill()
            assertFalse(TraceItX.captureGate)
            assertTrue(TraceItX.killGenerationChangedVolatile(captured.killGeneration))
            assertNull(TraceItX.currentConfig)
            assertTrue(unresolvedField.get(TraceItX) === context)
            // A later Context resolution must poison the original root before exposing it,
            // even when start has already reopened ordinary reporting permission.
            TraceItX.captureGate = true
            unavailable = false
            val resolved = JSONLOutbox(context)
            assertTrue(resolved.store.isRevocationPending())
            assertFalse(oldStore.isPresent(oldToken))
            assertEquals(com.traceitx.outbox.OutboxFailure.REVOKED,
                assertThrows(com.traceitx.outbox.OutboxWriteException::class.java) {
                    oldStore.enqueueSync(com.traceitx.outbox.entry("old-facade"), permission)
                }.failure)
        } finally {
            pendingField.set(TraceItX, previousPending)
            unresolvedField.set(TraceItX, previousUnresolved)
            contextField.set(TraceItX, previousContext)
            sharedField.set(TraceItX, previousOutbox)
        }
    }

    @Test
    fun `SDK kill during paused drain cannot upload or resurrect accepted token`() = runBlocking {
        val keys = JceTestOutboxKeyProvider()
        outbox = JSONLOutbox(outboxFile, keys = keys, ops = JvmOutboxFileOps())
        outbox.enqueue(com.traceitx.outbox.entry("paused"))
        val entered = kotlinx.coroutines.CompletableDeferred<Unit>()
        val release = kotlinx.coroutines.CompletableDeferred<Unit>()
        var started = false
        val drain = async {
            outbox.drainOwned { pending ->
                entered.complete(Unit)
                release.await()
                outbox.store.withPresent(pending.token) { started = true }
                false
            }
        }
        entered.await()
        TraceItX::class.java.getDeclaredField("sharedOutbox").apply { isAccessible = true }.set(TraceItX, outbox)
        TraceItX.kill()
        TraceItX.captureGate = true
        val fresh = JSONLOutbox(outboxFile, keys = keys, ops = JvmOutboxFileOps())
        fresh.enqueue(com.traceitx.outbox.entry("replacement"))
        release.complete(Unit)
        drain.await()
        assertFalse(started)
        assertEquals(listOf("replacement"), fresh.hydrate().map { it.reportId })
    }

    @Test
    fun `SDK kill then reopened gate cannot drain durable pre-kill report`() = runBlocking {
        val keys = JceTestOutboxKeyProvider()
        outbox = JSONLOutbox(outboxFile, keys = keys, ops = JvmOutboxFileOps())
        outbox.enqueue(com.traceitx.outbox.entry("pre-kill"))
        val shared = TraceItX::class.java.getDeclaredField("sharedOutbox").apply { isAccessible = true }
        shared.set(TraceItX, outbox)
        TraceItX.kill()
        TraceItX.captureGate = true
        val reopened = JSONLOutbox(outboxFile, keys = keys, ops = JvmOutboxFileOps())
        assertEquals(0, reopened.count())
        assertEquals(com.traceitx.outbox.OutboxFailure.REVOKED,
            org.junit.Assert.assertThrows(com.traceitx.outbox.OutboxWriteException::class.java) {
                runBlocking { outbox.enqueue(com.traceitx.outbox.entry("pre-kill")) }
            }.failure)
        reopened.enqueue(com.traceitx.outbox.entry("post-kill"))
        assertEquals(1, reopened.count())
    }

    @Test
    fun `oversized malformed envelope is bounded before parsing or admission`() = runBlocking {
        val oversized = ByteArray(1_000_001) { ' '.code.toByte() }.apply { this[0] = '{'.code.toByte() }
        val failure = runCatching { makeSubmitter().submit(oversized, "oversized", emptyList()) }.exceptionOrNull()
        assertTrue("expected size rejection, got $failure", failure is IllegalArgumentException)
        assertEquals("Envelope exceeds limit", failure?.message)
        assertEquals(0, server.requestCount)
        assertFalse(File(outboxFile.parentFile, outboxFile.name + ".encrypted").exists())
    }

    @Test
    fun `attachment count is bounded before materializing caller collection`() = runBlocking {
        val attachments = object : AbstractList<ReportSubmitter.Attachment>() {
            override val size = 7
            override fun get(index: Int): ReportSubmitter.Attachment = error("Caller collection traversed")
        }
        val failure = runCatching { makeSubmitter().submit("{}".toByteArray(), "too-many", attachments) }.exceptionOrNull()
        assertTrue("expected count rejection, got $failure", failure is IllegalArgumentException)
        assertEquals("Too many attachments", failure?.message)
        assertEquals(0, server.requestCount)
        assertFalse(File(outboxFile.parentFile, outboxFile.name + ".encrypted").exists())
    }

    @Test
    fun `408 and 429 admission retain one entry and terminal drain never evicts it`() = runBlocking {
        for (status in listOf(408, 429)) {
            outbox = JSONLOutbox(File(tmp.newFolder(), "retry.jsonl"), keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps())
            server.enqueue(MockResponse().setResponseCode(status).setHeader("Retry-After", "1"))
            val result = makeSubmitter().submit("{}".toByteArray(), "retry-$status", emptyList())
            assertTrue(result is ReportResult.Queued)
            val original = outbox.hydrate().single()
            server.enqueue(MockResponse().setResponseCode(400))
            makeSubmitter().drainOutbox(IdentityTokenHolder(), { ReplayConfig.OFF }, 0, { 0 })
            assertEquals(listOf(original), outbox.hydrate())
        }
    }

    @Test
    fun `delayed drain withholds identity after endpoint alone changes`() = runBlocking {
        val endpoint = server.url("/api/ingest").toString()
        val captured = TraceItX.captureSessionSnapshot()
        var epoch = captured.user.startEpoch
        val holder = IdentityTokenHolder()
        holder.set(IdentityTokenSource.Token(jwt("alice", System.currentTimeMillis() + 300_000)))
        val original = OutboxEntry("captured", 1, "{}".toByteArray(), "captured-id", emptyList(), "test-sdk-key", endpoint, "alice")
        outbox.enqueue(original)
        val oldOverride = com.traceitx.config.EndpointOverride.current
        try {
            com.traceitx.config.EndpointOverride.current = endpoint
            val submitter = ReportSubmitter(makeConfig(), outbox, MultipartUploader(client))
            val deferred = async(start = kotlinx.coroutines.CoroutineStart.LAZY) {
                submitter.drainOutbox(holder, { enabledIdentityConfig() }, captured.user.startEpoch, { epoch }, captured, endpoint)
            }
            com.traceitx.config.EndpointOverride.current = "http://127.0.0.1:1"
            server.enqueue(MockResponse().setResponseCode(503))
            deferred.await()
            val request = server.takeUpload()
            assertEquals("/api/ingest", request.path)
            assertEquals("captured-id", request.getHeader("X-TraceItX-Idempotency-Key"))
            assertNull(request.getHeader("X-TX-Identity-Token"))
            assertEquals(listOf(original), outbox.hydrate())
        } finally { com.traceitx.config.EndpointOverride.current = oldOverride }
    }

    @Test
    fun `delayed drain preserves initiating endpoint and withholds identity after epoch changes`() = runBlocking {
        val endpoint = server.url("/api/ingest").toString()
        val captured = TraceItX.captureSessionSnapshot()
        var epoch = captured.user.startEpoch
        val holder = IdentityTokenHolder()
        holder.set(IdentityTokenSource.Token(jwt("alice", System.currentTimeMillis() + 300_000)))
        val original = OutboxEntry("captured", 1, "{}".toByteArray(), "captured-id", emptyList(), "test-sdk-key", endpoint, "alice")
        outbox.enqueue(original)
        val oldOverride = com.traceitx.config.EndpointOverride.current
        try {
            com.traceitx.config.EndpointOverride.current = endpoint
            val submitter = ReportSubmitter(makeConfig(), outbox, MultipartUploader(client))
            val deferred = async(start = kotlinx.coroutines.CoroutineStart.LAZY) {
                submitter.drainOutbox(holder, { enabledIdentityConfig() }, captured.user.startEpoch, { epoch }, captured, endpoint)
            }
            epoch++
            com.traceitx.config.EndpointOverride.current = "http://127.0.0.1:1"
            server.enqueue(MockResponse().setResponseCode(503))
            deferred.await()
            val request = server.takeUpload()
            assertEquals("/api/ingest", request.path)
            assertEquals("captured-id", request.getHeader("X-TraceItX-Idempotency-Key"))
            assertNull(request.getHeader("X-TX-Identity-Token"))
            assertEquals(listOf(original), outbox.hydrate())
        } finally { com.traceitx.config.EndpointOverride.current = oldOverride }
    }

    @Test
    fun `503 full disk preserves accepted queue and never reports queued`() = runBlocking {
        val keys = JceTestOutboxKeyProvider()
        var fail = false
        var attempts = 0
        val ops = object : com.traceitx.outbox.OutboxFileOps by JvmOutboxFileOps() {
            override fun syncFile(file: File) {
                if (fail && file.extension == "tmp") { attempts++; throw java.io.IOException("ENOSPC") }
                JvmOutboxFileOps().syncFile(file)
            }
        }
        outbox = JSONLOutbox(outboxFile, keys = keys, ops = ops)
        val old = OutboxEntry("accepted", 1, "{}".toByteArray(), "old", emptyList(), "key", server.url("/").toString())
        outbox.enqueue(old)
        fail = true
        server.enqueue(MockResponse().setResponseCode(503))
        val result = runCatching { makeSubmitter().submit("{}".toByteArray(), "new", emptyList()) }
        assertTrue(result.exceptionOrNull() is com.traceitx.outbox.OutboxWriteException)
        assertEquals(1, attempts)
        assertEquals(listOf(old), outbox.hydrate())
    }

    @Test
    fun `connection failure with unavailable key preserves accepted queue`() = runBlocking {
        var unavailable = false
        var failures = 0
        val real = JceTestOutboxKeyProvider()
        val keys = object : com.traceitx.outbox.OutboxKeyProvider by real {
            override fun loadGeneration(generation: String): javax.crypto.SecretKey {
                if (unavailable) { failures++; error("key unavailable") }
                return real.loadGeneration(generation)
            }
        }
        outbox = JSONLOutbox(outboxFile, keys = keys, ops = JvmOutboxFileOps())
        val old = OutboxEntry("accepted", 1, "{}".toByteArray(), "old", emptyList(), "key", server.url("/").toString())
        outbox.enqueue(old)
        unavailable = true
        val submitter = ReportSubmitter(makeConfig(), outbox, MultipartUploader(client), "http://127.0.0.1:1")
        val result = runCatching { submitter.submit("{}".toByteArray(), "new", emptyList()) }
        assertTrue(result.exceptionOrNull() is com.traceitx.outbox.OutboxWriteException)
        assertEquals(1, failures)
        unavailable = false
        assertEquals(listOf(old), outbox.hydrate())
    }

    @Test
    fun `endpoint changing during HTTP cannot redirect queued report`() = runBlocking {
        val old = com.traceitx.config.EndpointOverride.current
        val original = server.url("/").toString()
        try {
            com.traceitx.config.EndpointOverride.current = original
            server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
                override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
                    com.traceitx.config.EndpointOverride.current = "http://127.0.0.1:1"
                    return MockResponse().setResponseCode(503)
                }
            }
            ReportSubmitter(makeConfig(), outbox, MultipartUploader(client)).submit("{}".toByteArray(), "endpoint", emptyList())
            assertEquals(original, outbox.hydrate().single().endpoint)
        } finally { com.traceitx.config.EndpointOverride.current = old }
    }

    @Test
    fun `optional revoke during disk admission persists only ordinary report across reopen`() = runBlocking {
        var replay = true
        var writes = 0
        val keys = JceTestOutboxKeyProvider()
        val ops = object : com.traceitx.outbox.OutboxFileOps by JvmOutboxFileOps() {
            override fun syncFile(file: File) {
                JvmOutboxFileOps().syncFile(file)
                if (file.extension == "tmp") { writes++; replay = false }
            }
        }
        outbox = JSONLOutbox(outboxFile, keys = keys, ops = ops)
        val authority = object : ReportAuthorization {
            override fun evaluate() = ReportAuthorizationDecision(true, replay)
            override fun tryStart(expected: ReportAuthorizationDecision, start: () -> Unit): Boolean { start(); return true }
        }
        server.enqueue(MockResponse().setResponseCode(503))
        val bytes = byteArrayOf(1,2,3)
        val hash = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val result = makeSubmitter().submit(
            """{"reportId":"frozen","attachments":[{"partName":"replay","format":"traceitx-video-v1"}]}""".toByteArray(),
            "same-idem", listOf(ReportSubmitter.Attachment("replay", "replay.mp4", "video/mp4", bytes, hash)),
            identitySubject = "alice", authorization = authority)
        assertTrue(result is ReportResult.Queued)
        assertEquals(2, writes)
        server.takeUpload()
        outbox = JSONLOutbox(outboxFile, keys = keys, ops = JvmOutboxFileOps())
        val persisted = outbox.hydrate().single()
        assertTrue(persisted.attachmentRefs.isEmpty())
        assertFalse(persisted.envelopeBytes.decodeToString().contains("replay"))
        assertEquals("alice", persisted.identitySubject)
        assertEquals("same-idem", persisted.idempotencyKey)
        replay = true
        server.enqueue(MockResponse().setResponseCode(200))
        makeSubmitter().drainOutbox(IdentityTokenHolder(), { ReplayConfig.OFF }, 0, { 0 })
        assertFalse(server.takeUpload().body.readUtf8().contains("replay"))
        assertEquals(0, outbox.count())
    }

    @Test
    fun `removed pending token cannot enqueue or remove a replacement`() = runBlocking {
        val old = OutboxEntry("same", 1, "{}".toByteArray(), "old", emptyList(), "key", server.url("/").toString())
        outbox.enqueue(old)
        val token = outbox.store.snapshotTokens().single()
        val delegate = object : ReportAuthorization {
            override fun evaluate() = ReportAuthorizationDecision(true, true)
            override fun tryStart(expected: ReportAuthorizationDecision, start: () -> Unit): Boolean { start(); return true }
        }
        val authority = OutboxDrainAuthorization(outbox.store, token, delegate)
        val expected = authority.evaluate()
        outbox.store.removeIfPresent(token)
        outbox.enqueue(old.copy(idempotencyKey = "replacement"))
        var enqueues = 0
        assertFalse(authority.tryStart(expected) { enqueues++ })
        assertEquals(ReportAuthorizationDecision(false, false), authority.evaluate())
        assertEquals(0, enqueues)
        outbox.store.removeIfPresent(token)
        assertEquals("replacement", outbox.hydrate().single().idempotencyKey)
    }

    @Test
    fun `503 rename failure attempts admission once and preserves caller evidence`() = runBlocking {
        var renames = 0
        val ops = object : com.traceitx.outbox.OutboxFileOps by JvmOutboxFileOps() {
            override fun renameAtomic(from: File, to: File) {
                renames++
                throw java.io.IOException("disk fault")
            }
        }
        outbox = JSONLOutbox(outboxFile, keys = JceTestOutboxKeyProvider(), ops = ops)
        val evidence = tmp.newFile("caller.png").apply { writeBytes(byteArrayOf(1,2,3)) }
        server.enqueue(MockResponse().setResponseCode(503))
        val failure = runCatching { makeSubmitter().submit("{}".toByteArray(), "rename", listOf(
            ReportSubmitter.Attachment("shot", "shot.png", "image/png", evidence.readBytes(), java.security.MessageDigest.getInstance("SHA-256").digest(byteArrayOf(1,2,3)).joinToString("") { "%02x".format(it) })
        )) }.exceptionOrNull()
        assertTrue(failure is com.traceitx.outbox.OutboxWriteException)
        assertEquals(1, renames)
        assertEquals(0, outbox.count())
        assertTrue(evidence.readBytes().contentEquals(byteArrayOf(1,2,3)))
    }

    @Test
    fun `retry keeps bytes captured before HTTP despite caller mutation`() = runBlocking {
        val envelope = "{}".toByteArray()
        val bytes = byteArrayOf(1,2,3)
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
                envelope[0] = 'X'.code.toByte()
                bytes[0] = 9
                return MockResponse().setResponseCode(503)
            }
        }
        makeSubmitter().submit(envelope, "snapshot", listOf(
            ReportSubmitter.Attachment("shot", "shot.png", "image/png", bytes, java.security.MessageDigest.getInstance("SHA-256").digest(byteArrayOf(1,2,3)).joinToString("") { "%02x".format(it) })
        ))
        val entry = outbox.hydrate().single()
        assertTrue(entry.envelopeBytes.contentEquals("{}".toByteArray()))
        assertTrue(entry.attachmentRefs.single().data.contentEquals(byteArrayOf(1,2,3)))
    }

    @Test
    fun `submit with 200 returns Submitted and outbox stays empty`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        val r = makeSubmitter().submit(
            envelopeBytes = "{}".toByteArray(),
            idempotencyKey = "idem-1",
            attachments = emptyList(),
        )
        assertTrue("expected Submitted, got $r", r is ReportResult.Submitted)
        assertEquals(0, outbox.count())
    }

    @Test
    fun `submit with 503 returns Queued and enqueues to outbox`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(503).setBody("retry me"))
        val r = makeSubmitter().submit(
            envelopeBytes = "{}".toByteArray(),
            idempotencyKey = "idem-503",
            attachments = emptyList(),
        )
        assertTrue("expected Queued, got $r", r is ReportResult.Queued)
        assertEquals(1, outbox.count())
        val entry = outbox.hydrate().first()
        assertEquals("idem-503", entry.idempotencyKey)
    }

    @Test
    fun `submit with 400 throws ServerError and outbox stays empty`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(400).setBody("bad request"))
        val submitter = makeSubmitter()
        val ex = assertThrows(TraceItXTransportError.ServerError::class.java) {
            runBlocking {
                submitter.submit(
                    envelopeBytes = "{}".toByteArray(),
                    idempotencyKey = "idem-400",
                    attachments = emptyList(),
                )
            }
        }
        assertEquals(400, ex.statusCode)
        // Body preview is debug-only; in debug build it should be populated.
        assertNotNull(ex.responseBody)
        assertTrue(ex.responseBody!!.contains("bad request"))
        assertEquals(0, outbox.count())
    }

    @Test
    fun `submit with connection refused returns Queued (Retryable IOException)`() = runBlocking {
        server.shutdown()
        val cfg = TraceItXConfig(
            appId = "x",
            sdkKey = "k",
        )
        val submitter = ReportSubmitter(
            config = cfg,
            outbox = outbox,
            uploader = MultipartUploader(client),
            endpointOverride = "http://127.0.0.1:1/api/ingest",
        )
        val r = submitter.submit(
            envelopeBytes = "{}".toByteArray(),
            idempotencyKey = "idem-conn",
            attachments = emptyList(),
        )
        assertTrue("expected Queued, got $r", r is ReportResult.Queued)
        assertEquals(1, outbox.count())
    }

    @Test
    fun `submit with captureGate off returns Cancelled`() = runBlocking {
        TraceItX.captureGate = false
        try {
            val r = makeSubmitter().submit(
                envelopeBytes = "{}".toByteArray(),
                idempotencyKey = "idem",
                attachments = emptyList(),
            )
            assertTrue("expected Cancelled, got $r", r is ReportResult.Cancelled)
            assertEquals("kill_switch", (r as ReportResult.Cancelled).reason)
            assertEquals(0, outbox.count())
        } finally {
            TraceItX.captureGate = true
        }
    }

    @Test
    fun `drainOutbox after 503 then 200 empties the outbox`() = runBlocking {
        // First submit: 503 → outbox.
        server.enqueue(MockResponse().setResponseCode(503))
        val submitter = makeSubmitter()
        submitter.submit(
            envelopeBytes = "{}".toByteArray(),
            idempotencyKey = "idem-x",
            attachments = emptyList(),
        )
        assertEquals(1, outbox.count())

        // Drain: server returns 200.
        server.enqueue(MockResponse().setResponseCode(200))
        submitter.drainOutbox(identityHolder = IdentityTokenHolder(), currentReplayConfig = { ReplayConfig.OFF }, epochAtInitiation = 0, currentEpoch = { 0 })
        assertEquals(0, outbox.count())
    }

    @Test
    fun `drainOutbox keeps entry when re-attempt fails 503`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(503))
        val submitter = makeSubmitter()
        submitter.submit(
            envelopeBytes = "{}".toByteArray(),
            idempotencyKey = "idem-keep",
            attachments = emptyList(),
        )
        assertEquals(1, outbox.count())

        server.enqueue(MockResponse().setResponseCode(503))
        submitter.drainOutbox(identityHolder = IdentityTokenHolder(), currentReplayConfig = { ReplayConfig.OFF }, epochAtInitiation = 0, currentEpoch = { 0 })
        // Entry still queued (no double-counting either — exactly 1).
        assertEquals(1, outbox.count())
    }

    @Test
    fun `drainOutbox respects captureGate kill switch`() = runBlocking {
        // Pre-populate outbox.
        server.enqueue(MockResponse().setResponseCode(503))
        val submitter = makeSubmitter()
        submitter.submit(
            envelopeBytes = "{}".toByteArray(),
            idempotencyKey = "idem",
            attachments = emptyList(),
        )
        assertEquals(1, outbox.count())

        // Flip kill switch — drain should no-op.
        TraceItX.captureGate = false
        submitter.drainOutbox(identityHolder = IdentityTokenHolder(), currentReplayConfig = { ReplayConfig.OFF }, epochAtInitiation = 0, currentEpoch = { 0 })
        assertEquals("drain should not run when captureGate is off", 1, outbox.count())
    }

    // ---------------------------------------------------------------------
    // Native identity Task 8b — the wiring, not just the gate.
    // IdentityGateTest (com.traceitx.identity) already proves
    // resolveIdentityHeader makes the right call in isolation; these cases
    // prove it actually reaches a REAL (MockWebServer) HTTP request — the
    // exact thing missing when `drainOutbox`'s `identityHolder` parameter
    // still defaulted to a fresh, empty holder and `.OFF`. Asserting on
    // `takeRequest().getHeader(...)` is the strongest evidence available
    // anywhere in this sub-project that the header reaches the wire.
    // ---------------------------------------------------------------------

    private fun jwt(sub: String, expMs: Long): String {
        val payload = buildJsonObject {
            put("sub", sub)
            put("exp", expMs / 1000)
        }
        val header = """{"alg":"HS256","typ":"JWT"}"""
        fun b64(s: String) = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(s.toByteArray(Charsets.UTF_8))
        return "${b64(header)}.${b64(payload.toString())}.not-a-real-signature"
    }

    private fun enabledIdentityConfig(): ReplayConfig = ReplayConfig(
        replayEnabled = true,
        replayDurationSec = 30,
        samplingRate = 1.0,
        identity = IdentityConfigWire(enabled = true),
    )

    @Test
    fun `submit attaches X-TX-Identity-Token when the caller resolved one`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        val now = System.currentTimeMillis()
        val holder = IdentityTokenHolder()
        val token = jwt(sub = "alice", expMs = now + 300_000)
        holder.set(IdentityTokenSource.Token(token))

        val resolved = resolveIdentityHeader(
            capturedSubject = "alice",
            holder = holder,
            config = enabledIdentityConfig(),
            nowMs = now,
        )
        assertEquals("fixture sanity: the gate must resolve a token here", token, resolved)

        makeSubmitter().submit(
            envelopeBytes = "{}".toByteArray(),
            idempotencyKey = "idem-identity-live",
            attachments = emptyList(),
            identitySubject = "alice",
            identityToken = resolved,
        )

        val recorded = server.takeUpload()
        assertEquals(
            "the real HTTP request must carry the resolved identity token",
            token,
            recorded.getHeader("X-TX-Identity-Token"),
        )
    }

    @Test
    fun `submit sends no X-TX-Identity-Token when identityToken is null`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        makeSubmitter().submit(
            envelopeBytes = "{}".toByteArray(),
            idempotencyKey = "idem-identity-anon",
            attachments = emptyList(),
        )
        val recorded = server.takeUpload()
        assertNull(
            "an anonymous submit must not carry the identity header at all",
            recorded.getHeader("X-TX-Identity-Token"),
        )
    }

    @Test
    fun `drainOutbox attaches the header when the entrys subject matches the live holder`() = runBlocking {
        val now = System.currentTimeMillis()
        val holder = IdentityTokenHolder()
        val token = jwt(sub = "alice", expMs = now + 300_000)
        holder.set(IdentityTokenSource.Token(token))

        outbox.enqueue(
            OutboxEntry(
                reportId = "r-drain-match",
                createdAt = now,
                envelopeBytes = "{}".toByteArray(),
                idempotencyKey = "idem-drain-match",
                attachmentRefs = emptyList(),
                sdkKey = "test-sdk-key",
                endpoint = server.url("/api/ingest").toString(),
                identitySubject = "alice",
            ),
        )

        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        makeSubmitter().drainOutbox(identityHolder = holder, currentReplayConfig = { enabledIdentityConfig() }, epochAtInitiation = 0, currentEpoch = { 0 })

        val recorded = server.takeUpload()
        assertEquals(
            "an entry captured under alice, drained while alice's token is live, must carry it",
            token,
            recorded.getHeader("X-TX-Identity-Token"),
        )
        assertEquals(0, outbox.count())
    }

    @Test
    fun `drainOutbox withholds the header when the entrys subject differs from the live holder`() = runBlocking {
        val now = System.currentTimeMillis()
        val holder = IdentityTokenHolder()
        // Bob signed in after alice's report was captured and queued.
        holder.set(IdentityTokenSource.Token(jwt(sub = "bob", expMs = now + 300_000)))

        outbox.enqueue(
            OutboxEntry(
                reportId = "r-drain-mismatch",
                createdAt = now,
                envelopeBytes = "{}".toByteArray(),
                idempotencyKey = "idem-drain-mismatch",
                attachmentRefs = emptyList(),
                sdkKey = "test-sdk-key",
                endpoint = server.url("/api/ingest").toString(),
                identitySubject = "alice",
            ),
        )

        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        makeSubmitter().drainOutbox(identityHolder = holder, currentReplayConfig = { enabledIdentityConfig() }, epochAtInitiation = 0, currentEpoch = { 0 })

        val recorded = server.takeUpload()
        assertNull(
            "alice's queued report must never be drained carrying bob's credential",
            recorded.getHeader("X-TX-Identity-Token"),
        )
    }

    // -----------------------------------------------------------------
    // Final whole-branch review, Important 2: project binding.
    //
    // The header used to be resolved from the LIVE holder/config
    // regardless of which project the queued entry actually belongs to —
    // unlike sdkKey/endpoint on the very next line, which always come from
    // the entry itself. start(projectA) queues a report (sdkKey="test-sdk-key")
    // -> start(projectB) -> setIdentityToken with project B's live token,
    // whose sub happens to equal the entry's captured subject (plausible:
    // sub is the host's own user id, unchanged across a tenant switch) ->
    // drain fires -> project B's live bearer credential would ship to
    // project A's endpoint. Mutation-verified: reverting the
    // `entry.sdkKey == config.sdkKey` guard in `drainOutbox` makes the
    // withhold case below fail.
    // -----------------------------------------------------------------

    @Test
    fun `drainOutbox withholds the header when the entry belongs to a different project even though the subject matches`() = runBlocking {
        val now = System.currentTimeMillis()
        val holder = IdentityTokenHolder()
        // The live holder's token belongs to the SAME person ("alice") the
        // entry was captured under — the subject check alone would let this
        // through. Only the project (sdkKey) differs.
        holder.set(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now + 300_000)))

        outbox.enqueue(
            OutboxEntry(
                reportId = "r-drain-other-project",
                createdAt = now,
                envelopeBytes = "{}".toByteArray(),
                idempotencyKey = "idem-drain-other-project",
                attachmentRefs = emptyList(),
                // Entry's own project differs from `makeSubmitter()`'s live
                // config ("test-sdk-key").
                sdkKey = "a-different-projects-sdk-key",
                endpoint = server.url("/api/ingest").toString(),
                identitySubject = "alice",
            ),
        )

        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        makeSubmitter().drainOutbox(identityHolder = holder, currentReplayConfig = { enabledIdentityConfig() }, epochAtInitiation = 0, currentEpoch = { 0 })

        val recorded = server.takeUpload()
        assertNull(
            "a live token must never drain onto a queued entry captured under a DIFFERENT project, even when the subject matches",
            recorded.getHeader("X-TX-Identity-Token"),
        )
        assertEquals(0, outbox.count())
    }

    @Test
    fun `drainOutbox attaches the header when the entrys project still matches the live config`() = runBlocking {
        // Sanity/non-regression companion: when the entry's own project DOES
        // still match the live config (the ordinary, same-session case
        // every other test above already exercises), the header must still
        // attach — this fix must not over-withhold.
        val now = System.currentTimeMillis()
        val holder = IdentityTokenHolder()
        val token = jwt(sub = "alice", expMs = now + 300_000)
        holder.set(IdentityTokenSource.Token(token))

        outbox.enqueue(
            OutboxEntry(
                reportId = "r-drain-same-project",
                createdAt = now,
                envelopeBytes = "{}".toByteArray(),
                idempotencyKey = "idem-drain-same-project",
                attachmentRefs = emptyList(),
                sdkKey = "test-sdk-key",
                endpoint = server.url("/api/ingest").toString(),
                identitySubject = "alice",
            ),
        )

        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        makeSubmitter().drainOutbox(identityHolder = holder, currentReplayConfig = { enabledIdentityConfig() }, epochAtInitiation = 0, currentEpoch = { 0 })

        val recorded = server.takeUpload()
        assertEquals(
            "the header must still attach for the ordinary same-project case",
            token,
            recorded.getHeader("X-TX-Identity-Token"),
        )
    }

    // -----------------------------------------------------------------
    // Independent review, round 4, Serious 1: endpoint binding.
    //
    // `sdkKey`/`endpoint` on the upload itself already come from the ENTRY,
    // never the live config — PR #63 stored the endpoint alongside the key
    // specifically because "the endpoint is independently redirectable, so
    // a key alone can still reach the wrong host" (e.g. a debug
    // EndpointOverride.current changing between queue and drain). The
    // identity header used to be exempt from that rule: it checked
    // `entry.sdkKey == config.sdkKey` alone, so a live token could still
    // attach even when the entry's OWN endpoint no longer matched the live
    // one.
    // -----------------------------------------------------------------

    /**
     * THE test that must exist: an entry whose sdkKey still matches but
     * whose endpoint does NOT must withhold the header — the same subject
     * that would otherwise attach cleanly (see the sanity companion above)
     * must not attach once the endpoint alone has drifted. A SECOND
     * MockWebServer stands in for the entry's own (stale) endpoint —
     * `makeSubmitter()`'s `endpointOverride` (`server`, below) is the LIVE
     * one `drainOutbox`'s header decision compares against; the actual
     * upload still targets the entry's OWN endpoint (`staleServer`) exactly
     * like `OutboxKeyBindingTest` already establishes for sdkKey. Mutation-
     * verified: reverting the `entry.endpoint == endpointUrl` half of the
     * guard makes this fail.
     */
    @Test
    fun `drainOutbox withholds the header when the entrys endpoint no longer matches the live one`() = runBlocking {
        val now = System.currentTimeMillis()
        val holder = IdentityTokenHolder()
        val token = jwt(sub = "alice", expMs = now + 300_000)
        holder.set(IdentityTokenSource.Token(token))

        val staleServer = MockWebServer().apply { dispatcher = ConfigAwareDispatcher() }
        staleServer.start()
        try {
            outbox.enqueue(
                OutboxEntry(
                    reportId = "r-drain-endpoint-mismatch",
                    createdAt = now,
                    envelopeBytes = "{}".toByteArray(),
                    idempotencyKey = "idem-drain-endpoint-mismatch",
                    attachmentRefs = emptyList(),
                    sdkKey = "test-sdk-key",
                    endpoint = staleServer.url("/api/ingest").toString(),
                    identitySubject = "alice",
                ),
            )

            staleServer.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
            makeSubmitter().drainOutbox(
                identityHolder = holder,
                currentReplayConfig = { enabledIdentityConfig() },
                epochAtInitiation = 0,
                currentEpoch = { 0 },
            )

            val recorded = staleServer.takeUpload()
            assertNull(
                "a live token must never drain onto a queued entry whose endpoint no longer matches " +
                    "the live one, even when sdkKey and subject both match",
                recorded.getHeader("X-TX-Identity-Token"),
            )
        } finally {
            staleServer.shutdown()
        }
    }

    // -----------------------------------------------------------------
    // Independent review, Serious 2: the sdkKey pre-check alone is a TOCTOU
    // window.
    //
    // resolveIdentityHeader is suspend, and ITS OWN suspension point
    // (IdentityTokenHolder.get's provider re-ask) gives a start(projectB) +
    // setIdentityToken(B) landing DURING resolution — after the
    // entry.sdkKey == config.sdkKey pre-check already passed — a window to
    // land: a live token resolved AFTER the project switch could still
    // attach to an entry whose sdkKey/endpoint are frozen at project A's
    // values, disclosing project B's bearer credential to project A's
    // endpoint.
    // -----------------------------------------------------------------

    /**
     * THE test that must exist: an epoch change happening DURING resolution
     * (simulated deterministically — the provider closure itself bumps the
     * captured epoch var, standing in for start(projectB) landing while
     * resolveIdentityHeader's own suspension is in flight) must withhold
     * the header even though the pre-check passed and the subject matches.
     * Mutation-verified: reverting the post-resolution `currentEpoch() ==
     * epochAtDrainStart` re-check makes this fail.
     */
    @Test
    fun `drainOutbox withholds the header when the epoch changes during resolution`() = runBlocking {
        val now = System.currentTimeMillis()
        val holder = IdentityTokenHolder()
        val token = jwt(sub = "alice", expMs = now + 300_000)
        var epoch = 0
        // Stands in for start(projectB) landing WHILE this entry's
        // resolveIdentityHeader(...) call is suspended awaiting the
        // provider — the epoch bump happens strictly BETWEEN drainOutbox's
        // pre-resolution snapshot and its post-resolution re-check,
        // deterministically, with no real threading needed.
        holder.set(
            IdentityTokenSource.Provider {
                epoch += 1
                token
            },
        )

        outbox.enqueue(
            OutboxEntry(
                reportId = "r-drain-epoch-race",
                createdAt = now,
                envelopeBytes = "{}".toByteArray(),
                idempotencyKey = "idem-drain-epoch-race",
                attachmentRefs = emptyList(),
                sdkKey = "test-sdk-key",
                endpoint = server.url("/api/ingest").toString(),
                identitySubject = "alice",
            ),
        )

        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        makeSubmitter().drainOutbox(identityHolder = holder, currentReplayConfig = { enabledIdentityConfig() }, epochAtInitiation = 0, currentEpoch = { epoch })

        val recorded = server.takeUpload()
        assertNull(
            "an epoch change during resolution must withhold the header even though the pre-check passed and the subject matches",
            recorded.getHeader("X-TX-Identity-Token"),
        )
    }

    /** Sanity/non-regression companion: when the epoch does NOT change
     *  during resolution (the ordinary case), the header must still attach. */
    @Test
    fun `drainOutbox attaches the header when the epoch is unchanged throughout resolution`() = runBlocking {
        val now = System.currentTimeMillis()
        val holder = IdentityTokenHolder()
        val token = jwt(sub = "alice", expMs = now + 300_000)
        holder.set(IdentityTokenSource.Token(token))

        outbox.enqueue(
            OutboxEntry(
                reportId = "r-drain-epoch-stable",
                createdAt = now,
                envelopeBytes = "{}".toByteArray(),
                idempotencyKey = "idem-drain-epoch-stable",
                attachmentRefs = emptyList(),
                sdkKey = "test-sdk-key",
                endpoint = server.url("/api/ingest").toString(),
                identitySubject = "alice",
            ),
        )

        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        makeSubmitter().drainOutbox(identityHolder = holder, currentReplayConfig = { enabledIdentityConfig() }, epochAtInitiation = 0, currentEpoch = { 0 })

        val recorded = server.takeUpload()
        assertEquals(
            "the header must still attach when nothing raced the resolution",
            token,
            recorded.getHeader("X-TX-Identity-Token"),
        )
    }

    // -----------------------------------------------------------------
    // Independent review, round 3 (Serious 2): a host provider that throws
    // CancellationException internally must degrade to anonymous, not
    // abandon the whole report.
    //
    // A host provider is free to bound its OWN auth call with `withTimeout`
    // internally — entirely ordinary Kotlin — which throws a
    // CancellationException too, indistinguishable BY TYPE from real
    // structured cancellation of whatever coroutine is resolving it.
    // `IdentityTokenHolder.kt`'s `invokeSafely` used to rethrow any
    // CancellationException unconditionally, so it propagated out of
    // `resolveIdentityHeader(...)` — and because the real call sites
    // (`ReporterDialog.kt`, `CompanionSubmissionComposer.kt`) wrap their
    // WHOLE submit-building block in `txGuardSuspend("...") { ... } ?:
    // ReportResult.Cancelled("submit_guard_failed")`, that escaped exception
    // got caught there as a generic `Throwable`, abandoning the ENTIRE
    // report: neither uploaded nor enqueued, only dropped. Recognition must
    // never fail, stall, or drop a report — losing attribution is the
    // accepted failure, losing the report is not.
    //
    // This reproduces the real wrapping shape exactly and proves the report
    // survives. Mutation-verified: reverting `invokeSafely`'s `isActive`
    // check back to an unconditional rethrow makes this fail with the
    // txGuardSuspend block swallowing a CancellationException and the Elvis
    // producing `Cancelled("submit_guard_failed")` instead of `Submitted`.
    // -----------------------------------------------------------------

    @Test
    fun `a provider that throws CancellationException internally still lets the report submit anonymously`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        val now = System.currentTimeMillis()
        val holder = IdentityTokenHolder()
        holder.set(
            IdentityTokenSource.Provider {
                // An entirely ordinary host provider shape: bound its own
                // auth call with withTimeout. This throws a genuine
                // kotlinx.coroutines.CancellationException
                // (TimeoutCancellationException) from INSIDE the provider —
                // not a cancellation of whatever coroutine is resolving
                // IdentityTokenHolder.get().
                withTimeout(1) {
                    delay(10_000)
                    "never-arrives"
                }
            },
        )

        // Reproduces the real call sites' wrapping shape exactly: the WHOLE
        // submit-building block, identity resolution included, runs inside
        // txGuardSuspend, and a null result becomes Cancelled — see
        // ReporterDialog.kt / CompanionSubmissionComposer.kt.
        val result: ReportResult = txGuardSuspend("test-submit") {
            val resolved = resolveIdentityHeader(
                capturedSubject = "alice",
                holder = holder,
                config = enabledIdentityConfig(),
                nowMs = now,
            )
            makeSubmitter().submit(
                envelopeBytes = "{}".toByteArray(),
                idempotencyKey = "idem-provider-cancels",
                attachments = emptyList(),
                identitySubject = "alice",
                identityToken = resolved,
            )
        } ?: ReportResult.Cancelled("submit_guard_failed")

        assertTrue(
            "a provider that throws CancellationException internally must not abandon the whole report — got $result",
            result is ReportResult.Submitted,
        )
        val recorded = server.takeUpload()
        assertNotNull(
            "the report must actually reach the server, not merely resolve a ReportResult value",
            recorded,
        )
        assertNull(
            "the provider failed, so this must ship anonymously — no header, but the report must still ship",
            recorded.getHeader("X-TX-Identity-Token"),
        )
    }

    // -----------------------------------------------------------------
    // Independent review, round 4 (Serious 2): a malformed token must
    // degrade to anonymous, never take the whole report down with it.
    //
    // Same class of bug as the CancellationException case just above,
    // same fix shape: `IdentityTokenHolder.kt`'s `decodeIdentityClaims`
    // used to inspect only the PAYLOAD segment of a JWT, so a token with an
    // illegal header character anywhere in its header/signature segments
    // (a bare newline, say) decoded fine and was cached/served verbatim —
    // reaching MultipartUploader.kt's OkHttp `header(...)` call, which
    // THROWS on illegal header characters. That throw propagated out of
    // `resolveIdentityHeader(...)`, and because the real call sites wrap
    // their whole submit-building block in `txGuardSuspend { ... } ?:
    // ReportResult.Cancelled("submit_guard_failed")`, the report was
    // abandoned entirely.
    // -----------------------------------------------------------------

    @Test
    fun `a malformed token with an illegal header character still lets the report submit anonymously`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        val now = System.currentTimeMillis()
        val holder = IdentityTokenHolder()
        val wellFormed = jwt(sub = "alice", expMs = now + 300_000)
        // Same header + payload as a perfectly valid token — only the
        // signature segment is corrupted with a bare newline, exactly the
        // character OkHttp's header(...) rejects.
        val malformed = wellFormed.substringBeforeLast('.') + ".bad\nsignature"
        holder.set(IdentityTokenSource.Token(malformed))

        // Reproduces the real call sites' wrapping shape exactly: the WHOLE
        // submit-building block, identity resolution included, runs inside
        // txGuardSuspend, and a null result becomes Cancelled — see
        // ReporterDialog.kt / CompanionSubmissionComposer.kt.
        val result: ReportResult = txGuardSuspend("test-submit") {
            val resolved = resolveIdentityHeader(
                capturedSubject = "alice",
                holder = holder,
                config = enabledIdentityConfig(),
                nowMs = now,
            )
            makeSubmitter().submit(
                envelopeBytes = "{}".toByteArray(),
                idempotencyKey = "idem-malformed-token",
                attachments = emptyList(),
                identitySubject = "alice",
                identityToken = resolved,
            )
        } ?: ReportResult.Cancelled("submit_guard_failed")

        assertTrue(
            "a malformed token must not abandon the whole report — got $result",
            result is ReportResult.Submitted,
        )
        val recorded = server.takeUpload()
        assertNotNull(
            "the report must actually reach the server, not merely resolve a ReportResult value",
            recorded,
        )
        assertNull(
            "the token was malformed, so this must ship anonymously — no header, but the report must still ship",
            recorded.getHeader("X-TX-Identity-Token"),
        )
    }

    @Test
    fun `isolated client has no TraceItXInterceptor`() {
        // Build the same isolated client the submitter uses. Assert no interceptor
        // is named TraceItXInterceptor (mirrors iOS class-name filter).
        val isolated = ReportSubmitter.buildIsolatedClient()
        val networkInterceptors = isolated.networkInterceptors
        val interceptors = isolated.interceptors
        val all = networkInterceptors + interceptors
        for (i in all) {
            val name = i::class.qualifiedName ?: ""
            assertFalse(
                "isolated client must not contain TraceItXInterceptor (recursive capture); found $name",
                name.contains("TraceItXInterceptor"),
            )
        }
    }
}

private class ConfigAwareDispatcher : okhttp3.mockwebserver.QueueDispatcher() {
    override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse =
        if (request.path == "/api/config") MockResponse().setResponseCode(503) else super.dispatch(request)
}
private fun MockWebServer.takeUpload(): okhttp3.mockwebserver.RecordedRequest {
    repeat(10) {
        val request = takeRequest(3, TimeUnit.SECONDS) ?: error("Missing ingest request")
        if (request.path != "/api/config") return request
    }
    error("No ingest request")
}
