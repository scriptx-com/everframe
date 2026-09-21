// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Crash/error-reporting cross-SDK fixture parity — Kotlin side of the
// three-decoder gate (Task 14, mirrors CrossSDKProto02Test.kt exactly).
// Decodes the shared `crash-report.json` via the codegen-emitted
// `ReportEnvelope` (Task 1 added `source` + `payload.crash`), re-encodes
// canonically (sorted keys via JsonElement traversal), and asserts an
// idempotent round-trip. Also spot-checks that `source`/`payload.crash`
// decode into the typed generated fields, not just raw JSON.
//
// fixture-sync.spec.ts (TS) guards this file's physical copy of
// crash-report.json against drift from the canonical
// packages/protocol/__tests__/fixtures/crash-report.json.
package com.traceitx.protocol

import com.traceitx.protocol.generated.ReportEnvelope
import com.traceitx.protocol.generated.ReportEnvelopeSource
import com.traceitx.protocol.generated.Crash
import com.traceitx.protocol.generated.Frame
import com.traceitx.protocol.generated.ErrorSeverity
import com.traceitx.protocol.generated.JVMCrashMetadata
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class CrashReportCrossSDKTest {

    private val json = Json {
        ignoreUnknownKeys = false
        encodeDefaults = true
    }

    private fun fixtureBytes(): String {
        return javaClass.getResourceAsStream("/crash-report.json")!!
            .bufferedReader()
            .use { it.readText() }
    }

    private fun jvmFixtureBytes(): String {
        return javaClass.getResourceAsStream("/jvm-crash-envelope.json")!!
            .bufferedReader()
            .use { it.readText() }
    }

    private fun causeFixtureBytes(): String {
        return javaClass.getResourceAsStream("/crash-causes.json")!!
            .bufferedReader()
            .use { it.readText() }
    }

    /** Deep-sort JsonObject keys so encoding is deterministic. */
    private fun canonicalize(el: JsonElement): JsonElement = when (el) {
        is JsonObject -> buildJsonObject {
            for (k in el.keys.sorted()) {
                put(k, canonicalize(el.getValue(k)))
            }
        }
        is JsonArray -> buildJsonArray {
            el.forEach { add(canonicalize(it)) }
        }
        is JsonPrimitive -> el
    }

    @Test
    fun hermesIdentityRoundTripsExactly() {
        val raw = javaClass.getResourceAsStream("/crash-report-hermes.json")!!.bufferedReader().use { it.readText() }
        val env = json.decodeFromString<ReportEnvelope>(raw)
        assertEquals(" js-7 ", env.payload.crash?.jsBundle?.buildID)
        val encoded = json.encodeToString(env)
        val decoded = json.decodeFromString<ReportEnvelope>(encoded)
        assertEquals("index.android.bundle", decoded.payload.crash?.jsBundle?.bundleName)
        assertEquals(com.traceitx.protocol.generated.JSBundlePlatform.Android, decoded.payload.crash?.jsBundle?.platform)
        assertEquals(encoded, json.encodeToString(decoded))
    }

    @Test
    fun crashReportFixture_decodesAndReencodesIdempotently() {
        val raw = fixtureBytes()

        val env: ReportEnvelope = json.decodeFromString(raw)

        val firstEncoded = json.encodeToString(env)
        val firstCanonical = canonicalize(json.parseToJsonElement(firstEncoded))

        val env2: ReportEnvelope = json.decodeFromString(firstEncoded)
        val secondEncoded = json.encodeToString(env2)
        val secondCanonical = canonicalize(json.parseToJsonElement(secondEncoded))

        assertEquals(
            "Round-trip canonicalized JSON must be byte-identical",
            firstCanonical.toString(),
            secondCanonical.toString()
        )
    }

    @Test
    fun crashReportFixture_decodesSourceAndPayloadCrash() {
        val env: ReportEnvelope = json.decodeFromString(fixtureBytes())

        assertEquals(ReportEnvelopeSource.Crash, env.source)
        val crash = env.payload.crash
        assertNotNull("payload.crash must decode", crash)
        assertEquals("java.lang.NullPointerException", crash!!.exceptionType)
        assertEquals(16, crash.fingerprint.length)
        assertEquals(false, crash.handled)
    }

    @Test
    fun jvmCrashFixture_preservesOrderedCausesAndMappingIdentity() {
        val env = json.decodeFromString<ReportEnvelope>(jvmFixtureBytes())
        val crash = env.payload.crash
        assertNotNull("payload.crash must decode", crash)
        assertEquals("42", env.context.app.build)
        assertEquals(null, crash!!.jsBundle)

        val jvm = crash.jvm
        assertNotNull("payload.crash.jvm must decode", jvm)
        assertEquals("android-release-ci-123", jvm!!.mappingID)
        assertEquals(false, jvm.causesTruncated)
        assertEquals(2, jvm.causes.size)
        assertEquals("java.lang.IllegalArgumentException", jvm.causes[0].exceptionType)
        assertEquals("middle failure", jvm.causes[0].message)
        assertEquals("sample.Middle.run(Middle.kt:11)", jvm.causes[0].frames[0].raw)
        assertEquals("run", jvm.causes[0].frames[0].function)
        assertEquals(false, jvm.causes[0].framesTruncated)
        assertEquals("java.lang.IllegalStateException", jvm.causes[1].exceptionType)
        assertEquals("inner failure", jvm.causes[1].message)
        assertEquals("sample.Inner.fail(Inner.kt:7)", jvm.causes[1].frames[0].raw)
        assertEquals("fail", jvm.causes[1].frames[0].function)
        assertEquals(false, jvm.causes[1].framesTruncated)

        val encoded = json.encodeToString(env)
        val decoded = json.decodeFromString<ReportEnvelope>(encoded)
        val decodedJvm = decoded.payload.crash!!.jvm!!
        assertEquals("android-release-ci-123", decodedJvm.mappingID)
        assertEquals(false, decodedJvm.causesTruncated)
        assertEquals(2, decodedJvm.causes.size)
        assertEquals("java.lang.IllegalArgumentException", decodedJvm.causes[0].exceptionType)
        assertEquals("middle failure", decodedJvm.causes[0].message)
        assertEquals(false, decodedJvm.causes[0].framesTruncated)
        assertEquals("sample.Middle.run(Middle.kt:11)", decodedJvm.causes[0].frames[0].raw)
        assertEquals("run", decodedJvm.causes[0].frames[0].function)
        assertEquals("java.lang.IllegalStateException", decodedJvm.causes[1].exceptionType)
        assertEquals("inner failure", decodedJvm.causes[1].message)
        assertEquals(false, decodedJvm.causes[1].framesTruncated)
        assertEquals("sample.Inner.fail(Inner.kt:7)", decodedJvm.causes[1].frames[0].raw)
        assertEquals("fail", decodedJvm.causes[1].frames[0].function)
        assertEquals(encoded, json.encodeToString(decoded))
    }

    @Test
    fun preDetailsCrashConstructorKeepsJvmAtPositionEleven() {
        val jvm = JVMCrashMetadata(
            causes = emptyList(),
            causesTruncated = false,
            mappingID = "android-release-position-11"
        )
        val crash = Crash(
            "java.lang.RuntimeException",
            true,
            "1234567890abcdef",
            listOf(Frame(raw = "at sample.Outer.start(Outer.kt:19)")),
            false,
            null,
            "uncaught-exception-handler",
            "outer failure",
            "2026-09-09T12:00:00.000Z",
            "main",
            jvm
        )
        assertEquals("android-release-position-11", crash.jvm?.mappingID)
        assertEquals(null, crash.details)
    }

    @Test
    fun generatedCrashDetailsDecodeStructuredMetadata() {
        val crash = json.decodeFromString<Crash>(
            """{"details":{"severity":"warning","context":"checkout","metadata":{"retry":2,"flags":[true,null]}},"exceptionType":"TypeError","fingerprint":"0123456789abcdef","frames":[],"handled":true,"mechanism":"captureException","message":"boom","occurredAt":"2026-09-15T00:00:00.000Z"}"""
        )
        assertEquals(ErrorSeverity.Warning, crash.details?.severity)
        assertEquals("checkout", crash.details?.context)
        val encoded = json.encodeToJsonElement(Crash.serializer(), crash).jsonObject
        assertEquals(JsonPrimitive(2), encoded["details"]?.jsonObject?.get("metadata")?.jsonObject?.get("retry"))
        assertEquals(
            buildJsonArray { add(JsonPrimitive(true)); add(kotlinx.serialization.json.JsonNull) },
            encoded["details"]?.jsonObject?.get("metadata")?.jsonObject?.get("flags"),
        )
    }

    @Test
    fun genericCauseFixtureRoundTripsAndCopyPreservesCause() {
        val crash = json.decodeFromString<Crash>(causeFixtureBytes())
        assertEquals(listOf("TypeError", "RangeError"), crash.causeChain?.causes?.map { it.exceptionType })
        assertEquals("middle", crash.causeChain?.causes?.first()?.frames?.first()?.function)

        val copied = crash.copy(message = "copied")
        assertEquals("TypeError", copied.causeChain?.causes?.first()?.exceptionType)
        assertEquals(crash.causeChain, crash.component13())
        val generatedCopy = crash.copy(causeChain = crash.causeChain, message = "generated-copy")
        assertEquals("TypeError", generatedCopy.causeChain?.causes?.first()?.exceptionType)

        val encoded = json.encodeToString(Crash.serializer(), copied)
        val decoded = json.decodeFromString<Crash>(encoded)
        assertEquals("copied", decoded.message)
        assertEquals("root-range", decoded.causeChain?.causes?.get(1)?.message)
    }
}
