// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 8 (spec 2026-08-19) — `attach.challenge` / `attach.challenge.cleared`
// routing tests for `RelayWSClient`. Mirrors iOS
// `RelayWSClient.swift`'s `.attachChallenge` / `.attachChallengeCleared`
// cases and its terminal-close clear (see `didCloseWith`'s 4001..4004
// branch): a challenge is cleared on the terminal-close path that also
// clears `code` — NOT on the announce-failure fallback paths that precede
// any pair (those never had a challenge to begin with).
//
// Harness: same strategy as `RelayWSClientTest` — drive the WebSocketListener
// with the socket the client actually installed via a fake `OkHttpClient`, so
// the real connect/generation machinery runs underneath.

package com.traceitx.companion

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class RelayWSClientAttachChallengeTest {

    private lateinit var client: RelayWSClient
    private lateinit var okHttp: FakeWebSocketOkHttpClient
    private lateinit var fakeWs: FakeWebSocket
    private lateinit var scheduled: MutableList<Long>

    @Before
    fun setUp() {
        resetCompanion()
        scheduled = mutableListOf()
        okHttp = FakeWebSocketOkHttpClient()
        client = RelayWSClient(
            client = okHttp,
            baseUrl = "https://relay.example.test",
            scheduler = { delayMs, _ -> scheduled.add(delayMs) },
        )
        client.onStart(FakeLifecycleOwner())
        fakeWs = okHttp.sockets.last()
    }

    @After
    fun tearDown() {
        resetCompanion()
        CompanionCaptureBridge.__teardownForTesting()
    }

    /** `Companion` is a process-global Kotlin `object` — reset it, including
     *  the seam this test file exercises, so no test leaks into the next. */
    private fun resetCompanion() {
        Companion.__setState(CompanionState.Unpaired)
        Companion.__setPairUrl(null)
        Companion.__setCode(null)
        Companion.__setAttachedUserName(null)
        Companion.__setAttachChallenge(null)
    }

    // ---------------- attach.challenge ----------------

    @Test
    fun onMessage_attachChallenge_publishesAttachChallengeInfo() {
        val raw = """{"type":"attach.challenge","code":"0427","ttl_ms":60000,"requested_by_name":"Aurimas"}"""
        client.listener.onMessage(fakeWs, raw)

        val challenge = Companion.attachChallenge.value
        assertEquals(AttachChallengeInfo(code = "0427", requestedByName = "Aurimas", ttlMs = 60000L), challenge)
    }

    @Test
    fun onMessage_attachChallenge_overwritesAnyPriorChallenge() {
        client.listener.onMessage(
            fakeWs,
            """{"type":"attach.challenge","code":"0001","ttl_ms":30000,"requested_by_name":"Ada"}""",
        )
        client.listener.onMessage(
            fakeWs,
            """{"type":"attach.challenge","code":"9999","ttl_ms":45000,"requested_by_name":"Grace"}""",
        )

        assertEquals(
            AttachChallengeInfo(code = "9999", requestedByName = "Grace", ttlMs = 45000L),
            Companion.attachChallenge.value,
        )
    }

    // ---------------- attach.challenge.cleared ----------------

    @Test
    fun onMessage_attachChallengeCleared_clearsTheChallenge() {
        client.listener.onMessage(
            fakeWs,
            """{"type":"attach.challenge","code":"0427","ttl_ms":60000,"requested_by_name":"Aurimas"}""",
        )
        assertEquals("0427", Companion.attachChallenge.value?.code)

        client.listener.onMessage(fakeWs, """{"type":"attach.challenge.cleared","reason":"attached"}""")

        assertNull(Companion.attachChallenge.value)
    }

    @Test
    fun onMessage_attachChallengeCleared_everyReasonClearsIt() {
        // expired|attached|burned|superseded — every reason means "this PIN
        // is no longer live"; nothing here distinguishes them (mirrors iOS).
        for (reason in listOf("expired", "attached", "burned", "superseded")) {
            client.listener.onMessage(
                fakeWs,
                """{"type":"attach.challenge","code":"0427","ttl_ms":60000,"requested_by_name":"Aurimas"}""",
            )
            client.listener.onMessage(fakeWs, """{"type":"attach.challenge.cleared","reason":"$reason"}""")
            assertNull("reason=$reason must clear the challenge", Companion.attachChallenge.value)
        }
    }

    // ---------------- terminal close clears the challenge ----------------

    @Test
    fun onClosing_terminalCode_clearsAttachChallengeAlongsideCode() {
        client.listener.onMessage(
            fakeWs,
            """{"type":"attach.challenge","code":"0427","ttl_ms":60000,"requested_by_name":"Aurimas"}""",
        )
        Companion.__setCode("LMN-421")
        assertEquals("0427", Companion.attachChallenge.value?.code)

        client.listener.onClosing(fakeWs, RelayWSClient.CLOSE_PAIR_EXPIRED, "pair_expired")

        assertNull("a dead pair leaves no bond for a pending attach to attach to", Companion.attachChallenge.value)
        assertNull(Companion.code.value)
    }

    // ---------------- non-terminal close also clears the challenge (review finding 2) ----------------

    @Test
    fun onClosing_nonTerminalCode_alsoClearsAttachChallenge() {
        client.listener.onMessage(
            fakeWs,
            """{"type":"attach.challenge","code":"9911","ttl_ms":60000,"requested_by_name":"Priya"}""",
        )
        assertEquals("9911", Companion.attachChallenge.value?.code)

        // CLOSE_MALFORMED_FRAME is transient — the non-terminal branch, which
        // only calls `scheduleReconnect()`. The server still deleted the pair
        // on this TV-socket close, so no `attach.challenge.cleared` frame can
        // ever arrive for it — the challenge must clear immediately, not wait
        // for a terminal code.
        client.listener.onClosing(fakeWs, RelayWSClient.CLOSE_MALFORMED_FRAME, "malformed_frame")

        assertNull(Companion.attachChallenge.value)
    }

    @Test
    fun onFailure_alsoClearsAttachChallenge() {
        client.listener.onMessage(
            fakeWs,
            """{"type":"attach.challenge","code":"4242","ttl_ms":60000,"requested_by_name":"Bob"}""",
        )
        assertEquals("4242", Companion.attachChallenge.value?.code)

        client.listener.onFailure(fakeWs, java.io.IOException("boom"), null)

        assertNull(Companion.attachChallenge.value)
    }

    // ---------------- stop() also clears the challenge (review finding 2) ----------------

    @Test
    fun stop_clearsAttachChallenge() {
        client.listener.onMessage(
            fakeWs,
            """{"type":"attach.challenge","code":"0427","ttl_ms":60000,"requested_by_name":"Aurimas"}""",
        )
        assertEquals("0427", Companion.attachChallenge.value?.code)

        client.stop()

        assertNull(Companion.attachChallenge.value)
    }

    // ---------------- fakes ----------------

    private class FakeWebSocket(val listener: WebSocketListener) : WebSocket {
        val sentText: MutableList<String> = java.util.concurrent.CopyOnWriteArrayList()
        val sentBinary: MutableList<ByteString> = java.util.concurrent.CopyOnWriteArrayList()
        var cancelled: Boolean = false
            private set

        override fun queueSize(): Long = 0
        override fun send(text: String): Boolean {
            sentText.add(text); return true
        }
        override fun send(bytes: ByteString): Boolean {
            sentBinary.add(bytes); return true
        }
        override fun close(code: Int, reason: String?): Boolean = true
        override fun cancel() { cancelled = true }
        override fun request(): okhttp3.Request = okhttp3.Request.Builder().url("https://x.test").build()
    }

    private class FakeWebSocketOkHttpClient : OkHttpClient() {
        val sockets: MutableList<FakeWebSocket> = mutableListOf()

        override fun newWebSocket(
            request: okhttp3.Request,
            listener: okhttp3.WebSocketListener,
        ): WebSocket = FakeWebSocket(listener).also { sockets.add(it) }
    }

    private class FakeLifecycleOwner : LifecycleOwner {
        private val registry = LifecycleRegistry(this).apply {
            currentState = Lifecycle.State.STARTED
        }
        override val lifecycle: Lifecycle = registry
    }
}
