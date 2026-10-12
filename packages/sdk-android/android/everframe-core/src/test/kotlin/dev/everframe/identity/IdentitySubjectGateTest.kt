// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The invariant: a token is attached only when its `sub` equals the identity
// the report was CAPTURED under — not the identity active at submit or drain
// time.
//
// Kotlin twin of packages/sdk-ios/Tests/EverframeTests/IdentitySubjectGateTests.swift
// (native identity Task 3) — same cases.
//
// Decode-path note: unlike iOS, `ReplayConfig` here IS a plain public data
// class (not routed through a Decodable-only wire type), so fixture configs
// are built directly rather than through `ReplayConfigProvider.refresh()` —
// no divergence from the spec, just less ceremony to reach an equivalent
// fixture.
//
package dev.everframe.identity

import dev.everframe.outbox.JceTestOutboxKeyProvider
import dev.everframe.outbox.JvmOutboxFileOps

import dev.everframe.config.IdentityConfigWire
import dev.everframe.config.ReplayConfig
import dev.everframe.outbox.JSONLOutbox
import dev.everframe.outbox.OutboxEntry
import java.io.File
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class IdentitySubjectGateTest {

    @get:Rule
    val tmp = TemporaryFolder()

    /** Build an unsigned-but-well-formed JWT. Mirrors `IdentityTokenHolderTest.jwt`. */
    private fun jwt(sub: String, expMs: Long): String {
        val payload = buildJsonObject {
            put("sub", sub)
            put("exp", expMs / 1000)
        }
        val header = """{"alg":"HS256","typ":"JWT"}"""
        fun b64(s: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(s.toByteArray(Charsets.UTF_8))
        return "${b64(header)}.${b64(payload.toString())}.not-a-real-signature"
    }

    private fun enabledConfig(): ReplayConfig = ReplayConfig(
        replayEnabled = true,
        replayDurationSec = 30,
        samplingRate = 1.0,
        identity = IdentityConfigWire(enabled = true),
    )

    private fun disabledConfig(): ReplayConfig = ReplayConfig(
        replayEnabled = true,
        replayDurationSec = 30,
        samplingRate = 1.0,
    )

    @Test
    fun `attaches when the subject matches`() = runTest {
        val now = System.currentTimeMillis()
        val holder = IdentityTokenHolder()
        val t = jwt(sub = "alice", expMs = now + 300_000)
        holder.set(IdentityTokenSource.Token(t))
        val got = resolveIdentityHeader(capturedSubject = "alice", holder = holder, config = enabledConfig(), nowMs = now)
        assertEquals(t, got)
    }

    @Test
    fun `withholds when the identity changed after capture`() = runTest {
        // Alice opens the reporter and starts typing; Bob signs in before she
        // hits Send. Her report must not ship carrying Bob's credential.
        val now = System.currentTimeMillis()
        val holder = IdentityTokenHolder()
        holder.set(IdentityTokenSource.Token(jwt(sub = "bob", expMs = now + 300_000)))
        val got = resolveIdentityHeader(capturedSubject = "alice", holder = holder, config = enabledConfig(), nowMs = now)
        assertNull(got)
    }

    @Test
    fun `withholds for a report captured anonymously`() = runTest {
        // Captured with nobody signed in. A token acquired afterwards must not
        // retroactively attribute it.
        val now = System.currentTimeMillis()
        val holder = IdentityTokenHolder()
        holder.set(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now + 300_000)))
        val got = resolveIdentityHeader(capturedSubject = null, holder = holder, config = enabledConfig(), nowMs = now)
        assertNull(got)
    }

    @Test
    fun `withholds when identity is disabled for the project`() = runTest {
        val now = System.currentTimeMillis()
        val holder = IdentityTokenHolder()
        holder.set(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now + 300_000)))
        val got = resolveIdentityHeader(capturedSubject = "alice", holder = holder, config = disabledConfig(), nowMs = now)
        assertNull(got)
    }

    @Test
    fun `withholds when the token has gone stale`() = runTest {
        val now = System.currentTimeMillis()
        val holder = IdentityTokenHolder()
        holder.set(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now - 1_000)))
        val got = resolveIdentityHeader(capturedSubject = "alice", holder = holder, config = enabledConfig(), nowMs = now)
        assertNull(got)
    }

    private fun entry(identitySubject: String? = null) = OutboxEntry(
        reportId = UUID.randomUUID().toString(),
        createdAt = 0L,
        envelopeBytes = "{}".toByteArray(Charsets.UTF_8),
        idempotencyKey = "k",
        attachmentRefs = emptyList(),
        sdkKey = "sdk_test",
        endpoint = "https://example.test",
        identitySubject = identitySubject,
    )

    @Test
    fun `outbox entry round trips the subject`() {
        val json = Json { encodeDefaults = true }
        val encoded = json.encodeToString(OutboxEntry.serializer(), entry(identitySubject = "alice"))
        val decoded = json.decodeFromString(OutboxEntry.serializer(), encoded)
        assertEquals("alice", decoded.identitySubject)
    }
}
