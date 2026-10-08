// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.health

import dev.everframe.config.ReleaseHealthConfig
import dev.everframe.outbox.*
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.TimeUnit

class ReleaseHealthTransportTest {
    @get:Rule val folder = TemporaryFolder()
    private val keys = JceTestOutboxKeyProvider()
    private val allowed = object : OutboxAuthorization { override fun isAllowed() = true }
    private val admission = HealthAdmission { gate, request -> if (gate()) request() else null }
    private fun store() = OutboxStore(File(folder.root, "health"), keys, JvmOutboxFileOps(), 256, 1024 * 1024, maintenanceReserveBytes = 16384)
    private fun producer(key: String, url: String) = ReleaseHealthProducer(store(), ReleaseHealthConfig("native-A"), "test", key, url, allowed, allowed)
    @Test fun `real HTTP retry preserves frozen credentials endpoint and JSON bytes`() = runBlocking {
        MockWebServer().use { a -> MockWebServer().use { b ->
            a.start(); b.start()
            a.enqueue(MockResponse().setResponseCode(503)); a.enqueue(MockResponse().setResponseCode(201))
            val original = producer("key-A", a.url("/api/ingest/release-health").toString()); assertTrue(original.start())
            val later = producer("key-B", b.url("/api/ingest/release-health").toString())
            val transport = OkHttpHealthTransport()
            assertEquals(0, later.flush(transport, admission)); assertEquals(1, later.flush(transport, admission))
            val first = a.takeRequest(2, TimeUnit.SECONDS)!!; val retry = a.takeRequest(2, TimeUnit.SECONDS)!!
            assertEquals("Bearer key-A", first.getHeader("Authorization"))
            assertEquals("/api/ingest/release-health", first.path)
            assertEquals(first.getHeader("X-Everframe-Idempotency-Key"), retry.getHeader("X-Everframe-Idempotency-Key"))
            assertEquals(first.body.readUtf8(), retry.body.readUtf8())
            assertEquals(0, b.requestCount); assertTrue(store().snapshotTokens().isEmpty())
        } }
    }
    @Test fun `redirect cannot move a frozen authenticated record to another host`() = runBlocking {
        MockWebServer().use { a -> MockWebServer().use { b ->
            a.start(); b.start()
            a.enqueue(MockResponse().setResponseCode(307).addHeader("Location", b.url("/stolen")))
            val owner = producer("key-A", a.url("/api/ingest/release-health").toString()); assertTrue(owner.start())
            assertEquals(0, owner.flush(OkHttpHealthTransport(), admission))
            assertNotNull(a.takeRequest(2, TimeUnit.SECONDS)); assertEquals(0, b.requestCount)
            assertEquals(1, store().snapshotTokens().size)
        } }
    }
    @Test fun `backend erasure response removes a late queued record without retry`() = runBlocking {
        MockWebServer().use { server ->
            server.start(); server.enqueue(MockResponse().setResponseCode(410))
            val owner = producer("key-A", server.url("/api/ingest/release-health").toString()); assertTrue(owner.start())
            assertEquals(0, owner.flush(OkHttpHealthTransport(), admission))
            assertEquals(0, owner.flush(OkHttpHealthTransport(), admission))
            assertEquals(1, server.requestCount); assertTrue(store().snapshotTokens().isEmpty())
        }
    }
}
