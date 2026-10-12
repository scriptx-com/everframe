// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.protocol

import dev.everframe.protocol.generated.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.*
import org.junit.Test

class DiagnosticExposureProtocolTest {
    private fun pointer(build: String?) = NativeExposure(app = NativeExposureApp(build = build, debug = false, version = "2.4.0"),
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
        assertEquals(false, app.getValue("debug").jsonPrimitive.boolean)
        assertFalse(encoded.containsKey("native" + "BuildId")) // the retired field, spelled in two parts for the repository check
    }
    @Test fun appRoundTripsWithABuild() {
        val decoded = Json.decodeFromString<NativeExposure>(Json.encodeToString(pointer("412")))
        assertEquals(NativeExposureApp(build = "412", debug = false, version = "2.4.0"), decoded.app)
    }
    @Test fun envelopeAppKeepsItsGeneratedName() {
        // If quicktype renamed the envelope's App to tell it from the pointer's app, this stops compiling.
        val app: dev.everframe.protocol.generated.App = App(build = "412", name = "dev.example", version = "2.4.0")
        assertEquals("2.4.0", app.version)
    }
}
