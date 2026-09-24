// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// PROTO-02 cross-SDK envelope-fixture parity test (Plan 05-08, Kotlin half).
//
// Reads `fixtures/canonical/minimal-envelope.json` (a canonical Everframe envelope
// shared with the TS and Swift SDKs), deserializes via the codegen-emitted
// `ReportEnvelope` (Plan 05-02 :everframe-protocol), re-serializes via Kotlin's
// kotlinx-serialization Json with deterministic settings, then asserts that a
// second round-trip produces byte-identical output. This is the "round-trip
// stability" gate — input may have arbitrary whitespace / key order, but once
// our SDK touches it the canonical bytes are stable.
//
// Cross-SDK byte-equality (Kotlin canonical-out == Swift canonical-out == TS
// canonical-out) is the orchestration-level union check that lives in Phase 7
// hardening. This test ships the Kotlin half.

package dev.everframe.parity

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.everframe.protocol.generated.ReportEnvelope
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class Proto02ParityTest {

    private val json = Json {
        // Deterministic canonical form — must mirror the iOS / TS canonical encoder.
        encodeDefaults = false       // omit fields that equal their default (mirrors Swift JSONEncoder OutputFormatting fragmentsAllowed)
        explicitNulls = false        // null-valued optional fields disappear from output
        prettyPrint = false          // compact form
        ignoreUnknownKeys = false    // strict — drift gate catches schema changes
    }

    @Test
    fun minimalEnvelopeRoundTripsByteStableThroughKotlinEnvelopeBuilder() {
        // 1. Load the canonical fixture from test assets.
        val ctx = InstrumentationRegistry.getInstrumentation().context
        val rawBytes = ctx.assets.open("fixtures/minimal-envelope.json").use { it.readBytes() }
        val rawText = rawBytes.toString(Charsets.UTF_8)

        // 2. Deserialize.
        val envelope = json.decodeFromString<ReportEnvelope>(rawText)

        // 3. Re-serialize → first canonical pass.
        val canonical1 = json.encodeToString(envelope)

        // 4. Decode the canonical output and re-encode → second canonical pass.
        val envelope2 = json.decodeFromString<ReportEnvelope>(canonical1)
        val canonical2 = json.encodeToString(envelope2)

        // 5. Round-trip stability assertion: canonical1 == canonical2 byte-for-byte.
        assertEquals(
            "PROTO-02 canonical round-trip is not stable (bytewise): the SDK is producing two different canonical forms from the same envelope.",
            canonical1,
            canonical2,
        )
    }

    @Test
    fun minimalEnvelopeCanonicalFormIsNonTriviallySmall() {
        // Sanity gate: catch a degenerate "{}" round-trip if a future ReportEnvelope
        // refactor accidentally drops most fields. Minimal-envelope.json has at least
        // protocolVersion, reportId, sdk, reporter, captures, context, payload, attachments —
        // canonical encoding should be well over 200 bytes.
        val ctx = InstrumentationRegistry.getInstrumentation().context
        val raw = ctx.assets.open("fixtures/minimal-envelope.json").use {
            it.readBytes().toString(Charsets.UTF_8)
        }
        val canonical = json.encodeToString(json.decodeFromString<ReportEnvelope>(raw))
        assert(canonical.length > 200) {
            "Canonical envelope encoding suspiciously small (${canonical.length} bytes); possible field drop."
        }
    }
}
