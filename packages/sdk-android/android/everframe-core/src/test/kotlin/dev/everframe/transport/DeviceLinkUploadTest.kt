// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture on the upload path: the device token and a fresh
// link nonce ride the upload, `linkPending` in a 200 body starts a takeover,
// `403 device_unlinked` is a result rather than a throw, and a transient
// failure queues the capture with the token's fingerprint (never the token),
// drained only while that same token is stored.
//
// Drives the real `ReportSubmitter` -> `MultipartUploader` pair against
// MockWebServer; setup copied from `CaptureTokenHeaderTest`. Tokens and nonces
// are compared, never printed.

package dev.everframe.transport

import dev.everframe.Everframe
import dev.everframe.config.EverframeConfig
import dev.everframe.config.ReplayConfig
import dev.everframe.config.ReportResult
import dev.everframe.devicelink.DeviceLinkFingerprint
import dev.everframe.devicelink.DeviceLinkUpload
import dev.everframe.devicelink.IngestLinkResponse
import dev.everframe.devicelink.LinkNonce
import dev.everframe.devicelink.LinkPending
import dev.everframe.identity.IdentityTokenHolder
import dev.everframe.outbox.JSONLOutbox
import dev.everframe.outbox.JceTestOutboxKeyProvider
import dev.everframe.outbox.JvmOutboxFileOps
import dev.everframe.outbox.OutboxEntry
import dev.everframe.testing.takeRequestOrFail
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class DeviceLinkUploadTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var server: MockWebServer
    private lateinit var submitter: ReportSubmitter
    private lateinit var outbox: JSONLOutbox
    private lateinit var outboxFile: File
    private val token = "evf_dev_" + "Tk9z".repeat(8)
    private val otherToken = "evf_dev_" + "Ot4r".repeat(8)
    private val uuid = "6c1e2f6a-1b7e-4b43-9a55-0e0c2b8f3e10"
    private val pendings = CopyOnWriteArrayList<LinkPending>()
    private var storedToken: String? = null
    private var linkLoaded = true
    private val ingestResponses = LinkedBlockingQueue<MockResponse>()
    private val ingestSeen = AtomicInteger()
    private lateinit var http: OkHttpClient

    @Before
    fun setUp() {
        Everframe.captureGate = true
        server = MockWebServer()
        // A drain first asks the entry's own route for config (`ReportAuthorizationFactory.forPending`); answer
        // those apart from the ingest queue so each test scripts only its uploads.
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path?.startsWith("/api/config") == true) return MockResponse().setResponseCode(404)
                ingestSeen.incrementAndGet()
                return ingestResponses.poll(5, TimeUnit.SECONDS) ?: MockResponse().setResponseCode(500)
            }
        }
        server.start()
        http = OkHttpClient.Builder()
            .connectTimeout(2, TimeUnit.SECONDS)
            .readTimeout(1, TimeUnit.SECONDS)
            .writeTimeout(2, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .build()
        outboxFile = File(tmp.newFolder("dev.everframe"), "outbox.jsonl")
        outbox = JSONLOutbox(outboxFile, keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps())
        submitter = ReportSubmitter(
            config = EverframeConfig(appId = "app-id", sdkKey = "test-sdk-key"),
            outbox = outbox,
            uploader = MultipartUploader(http),
            endpointOverride = server.url("/api/ingest").toString(),
        )
        submitter.deviceLinkTokenLookup = { _, _ -> storedToken }
        submitter.deviceLinkLoaded = { linkLoaded }
    }

    @After
    fun tearDown() {
        dev.everframe.devicelink.DeviceLink.__resetForTesting()
        server.shutdown()
        Everframe.captureGate = false
    }

    private fun link(nonce: String = LinkNonce.generate()) = DeviceLinkUpload(nonce) { pendings += it }

    private suspend fun submit(deviceLink: DeviceLinkUpload?, captureToken: String? = token): ReportResult =
        submitter.submit(
            envelopeBytes = "{}".toByteArray(),
            idempotencyKey = "idem-${System.nanoTime()}",
            attachments = emptyList(),
            captureToken = captureToken,
            deviceLink = deviceLink,
        )

    /** The next ingest POST, skipping drain-time config fetches. */
    private fun takeIngest(): RecordedRequest {
        while (true) {
            val req = server.takeRequestOrFail()
            if (req.path?.startsWith("/api/config") != true) return req
        }
    }

    private fun ingestCount(): Int = ingestSeen.get()

    private fun entries(): List<OutboxEntry> = runBlocking { outbox.hydrate() }

    private fun drain() = runBlocking {
        submitter.drainOutbox(IdentityTokenHolder(), { ReplayConfig.OFF }, 0, { 0 })
    }

    private fun storedFilesContain(secret: String): Boolean =
        outboxFile.parentFile!!.walkTopDown().filter { it.isFile }
            .any { String(it.readBytes(), Charsets.ISO_8859_1).contains(secret) }

    @Test
    fun nonceAndDeviceTokenRideTheUpload() = runBlocking {
        ingestResponses.add(MockResponse().setResponseCode(200).setBody("{}"))
        val nonce = LinkNonce.generate()
        val result = submit(link(nonce))
        assertTrue(result is ReportResult.Submitted)
        val req = takeIngest()
        assertTrue(req.getHeader(IngestLinkResponse.LINK_NONCE_HEADER) == nonce)
        assertTrue(req.getHeader("X-Everframe-Capture-Token") == token)
        assertEquals("X-Everframe-Link-Nonce", IngestLinkResponse.LINK_NONCE_HEADER)
    }

    @Test
    fun noNonceHeaderWithoutDeviceLink() = runBlocking {
        ingestResponses.add(MockResponse().setResponseCode(200).setBody("{}"))
        submit(deviceLink = null, captureToken = "cap_tok_1")
        val req = takeIngest()
        assertNull(req.getHeader("X-Everframe-Link-Nonce"))
        assertEquals("cap_tok_1", req.getHeader("X-Everframe-Capture-Token"))
    }

    @Test
    fun linkPendingInA200BodyIsDelivered() = runBlocking {
        ingestResponses.add(
            MockResponse().setResponseCode(200)
                .setBody("""{"reportId":"r1","linkPending":{"attemptId":"$uuid","number":47}}"""),
        )
        val result = submit(link())
        assertTrue(result is ReportResult.Submitted)
        assertEquals(listOf(LinkPending(uuid, 47)), pendings.toList())
    }

    @Test
    fun linkPendingIsParsedInReleaseToo() = runBlocking {
        // The success body is read for a linked upload whatever the build type; the DEBUG-only
        // `responseBodyPreview` is not what feeds it.
        ingestResponses.add(
            MockResponse().setResponseCode(200)
                .setBody("""{"reportId":"r1","linkPending":{"attemptId":"$uuid","number":3}}"""),
        )
        val http = OkHttpClient.Builder().readTimeout(1, TimeUnit.SECONDS).build()
        val result = MultipartUploader(http).upload(
            endpoint = server.url("/").toString(),
            sdkKey = "k",
            idempotencyKey = "i",
            envelopeBytes = "{}".toByteArray(),
            attachments = emptyList(),
            captureToken = token,
            linkNonce = LinkNonce.generate(),
        )
        assertEquals(LinkPending(uuid, 3), IngestLinkResponse.parseLinkPending(result.successBody))

        ingestResponses.add(MockResponse().setResponseCode(200).setBody("""{"linkPending":{"attemptId":"x","number":1}}"""))
        val unlinked = MultipartUploader(http).upload(
            endpoint = server.url("/").toString(),
            sdkKey = "k",
            idempotencyKey = "i2",
            envelopeBytes = "{}".toByteArray(),
            attachments = emptyList(),
        )
        assertNull("no nonce, no success body", unlinked.successBody)
    }

    @Test
    fun no200CallbackWithoutLinkPendingOrWithGarbage() = runBlocking {
        listOf("{}", "not json", """{"linkPending":{"number":"x"}}""", """{"linkPending":null}""").forEach { body ->
            ingestResponses.add(MockResponse().setResponseCode(200).setBody(body))
            assertTrue(body, submit(link()) is ReportResult.Submitted)
        }
        assertTrue(pendings.isEmpty())
    }

    @Test
    fun callbackThrowingNeverFailsTheSubmit() = runBlocking {
        ingestResponses.add(
            MockResponse().setResponseCode(200).setBody("""{"linkPending":{"attemptId":"$uuid","number":47}}"""),
        )
        val throwing = DeviceLinkUpload(LinkNonce.generate()) { error("boom") }
        assertTrue(submit(throwing) is ReportResult.Submitted)
    }

    @Test
    fun deviceUnlinked403IsACancelledResultNotAThrow() = runBlocking {
        ingestResponses.add(MockResponse().setResponseCode(403).setBody("""{"error":"device_unlinked"}"""))
        val result = submit(link())
        assertEquals(ReportResult.Cancelled(IngestLinkResponse.DEVICE_UNLINKED), result)
        assertEquals("device_unlinked", IngestLinkResponse.DEVICE_UNLINKED)
        assertTrue(entries().isEmpty())
    }

    @Test
    fun other403StillThrowsServerError() = runBlocking {
        ingestResponses.add(MockResponse().setResponseCode(403).setBody("""{"error":"forbidden"}"""))
        try {
            submit(link())
            fail("expected ServerError")
        } catch (e: EverframeTransportError.ServerError) {
            assertEquals(403, e.statusCode)
        }
        // Without a device link, even a device_unlinked body keeps today's terminal throw.
        ingestResponses.add(MockResponse().setResponseCode(403).setBody("""{"error":"device_unlinked"}"""))
        try {
            submit(deviceLink = null, captureToken = null)
            fail("expected ServerError")
        } catch (e: EverframeTransportError.ServerError) {
            assertEquals(403, e.statusCode)
        }
    }

    @Test
    fun transientFailureWithDeviceLinkQueuesWithFingerprint() = runBlocking {
        ingestResponses.add(MockResponse().setResponseCode(503))
        val nonce = LinkNonce.generate()
        val result = submit(link(nonce))
        assertTrue("expected Queued, got $result", result is ReportResult.Queued)
        val entry = entries().single()
        assertEquals(DeviceLinkFingerprint.of(token), entry.deviceLinkFingerprint)
        assertFalse(storedFilesContain(token))
        assertFalse(storedFilesContain(nonce))
        assertFalse(entry.toString().contains(token))

        // Network failure queues the same way.
        ingestResponses.add(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        assertTrue(submit(link()) is ReportResult.Queued)
        assertEquals(2, entries().count { it.deviceLinkFingerprint == DeviceLinkFingerprint.of(token) })
    }

    @Test
    fun linkedCaptureWithoutAUsableTokenIsNotQueued() = runBlocking {
        ingestResponses.add(MockResponse().setResponseCode(503))
        assertEquals(ReportResult.Cancelled(IngestLinkResponse.NOT_QUEUED), submit(link(), captureToken = "evf_cap_x"))
        assertTrue(entries().isEmpty())
    }

    @Test
    fun drainSendsQueuedLinkedCaptureOnlyWithTheSameToken() {
        // Same token stored: sent with it, and without a link nonce.
        ingestResponses.add(MockResponse().setResponseCode(503))
        runBlocking { assertTrue(submit(link()) is ReportResult.Queued) }
        takeIngest()
        storedToken = token
        ingestResponses.add(MockResponse().setResponseCode(200).setBody("{}"))
        drain()
        val drained = takeIngest()
        assertTrue(drained.getHeader("X-Everframe-Capture-Token") == token)
        assertNull(drained.getHeader("X-Everframe-Link-Nonce"))
        assertTrue(entries().isEmpty())

        // Token replaced, then cleared: the entry is deleted and nothing is sent.
        listOf(otherToken, null).forEach { replacement ->
            ingestResponses.add(MockResponse().setResponseCode(503))
            runBlocking { assertTrue(submit(link()) is ReportResult.Queued) }
            takeIngest()
            storedToken = replacement
            val before = ingestCount()
            drain()
            assertEquals(before, ingestCount())
            assertTrue(entries().isEmpty())
        }
    }

    @Test
    fun drainKeepsALinkedCaptureUntilTheStoredLinkHasLoaded() {
        ingestResponses.add(MockResponse().setResponseCode(503))
        runBlocking { assertTrue(submit(link()) is ReportResult.Queued) }
        takeIngest()
        linkLoaded = false
        storedToken = null
        val before = ingestCount()
        drain()
        assertEquals(before, ingestCount())
        assertEquals(1, entries().size)
        linkLoaded = true
        storedToken = token
        ingestResponses.add(MockResponse().setResponseCode(200).setBody("{}"))
        drain()
        assertTrue(takeIngest().getHeader("X-Everframe-Capture-Token") == token)
        assertTrue(entries().isEmpty())
    }

    @Test
    fun aQueuedLinkedCaptureSurvivesASwitchToAnUnlinkedScope() {
        // Production lookups: the token is resolved for the ENTRY's scope, not the active one.
        val production = ReportSubmitter(
            config = EverframeConfig(appId = "app-id", sdkKey = "test-sdk-key"),
            outbox = outbox,
            uploader = MultipartUploader(http),
            endpointOverride = server.url("/api/ingest").toString(),
        )
        val linkStore = dev.everframe.devicelink.DeviceLinkStore(
            File(tmp.newFolder("link"), "device-link-v1.bin"),
            dev.everframe.devicelink.JceTestDeviceLinkKeyProvider(),
        )
        val scopeA = dev.everframe.devicelink.DeviceLinkScope.of(server.url("/api/ingest").toString(), "test-sdk-key")!!
        val scopeB = dev.everframe.devicelink.DeviceLinkScope.of("https://other.example", "other-key")!!
        assertTrue(linkStore.save(dev.everframe.devicelink.StoredDeviceLink(token, dev.everframe.devicelink.DeviceLinkOwner.Team, scopeA)))
        val device = { dev.everframe.devicelink.HelloDevice(model = "m", osVersion = "15", appVersion = "1", sdk = "android/x", formFactor = "phone") }
        dev.everframe.devicelink.DeviceLink.install(linkStore, dev.everframe.devicelink.DeviceLinkTest.FakeClient(), scopeA, device, { true })
        ingestResponses.add(MockResponse().setResponseCode(503))
        runBlocking { assertTrue(production.submit("{}".toByteArray(), "idem-a", emptyList(), captureToken = token, deviceLink = link()) is ReportResult.Queued) }
        takeIngest()

        // start(B): a project this device is not linked to.
        dev.everframe.devicelink.DeviceLink.install(linkStore, dev.everframe.devicelink.DeviceLinkTest.FakeClient(), scopeB, device, { true })
        assertNull(dev.everframe.devicelink.DeviceLink.current)
        val before = ingestCount()
        ingestResponses.add(MockResponse().setResponseCode(200).setBody("{}"))
        runBlocking { production.drainOutbox(IdentityTokenHolder(), { ReplayConfig.OFF }, 0, { 0 }) }
        assertEquals("A's capture is still delivered, with A's token", before + 1, ingestCount())
        assertTrue(takeIngest().getHeader("X-Everframe-Capture-Token") == token)
        assertTrue(entries().isEmpty())
    }

    @Test
    fun drainDropsALinkedCaptureTheServerRefusesAsUnlinked() {
        ingestResponses.add(MockResponse().setResponseCode(503))
        runBlocking { assertTrue(submit(link()) is ReportResult.Queued) }
        takeIngest()
        storedToken = token
        ingestResponses.add(MockResponse().setResponseCode(403).setBody("""{"error":"device_unlinked"}"""))
        drain()
        takeIngest()
        assertTrue(entries().isEmpty())
    }

    @Test
    fun oldOutboxEntriesWithoutFingerprintStillDrain() {
        // An entry as written before this change: no fingerprint field at all.
        runBlocking {
            outbox.enqueue(
                OutboxEntry(
                    reportId = "11111111-1111-4111-8111-111111111111",
                    createdAt = 1L,
                    envelopeBytes = "{}".toByteArray(),
                    idempotencyKey = "idem-old",
                    attachmentRefs = emptyList(),
                    sdkKey = "test-sdk-key",
                    endpoint = server.url("/api/ingest").toString(),
                ),
            )
        }
        assertNull(entries().single().deviceLinkFingerprint)
        storedToken = null
        ingestResponses.add(MockResponse().setResponseCode(200).setBody("{}"))
        drain()
        val req = takeIngest()
        assertNull(req.getHeader("X-Everframe-Capture-Token"))
        assertTrue(entries().isEmpty())
    }

    @Test
    fun transientFailureWithoutDeviceLinkStillQueues() = runBlocking {
        ingestResponses.add(MockResponse().setResponseCode(503))
        assertTrue(submit(deviceLink = null, captureToken = null) is ReportResult.Queued)
        assertNull(entries().single().deviceLinkFingerprint)
    }

    @Test
    fun parseLinkPendingBounds() {
        fun body(number: String, id: String? = "\"$uuid\"") =
            """{"linkPending":{${id?.let { "\"attemptId\":$it," } ?: ""}"number":$number}}"""
        assertEquals(LinkPending(uuid, 0), IngestLinkResponse.parseLinkPending(body("0")))
        assertEquals(LinkPending(uuid, 99), IngestLinkResponse.parseLinkPending(body("99")))
        listOf(body("100"), body("-1"), body("4.5"), body("\"4\""), body("4", id = null),
            body("4", id = "\"${"a".repeat(65)}\""), body("4", id = "\"\""), null, "", "[]").forEach {
            assertNull(it, IngestLinkResponse.parseLinkPending(it))
        }
    }

    @Test
    fun isDeviceUnlinkedNeedsThe403AndTheCode() {
        assertTrue(IngestLinkResponse.isDeviceUnlinked(403, """{"error":"device_unlinked"}"""))
        assertFalse(IngestLinkResponse.isDeviceUnlinked(401, """{"error":"device_unlinked"}"""))
        assertFalse(IngestLinkResponse.isDeviceUnlinked(403, """{"error":"forbidden"}"""))
        assertFalse(IngestLinkResponse.isDeviceUnlinked(403, "device_unlinked"))
        assertFalse(IngestLinkResponse.isDeviceUnlinked(403, null))
    }

    @Test
    fun fingerprintIsTheFirst8BytesOfSha256() {
        val fp = DeviceLinkFingerprint.of(token)
        assertTrue(Regex("^[0-9a-f]{16}$").matches(fp))
        val full = MessageDigest.getInstance("SHA-256").digest(token.toByteArray()).joinToString("") { "%02x".format(it) }
        assertEquals(full.take(16), fp)
        assertFalse(fp == DeviceLinkFingerprint.of(otherToken))
    }

    @Test
    fun deviceLinkUploadToStringRedactsTheNonce() {
        val nonce = LinkNonce.generate()
        assertFalse(DeviceLinkUpload(nonce) {}.toString().contains(nonce))
    }
}
