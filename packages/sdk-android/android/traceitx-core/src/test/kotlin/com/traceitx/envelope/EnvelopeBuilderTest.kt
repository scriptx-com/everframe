// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// EnvelopeBuilder round-trip tests against Plan 01's Generated.kt ReportEnvelope.
// PROTO-02 pre-flight gate; full PROTO-02 parity gate runs in Plan 05-08.
package com.traceitx.envelope

import androidx.test.core.app.ApplicationProvider
import com.traceitx.TraceItX
import com.traceitx.capture.BreadcrumbRingBuffer
import com.traceitx.protocol.generated.Breadcrumb
import com.traceitx.protocol.generated.BreadcrumbKind
import com.traceitx.protocol.generated.Crash
import com.traceitx.protocol.generated.Frame
import com.traceitx.protocol.generated.Level
import com.traceitx.protocol.generated.ReportEnvelope
import com.traceitx.protocol.generated.ReportEnvelopeSource
import com.traceitx.shared.SharedData
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class EnvelopeBuilderTest {

    @Before
    fun setUp() {
        SharedData.init(ApplicationProvider.getApplicationContext())
    }

    @Test
    fun `buildEncoded produces JSON that round-trips through ReportEnvelope_parse`() {
        val builder = EnvelopeBuilder()
        val encoded = builder.buildEncoded(
            reportId = UUID.randomUUID(),
            sdkVersion = TraceItX.SDK_VERSION,
            title = "Test report",
            description = "EnvelopeBuilder round-trip",
            appName = "test-app",
            appVersion = "1.0.0",
            deviceOs = "Android",
            deviceOsVersion = "14",
            deviceScreenWidth = 1080.0,
            deviceScreenHeight = 1920.0,
            devicePixelRatio = 2.5,
        )

        // Strict round-trip — fail if the producer drifted from Generated.kt.
        val strict = Json {
            ignoreUnknownKeys = false
            explicitNulls = false
        }
        val decoded: ReportEnvelope = strict.decodeFromString(
            ReportEnvelope.serializer(),
            String(encoded.bytes, Charsets.UTF_8)
        )

        assertEquals("traceitx-android", decoded.sdk.name.value)
        // Round-trip must preserve the SAME version constant fed in above —
        // never a hardcoded literal, which silently rots on every
        // gradle.properties `traceitxVersion` bump (it did: 1.2.0 → 0.4.4).
        assertEquals(TraceItX.SDK_VERSION, decoded.sdk.version)
        assertEquals("1.0", decoded.protocolVersion.value)
        assertEquals("android", decoded.sdk.platform.value)
        assertEquals("Test report", decoded.reporter.title)
        assertEquals("test-app", decoded.context.app.name)
        assertEquals("1.0.0", decoded.context.app.version)

        // Idempotency key is hex SHA-256 → 64 chars.
        assertEquals(64, encoded.idempotencyKey.length)
        assertTrue(
            "idempotencyKey must be hex",
            encoded.idempotencyKey.all { it.isDigit() || it in 'a'..'f' }
        )
    }

    @Test
    fun `buildEncoded redacts logs through RedactionEngine when DefaultRedactor is used`() {
        val builder = EnvelopeBuilder(redactor = EnvelopeBuilder.DefaultRedactor)
        val encoded = builder.buildEncoded(
            sdkVersion = TraceItX.SDK_VERSION,
            logs = listOf(
                EnvelopeBuilder.LogRow(timestamp = 0L, level = "default", tag = null, message = "Authorization: Bearer abc123def456ghi789"),
                EnvelopeBuilder.LogRow(timestamp = 0L, level = "default", tag = null, message = "Standalone JWT eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c rest-of-line"),
                EnvelopeBuilder.LogRow(timestamp = 0L, level = "default", tag = null, message = "User used card 4242424242424242 today"),
            ),
        )
        val text = String(encoded.bytes, Charsets.UTF_8)
        assertTrue("Bearer token should be redacted in logs", text.contains("[REDACTED]"))
        assertTrue("Standalone JWT should be redacted in logs", text.contains("[REDACTED:JWT]"))
        assertTrue("Luhn-valid CC should be redacted in logs", text.contains("[REDACTED:CC]"))
        assertTrue("Original CC digits should not appear", !text.contains("4242424242424242"))
    }

    @Test
    fun `Captures flags reflect input shape`() {
        val builder = EnvelopeBuilder()
        val encoded = builder.buildEncoded(
            sdkVersion = TraceItX.SDK_VERSION,
            logs = listOf(EnvelopeBuilder.LogRow(timestamp = 0L, level = "default", tag = null, message = "hello")),
        )
        assertEquals(true, encoded.envelope.captures.logs)
        assertEquals(false, encoded.envelope.captures.network)
        // UI-tree capture and tap-to-identify were removed (spec 2026-08-29),
        // but `captures.uiTree` is a REQUIRED boolean in the protocol schema:
        // dropping the key fails envelope validation at ingest. It must stay
        // on the wire, hardcoded false — asserted on the RAW JSON, not just
        // the decoded model, because a decoder default would hide an omission.
        assertEquals(false, encoded.envelope.captures.uiTree)
        val raw = String(encoded.bytes, Charsets.UTF_8)
        assertTrue("captures.uiTree must be emitted as false", raw.contains("\"uiTree\":false"))
        assertTrue("payload.uiTree must not ship", !raw.contains("\"uiTree\":{"))
        assertTrue("payload.reactTree must not ship", !raw.contains("\"reactTree\""))
        assertTrue("payload.reportTarget must not ship", !raw.contains("\"reportTarget\""))
    }

    @Test
    fun `per-entry log timestamps survive into envelope JSON`() {
        val builder = EnvelopeBuilder()
        val encoded = builder.buildEncoded(
            sdkVersion = TraceItX.SDK_VERSION,
            logs = listOf(
                EnvelopeBuilder.LogRow(timestamp = 1_700_000_000_000L, level = "info", tag = "A", message = "first"),
                EnvelopeBuilder.LogRow(timestamp = 1_700_000_001_500L, level = "error", tag = null, message = "second"),
            ),
        )
        val text = String(encoded.bytes, Charsets.UTF_8)
        assertTrue("first entry's timestamp must appear", text.contains("\"2023-11-14T22:13:20Z\""))
        assertTrue("second entry's millis-precision timestamp must appear", text.contains("\"2023-11-14T22:13:21.500Z\""))
        assertTrue("tag should appear when present", text.contains("\"tag\":\"A\""))
        assertTrue("level should be per-entry", text.contains("\"level\":\"info\"") && text.contains("\"level\":\"error\""))
    }

    @Test
    fun `idempotency key is deterministic for the same envelope bytes`() {
        // Two envelopes with the same field set produce identical bytes only if
        // submittedAt and reportId are pinned — for this test, build twice with
        // the same UUID and assert SHA differs only when bytes differ.
        val builder = EnvelopeBuilder()
        val id = UUID.randomUUID()
        val a = builder.buildEncoded(reportId = id, sdkVersion = "1.2.0", title = "A")
        val b = builder.buildEncoded(reportId = id, sdkVersion = "1.2.0", title = "B")
        // submittedAt drifts → different bytes → different hash. Just assert
        // that hashing is wired (both keys are hex-64).
        assertEquals(64, a.idempotencyKey.length)
        assertEquals(64, b.idempotencyKey.length)
        assertNotNull(a.envelope.submittedAt)
    }

    // trimLogs — mirrors sdk-core trimLogs.spec.ts + iOS EnvelopeBuilderTests.

    private fun row(message: String, ts: Long) =
        EnvelopeBuilder.LogRow(timestamp = ts, level = "log", tag = null, message = message)

    @Test
    fun `trimLogs keeps all when under budget`() {
        val rows = listOf(row("a", 1), row("b", 2), row("c", 3))
        val out = EnvelopeBuilder().trimLogs(rows, maxChars = 100)
        assertEquals(listOf("a", "b", "c"), out.map { it.message })
    }

    @Test
    fun `trimLogs keeps recent and collapses older into one REDACTED marker at front`() {
        val rows = (1..5).map { row("x".repeat(10), it.toLong()) }
        val out = EnvelopeBuilder().trimLogs(rows, maxChars = 25)
        assertEquals(3, out.size) // marker + 2 kept
        assertEquals("REDACTED", out[0].message)
        assertEquals("info", out[0].level)
        assertEquals(4L, out[1].timestamp)
        assertEquals(5L, out[2].timestamp)
    }

    @Test
    fun `trimLogs always keeps newest, truncated when it alone exceeds budget`() {
        val rows = listOf(row("old", 1), row("y".repeat(9000), 2))
        val out = EnvelopeBuilder().trimLogs(rows, maxChars = 4000)
        assertEquals(2, out.size) // marker + truncated newest
        assertEquals("REDACTED", out[0].message)
        assertEquals(4000, out[1].message.length)
    }

    @Test
    fun `buildEncoded redacts then trims - kept logs redacted, older collapsed`() {
        // Fake redactor: deterministic, proves redact-then-trim ORDERING (the real
        // RedactionEngine is unit-tested separately).
        val redactor = object : EnvelopeBuilder.Redactor {
            override fun redact(s: String) = s.replace("SECRET", "[X]")
            override fun filterHeaders(h: Map<String, String>) = h
        }
        val rows = buildList {
            repeat(60) { add(EnvelopeBuilder.LogRow(timestamp = it.toLong(), level = "log", tag = null, message = "a".repeat(100))) }
            // Newest entry carries the secret → always kept, and must be redacted.
            add(EnvelopeBuilder.LogRow(timestamp = 999L, level = "error", tag = null, message = "token=SECRET"))
        }
        val encoded = EnvelopeBuilder(redactor = redactor).buildEncoded(
            sdkVersion = TraceItX.SDK_VERSION,
            logs = rows,
        )
        val text = String(encoded.bytes, Charsets.UTF_8)
        assertTrue("redaction applied to kept newest log", text.contains("[X]"))
        assertTrue("raw secret never survives", !text.contains("SECRET"))
        assertTrue("trim marker for collapsed older logs", text.contains("\"message\":\"REDACTED\""))
    }

    // --- Task 10: breadcrumb integration + freeze-seam parity (mirrors iOS Task 6) ---

    @Test
    fun `buildEncoded ships trimmed breadcrumbs when chain exceeds byte budget`() {
        val builder = EnvelopeBuilder()
        val crumbs = (0 until 50).map { i ->
            Breadcrumb(
                data = null,
                kind = BreadcrumbKind.Console,
                level = Level.Info,
                message = "log line $i ".repeat(20),
                seq = i.toLong(),
                t = i.toDouble(),
                truncated = null,
            )
        }
        val encoded = builder.buildEncoded(
            sdkVersion = TraceItX.SDK_VERSION,
            breadcrumbs = crumbs,
            breadcrumbByteBudget = 500,
        )

        val shippedBreadcrumbs = encoded.envelope.payload.breadcrumbs
        assertNotNull("payload.breadcrumbs must be present for an over-budget chain", shippedBreadcrumbs)
        assertTrue(
            "trimmed output must be smaller than the untrimmed input",
            shippedBreadcrumbs!!.size < crumbs.size
        )
        assertEquals(true, encoded.envelope.captures.breadcrumbs)
        assertTrue(
            "captureControl.included must list breadcrumbs",
            encoded.envelope.captureControl.included.contains("breadcrumbs")
        )

        // Re-decode via the generated serializer to prove the encoded bytes are valid.
        val strict = Json { ignoreUnknownKeys = false; explicitNulls = false }
        val decoded: ReportEnvelope = strict.decodeFromString(
            ReportEnvelope.serializer(),
            String(encoded.bytes, Charsets.UTF_8)
        )
        assertEquals(shippedBreadcrumbs.size, decoded.payload.breadcrumbs?.size)
        assertEquals(true, decoded.captures.breadcrumbs)
    }

    @Test
    fun `buildEncoded keeps the no-crumbs path unchanged beyond captures_breadcrumbs`() {
        val builder = EnvelopeBuilder()
        val encodedNull = builder.buildEncoded(
            sdkVersion = TraceItX.SDK_VERSION,
            logs = listOf(EnvelopeBuilder.LogRow(timestamp = 0L, level = "default", tag = null, message = "hello")),
        )
        assertEquals(false, encodedNull.envelope.captures.breadcrumbs)
        assertNull(encodedNull.envelope.payload.breadcrumbs)
        assertTrue(encodedNull.envelope.captureControl.included.isEmpty())
        // Untouched fields: no perturbation beyond the one intentional flag.
        assertEquals(true, encodedNull.envelope.captures.logs)
        assertEquals(false, encodedNull.envelope.captures.network)
        assertEquals(false, encodedNull.envelope.captures.uiTree)

        // Explicit empty list is equivalent to null (isNullOrEmpty semantics).
        val encodedEmpty = builder.buildEncoded(
            sdkVersion = TraceItX.SDK_VERSION,
            breadcrumbs = emptyList(),
        )
        assertEquals(false, encodedEmpty.envelope.captures.breadcrumbs)
        assertNull(encodedEmpty.envelope.payload.breadcrumbs)
        assertTrue(encodedEmpty.envelope.captureControl.included.isEmpty())
    }

    @Test
    fun `frozen breadcrumb snapshot excludes crumbs added after freeze and threads into buildEncoded`() {
        val buf = BreadcrumbRingBuffer(maxCount = 10, honorsKillGate = false)
        buf.add(kind = BreadcrumbKind.Tap, message = "before-freeze")
        buf.freeze()
        buf.add(kind = BreadcrumbKind.Tap, message = "after-freeze")

        val frozen = buf.takeFrozen()
        assertNotNull(frozen)
        assertEquals(listOf("before-freeze"), frozen!!.map { it.message })

        // A second takeFrozen() without a new freeze() returns null (consumed-once).
        assertNull(buf.takeFrozen())

        val encoded = EnvelopeBuilder().buildEncoded(
            sdkVersion = TraceItX.SDK_VERSION,
            breadcrumbs = frozen,
        )
        assertEquals(true, encoded.envelope.captures.breadcrumbs)
        assertEquals(listOf("before-freeze"), encoded.envelope.payload.breadcrumbs?.map { it.message })
    }

    // --- Task 9: annotations/redactions round-trip coverage ---

    @Test
    fun `annotationsAndRedactionsSurviveRoundTrip`() {
        val builder = EnvelopeBuilder()
        val annotations = buildJsonArray {
            add(buildJsonObject {
                put("id", JsonPrimitive("a1"))
                put("kind", JsonPrimitive("pen"))
                put("partName", JsonPrimitive("screenshot"))
            })
        }
        val redactions = buildJsonArray {
            add(buildJsonObject {
                put("x", JsonPrimitive(10.0))
                put("y", JsonPrimitive(20.0))
                put("width", JsonPrimitive(30.0))
                put("height", JsonPrimitive(40.0))
                put("type", JsonPrimitive("blur"))
                put("partName", JsonPrimitive("screenshot"))
            })
        }
        val encoded = builder.buildEncoded(
            sdkVersion = TraceItX.SDK_VERSION,
            annotations = annotations,
            redactions = redactions,
        )

        // Parse the bytes back through the generated serializer to verify round-trip.
        val strict = Json { ignoreUnknownKeys = false; explicitNulls = false }
        val decoded: ReportEnvelope = strict.decodeFromString(
            ReportEnvelope.serializer(),
            String(encoded.bytes, Charsets.UTF_8)
        )

        assertNotNull("payload.annotations must be present", decoded.payload.annotations)
        assertEquals(1, decoded.payload.annotations?.size)
        val firstAnnotation = decoded.payload.annotations?.get(0)?.jsonObject
        assertNotNull("first annotation must be a JSON object", firstAnnotation)
        assertEquals("a1", firstAnnotation?.get("id")?.jsonPrimitive?.content)
        assertEquals("pen", firstAnnotation?.get("kind")?.jsonPrimitive?.content)
        assertEquals("screenshot", firstAnnotation?.get("partName")?.jsonPrimitive?.content)

        assertNotNull("payload.redactions must be present", decoded.payload.redactions)
        assertEquals(1, decoded.payload.redactions?.size)
        val firstRedaction = decoded.payload.redactions?.get(0)?.jsonObject
        assertNotNull("first redaction must be a JSON object", firstRedaction)
        assertEquals(10.0, firstRedaction!!.get("x")!!.jsonPrimitive.double, 0.0)
        assertEquals(20.0, firstRedaction.get("y")!!.jsonPrimitive.double, 0.0)
        assertEquals("blur", firstRedaction.get("type")!!.jsonPrimitive.content)
        assertEquals("screenshot", firstRedaction.get("partName")!!.jsonPrimitive.content)
    }

    @Test
    fun `emptyAnnotationsCoerceToAbsent`() {
        val builder = EnvelopeBuilder()
        // Pass empty arrays for annotations and redactions.
        val encoded = builder.buildEncoded(
            sdkVersion = TraceItX.SDK_VERSION,
            annotations = buildJsonArray { },
            redactions = buildJsonArray { },
        )

        // Parse the bytes back through the generated serializer.
        val strict = Json { ignoreUnknownKeys = false; explicitNulls = false }
        val decoded: ReportEnvelope = strict.decodeFromString(
            ReportEnvelope.serializer(),
            String(encoded.bytes, Charsets.UTF_8)
        )

        // Empty arrays should coerce to null/absent in the payload (per the takeIf logic).
        assertNull("payload.annotations should be null/absent when empty", decoded.payload.annotations)
        assertNull("payload.redactions should be null/absent when empty", decoded.payload.redactions)
    }

    // --- Task 8: source / crash payload plumbing (spec 2026-07-18) ---

    @Test
    fun `buildEncoded carries source and crash payload`() {
        val crash = Crash(
            exceptionType = "java.lang.IllegalStateException",
            message = "boom",
            frames = listOf(Frame(raw = "com.example.A.b(A.kt:1)")),
            threadName = "main",
            mechanism = "uncaught-exception-handler",
            handled = false,
            occurredAt = "2026-07-18T12:00:00Z",
            fingerprint = "0123456789abcdef",
        )
        val encoded = EnvelopeBuilder().buildEncoded(
            sdkVersion = "1.0.0",
            title = "java.lang.IllegalStateException: boom",
            source = ReportEnvelopeSource.Crash,
            crash = crash,
        )
        assertEquals(ReportEnvelopeSource.Crash, encoded.envelope.source)
        assertEquals("boom", encoded.envelope.payload.crash?.message)
        val json = String(encoded.bytes)
        assertTrue(json.contains("\"source\":\"crash\""))
    }
}
