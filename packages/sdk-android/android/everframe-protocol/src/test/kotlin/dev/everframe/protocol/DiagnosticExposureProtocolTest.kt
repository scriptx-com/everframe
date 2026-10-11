// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.protocol

import dev.everframe.protocol.generated.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.*
import org.junit.Test

class DiagnosticExposureProtocolTest {
    private fun pointer(build: String?) = NativeExposure(app = NativeExposureApp(build = build, version = "2.4.0"),
        exposureID = "exposure", loadedBuildID = null, loadedBundleStatus = LoadedBundleStatus.NotApplicable,
        processLaunchID = "process", startedAt = "2026-10-07T10:00:00.000Z")

    @Test fun requiredNullableBuildsSurviveDefaultEncoding() {
        val encoded = Json.parseToJsonElement(Json.encodeToString(pointer(null))).jsonObject
        assertTrue(encoded.containsKey("loadedBuildId"))
        assertEquals(JsonNull, encoded["loadedBuildId"])
        // The API links a crash to its session by comparing the whole pointer: an omitted
        // build would no longer equal the stored session's {"version", "build": null}.
        val app = encoded.getValue("app").jsonObject
        assertTrue(app.containsKey("build"))
        assertEquals(JsonNull, app["build"])
        assertEquals("2.4.0", app.getValue("version").jsonPrimitive.content)
        assertFalse(encoded.containsKey("native" + "BuildId")) // the retired field, spelled in two parts for the repository check
    }
    @Test fun appRoundTripsWithABuild() {
        val decoded = Json.decodeFromString<NativeExposure>(Json.encodeToString(pointer("412")))
        assertEquals(NativeExposureApp(build = "412", version = "2.4.0"), decoded.app)
    }
    @Test fun envelopeAppKeepsItsGeneratedName() {
        // If quicktype renamed the envelope's App to tell it from the pointer's app, this stops compiling.
        val app: dev.everframe.protocol.generated.App = App(build = "412", name = "dev.example", version = "2.4.0")
        assertEquals("2.4.0", app.version)
    }
    @Test fun legacyPositionalConstructorDoesNotRequireExposure() {
        val source = Json.decodeFromString<DiagnosticEvidence>("""
            {"version":1,"evidenceId":"11111111-1111-4111-8111-111111111111","processLaunchId":"22222222-2222-4222-8222-222222222222","kind":"process_exit","provenance":"android_application_exit_info","scope":"os_process","outcome":"terminated","cause":"anr","occurredAt":"2026-10-07T10:00:00.000Z","collectedAt":"2026-10-07T10:01:00.000Z","attribution":{"process":"exact_os_token","release":"frozen","session":"unavailable","webExposure":"unavailable"},"android":{"apiLevel":35,"reason":6,"pid":100},"trace":{"status":"unavailable","format":"none","truncated":false,"frames":[]}}
        """.trimIndent())
        val copy = DiagnosticEvidence(source.android, source.attribution, source.cause, source.collectedAt,
            source.evidenceID, source.kind, source.occurredAt, source.outcome, source.processLaunchID,
            source.provenance, source.scope, source.trace, source.version)
        assertNull(copy.nativeExposure)
        assertEquals(source.processLaunchID, copy.processLaunchID)
    }
}
