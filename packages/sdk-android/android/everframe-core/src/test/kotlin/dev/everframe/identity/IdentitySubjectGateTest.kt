// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The invariant: a token is attached only when its `sub` equals the identity
// the report was CAPTURED under — not the identity active at submit or drain
// time.
//
// Kotlin twin of packages/sdk-ios/Tests/EverframeTests/IdentitySubjectGateTests.swift
// (native identity Task 3) — same seven cases, plus one Android-specific
// sibling assertion (see the last test below).
//
// Decode-path note: unlike iOS, `ReplayConfig` here IS a plain public data
// class (not routed through a Decodable-only wire type), so fixture configs
// are built directly rather than through `ReplayConfigProvider.refresh()` —
// no divergence from the spec, just less ceremony to reach an equivalent
// fixture.
//
// `OutboxEntry.identitySubject` is the one place the platforms genuinely
// differ (see that field's KDoc in JSONLOutbox.kt): Swift's synthesized
// `Codable` decodes a missing optional as `nil` for free, but kotlinx throws
// `MissingFieldException` without a `= null` default and `decodeLineOrNull`
// would drop the entry. The legacy-decode test below is therefore
// load-bearing here in a way it is not on iOS, and the sibling test proves
// `sdkKey`'s no-default behaviour (PR #63) survives untouched alongside it.
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

    @Test
    fun `a legacy entry without the field still decodes`() = runTest {
        // Deliberately UNLIKE sdkKey/endpoint, whose absence drops the entry
        // (PR #63): here a missing subject means "anonymous", which is the
        // fail-closed direction, so an older queued report keeps submitting
        // instead of being discarded.
        val full = Json { encodeDefaults = true }.encodeToString(OutboxEntry.serializer(), entry())
        val legacy = full.replace(Regex(""","identitySubject":(null|"[^"]*")"""), "")
        assertFalse("identitySubject must be stripped from the fixture", legacy.contains("identitySubject"))
        assertEquals(
            "sdkKey must survive untouched",
            true,
            legacy.contains("\"sdkKey\":\"sdk_test\""),
        )

        val f = File(tmp.newFolder(), "outbox.jsonl")
        f.parentFile?.mkdirs()
        f.writeText(legacy + "\n")

        val hydrated = JSONLOutbox(f, keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps()).hydrate()
        assertEquals("a legacy line missing only identitySubject must still hydrate", 1, hydrated.size)
        assertNull(hydrated[0].identitySubject)
    }

    /**
     * The sibling this task's brief calls for: proves `sdkKey`'s no-default,
     * drop-on-decode-failure behaviour (PR #63) is untouched by the new
     * `identitySubject = null` default above. `OutboxKeyBindingTest` pins the
     * same behaviour from the outbox side; this copy lives here so the two
     * fields' opposite legacy-decode contracts can never be conflated by a
     * later edit to either file in isolation.
     */
    @Test
    fun `a legacy line missing sdkKey is still dropped`() = runTest {
        val full = Json { encodeDefaults = true }.encodeToString(OutboxEntry.serializer(), entry(identitySubject = "alice"))
        val legacy = full.replace(Regex(""","sdkKey":"[^"]*""""), "")
        assertFalse("sdkKey must be stripped from the fixture", legacy.contains("sdkKey"))
        assertEquals(
            "identitySubject must survive untouched",
            true,
            legacy.contains("\"identitySubject\":\"alice\""),
        )

        val f = File(tmp.newFolder(), "outbox.jsonl")
        f.parentFile?.mkdirs()
        f.writeText(legacy + "\n")

        assertEquals(
            "an entry missing sdkKey cannot be routed and must not hydrate, even though identitySubject was present",
            0,
            JSONLOutbox(f, keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps()).hydrate().size,
        )
    }
}
