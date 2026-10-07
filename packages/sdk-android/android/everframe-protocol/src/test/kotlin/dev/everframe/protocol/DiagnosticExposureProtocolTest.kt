// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.protocol

import dev.everframe.protocol.generated.*
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class DiagnosticExposureProtocolTest {
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
